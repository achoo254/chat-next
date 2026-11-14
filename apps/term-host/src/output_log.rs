//! Append-only copy on disk of every raw output byte of a session, from
//! offset 0, so any client can be replayed the exact stream the program wrote
//! (section 4). The in-memory ring stays the fast tail; this log serves the
//! bytes that already left it.
//!
//! The log is never truncated while its session lives. It is removed when the
//! session is dropped (closed, reaped, daemon shutdown), and the whole log
//! directory is wiped at daemon start, which only ever finds logs a crashed
//! daemon left behind (the start holds the config dir lock).
//!
//! Terminal output may carry secrets: the directory lives inside the private
//! state dir (`<home>/term-host`, 0700 / owner-only DACL), is itself 0700 on
//! Unix, and each log is 0600 there; on Windows the files inherit the state
//! dir's owner-only DACL.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

/// Name of the log directory inside the daemon state dir.
pub const DIR_NAME: &str = "output";
/// Write buffer: PTY reads are small and frequent, so batch them.
const WRITE_BUFFER: usize = 64 * 1024;

/// Create `<state_dir>/output` empty and private. Anything already there is a
/// leftover of a daemon that did not exit cleanly, and is deleted.
pub fn prepare_dir(state_dir: &Path) -> io::Result<PathBuf> {
    let dir = state_dir.join(DIR_NAME);
    match fs::remove_dir_all(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut b = builder;
        b.mode(0o700);
        b
    };
    builder.create(&dir)?;
    Ok(dir)
}

/// The output log of one session. Dropping it deletes the file.
pub struct OutputLog {
    path: PathBuf,
    /// One handle per session (a daemon holds up to 20 sessions within the
    /// process's descriptor limit): opened for append, so every write lands
    /// at the end whatever position a read left, and read positionally.
    /// None only while dropping.
    file: Option<BufWriter<File>>,
    /// Bytes appended so far, the stream offset one past the newest byte.
    len: u64,
}

impl OutputLog {
    /// Create the log of `session` in `dir` (from [`prepare_dir`]).
    pub fn create(dir: &Path, session: u32) -> io::Result<OutputLog> {
        let path = dir.join(format!("session-{session}.log"));
        let mut opts = OpenOptions::new();
        // create_new: never append to (or follow a link planted at) an
        // existing name; the directory is fresh for this daemon.
        opts.read(true).append(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(&path)?;
        Ok(OutputLog {
            path,
            file: Some(BufWriter::with_capacity(WRITE_BUFFER, file)),
            len: 0,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Stream offset one past the newest byte appended.
    pub fn len(&self) -> u64 {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Append the next bytes of the stream. After an error the log no longer
    /// matches the stream and must be dropped by the caller.
    pub fn append(&mut self, data: &[u8]) -> io::Result<()> {
        let file = self.file.as_mut().ok_or_else(closed)?;
        file.write_all(data)?;
        self.len += data.len() as u64;
        Ok(())
    }

    /// Append to `out` the bytes from `from` on, at most `max`; returns how
    /// many (0 when `from` is at or past the end). Buffered bytes are written
    /// out first so the read sees all of them. After an error the log must
    /// be dropped by the caller.
    pub fn read_into(&mut self, from: u64, max: usize, out: &mut Vec<u8>) -> io::Result<usize> {
        if from >= self.len {
            return Ok(0);
        }
        let n = usize::try_from(self.len - from).map_or(max, |left| left.min(max));
        let file = self.file.as_mut().ok_or_else(closed)?;
        file.flush()?;
        let at = out.len();
        out.resize(at + n, 0);
        if let Err(e) = read_exact_at(file.get_ref(), &mut out[at..], from) {
            // Shorter than what was written: the file was changed behind us.
            out.truncate(at);
            return Err(e);
        }
        Ok(n)
    }
}

#[cfg(unix)]
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buf, offset)
}

/// `seek_read` moves the file pointer, which is harmless here: the handle is
/// append-only for writing, so writes still go to the end.
#[cfg(windows)]
fn read_exact_at(file: &File, mut buf: &mut [u8], mut offset: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        match file.seek_read(buf, offset) {
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => {
                buf = &mut buf[n..];
                offset += n as u64;
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

fn closed() -> io::Error {
    io::Error::other("output log closed")
}

impl Drop for OutputLog {
    fn drop(&mut self) {
        // Close the handle before deleting so the name goes at once on every
        // OS. Unflushed bytes are discarded: nobody can read them now.
        if let Some(file) = self.file.take() {
            let (_file, _unflushed) = file.into_parts();
        }
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(log: &mut OutputLog, from: u64, max: usize) -> Vec<u8> {
        let mut v = Vec::new();
        assert!(log.read_into(from, max, &mut v).is_ok());
        v
    }

    #[test]
    fn reads_back_every_byte_by_offset_including_unflushed_ones() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir failed")
        };
        let Ok(mut log) = OutputLog::create(&dir, 1) else {
            panic!("create failed")
        };
        let mut all = Vec::new();
        for i in 0..3000u32 {
            let chunk: Vec<u8> = (0..(i % 97 + 1)).map(|j| (i * 31 + j) as u8).collect();
            assert!(log.append(&chunk).is_ok());
            all.extend_from_slice(&chunk);
        }
        // ED3 and every other byte stay as written.
        assert!(log.append(b"\x1b[2J\x1b[3J\x1b[H").is_ok());
        all.extend_from_slice(b"\x1b[2J\x1b[3J\x1b[H");
        assert_eq!(log.len(), all.len() as u64);
        let mut got = Vec::new();
        let mut at = 0u64;
        while at < log.len() {
            let n = log.read_into(at, 4093, &mut got).unwrap_or(0);
            assert!(n > 0);
            at += n as u64;
        }
        assert_eq!(got, all);
        assert_eq!(read(&mut log, 10, 5), &all[10..15]);
        let len = log.len();
        assert_eq!(read(&mut log, len, 5), b"");
        assert_eq!(read(&mut log, len + 7, 5), b"");
    }

    #[test]
    fn drop_deletes_the_file_and_prepare_dir_wipes_leftovers() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir failed")
        };
        let Ok(mut log) = OutputLog::create(&dir, 3) else {
            panic!("create failed")
        };
        assert!(log.append(b"secret").is_ok());
        let path = log.path().to_path_buf();
        assert!(path.exists());
        drop(log);
        assert!(!path.exists());

        let _ = fs::write(dir.join("session-9.log"), b"stale");
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir failed")
        };
        assert_eq!(fs::read_dir(&dir).map(|d| d.count()).ok(), Some(0));
    }

    #[test]
    fn write_failure_is_an_error_not_a_panic() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir failed")
        };
        let Ok(mut log) = OutputLog::create(&dir, 4) else {
            panic!("create failed")
        };
        // Swap in a read-only handle: every write to it fails.
        let Ok(read_only) = File::open(log.path()) else {
            panic!("open failed")
        };
        if let Some(old) = log
            .file
            .replace(BufWriter::with_capacity(WRITE_BUFFER, read_only))
        {
            let _ = old.into_parts();
        }
        let big = vec![b'x'; WRITE_BUFFER * 2];
        assert!(log.append(&big).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn dir_and_log_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let Ok(tmp) = tempfile::tempdir() else { return };
        let Ok(dir) = prepare_dir(tmp.path()) else {
            panic!("prepare_dir failed")
        };
        let Ok(log) = OutputLog::create(&dir, 5) else {
            panic!("create failed")
        };
        let mode = |p: &Path| fs::metadata(p).map(|m| m.permissions().mode() & 0o777).ok();
        assert_eq!(mode(&dir), Some(0o700));
        assert_eq!(mode(log.path()), Some(0o600));
    }
}
