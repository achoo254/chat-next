//! `<config dir>/term-host/`: private directory, the single-instance lock,
//! and `control.json` (token and endpoint for the agent).

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const DIR_NAME: &str = "term-host";
pub const LOCK_FILE: &str = "lock";
pub const CONTROL_FILE: &str = "control.json";
#[cfg(unix)]
pub const SOCKET_FILE: &str = "control.sock";

/// Why the daemon could not take over a config dir.
#[derive(Debug)]
pub enum HomeError {
    /// Another daemon holds the lock of this config dir.
    AlreadyRunning,
    /// The directory belongs to another user or cannot be made private.
    NotPrivate(String),
    Io(io::Error),
}

impl From<io::Error> for HomeError {
    fn from(e: io::Error) -> Self {
        HomeError::Io(e)
    }
}

/// The locked state directory. Dropping it releases the lock.
pub struct Home {
    dir: PathBuf,
    _lock: File,
}

impl Home {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Write `control.json` atomically with mode 0600.
    pub fn write_control(&self, info: &Value) -> io::Result<()> {
        let tmp = self.dir.join(format!("{CONTROL_FILE}.tmp"));
        let mut opts = OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        // The token goes in only after the file is owner-only.
        #[cfg(windows)]
        crate::control::restrict_to_owner(&tmp, false)?;
        f.write_all(info.to_string().as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, self.dir.join(CONTROL_FILE))
    }

    /// Remove `control.json` (and the socket) on clean exit.
    pub fn remove_endpoint(&self) {
        let _ = fs::remove_file(self.dir.join(CONTROL_FILE));
        #[cfg(unix)]
        {
            let _ = fs::remove_file(self.dir.join(SOCKET_FILE));
        }
    }
}

/// Create (0700) and lock `<home>/term-host`.
pub fn take(home: &Path) -> Result<Home, HomeError> {
    let dir = home.join(DIR_NAME);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir)?;
    make_private(&dir)?;

    let mut opts = OpenOptions::new();
    opts.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let lock = opts.open(dir.join(LOCK_FILE))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Err(HomeError::AlreadyRunning),
        Err(TryLockError::Error(e)) => return Err(HomeError::Io(e)),
    }
    Ok(Home { dir, _lock: lock })
}

#[cfg(unix)]
fn make_private(dir: &Path) -> Result<(), HomeError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(HomeError::NotPrivate(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    if meta.uid() != nix::unistd::geteuid().as_raw() {
        return Err(HomeError::NotPrivate(format!(
            "{} belongs to another user",
            dir.display()
        )));
    }
    if meta.mode() & 0o777 != 0o700 {
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Windows: a protected DACL for the user alone, inherited by the files
/// created inside (the equivalent of 0700). The pipe carries its own
/// owner-only ACL.
// Windows only: compile-checked with x86_64-pc-windows-gnu, not run yet.
#[cfg(windows)]
fn make_private(dir: &Path) -> Result<(), HomeError> {
    crate::control::restrict_to_owner(dir, true)
        .map_err(|e| HomeError::NotPrivate(format!("{}: cannot set its ACL: {e}", dir.display())))
}

/// 32 random bytes as hex.
pub fn random_hex(bytes: usize) -> io::Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf)
        .map_err(|e| io::Error::other(format!("random source failed: {e}")))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_lock_on_same_dir_fails_and_is_released_on_drop() {
        let Ok(tmp) = tempfile::tempdir() else { return };
        let first = take(tmp.path());
        assert!(first.is_ok());
        assert!(matches!(take(tmp.path()), Err(HomeError::AlreadyRunning)));
        drop(first);
        assert!(take(tmp.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn dir_and_control_file_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let Ok(tmp) = tempfile::tempdir() else { return };
        let dir = tmp.path().join(DIR_NAME);
        let _ = fs::create_dir_all(&dir);
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o755));
        let Ok(home) = take(tmp.path()) else {
            panic!("take failed");
        };
        let mode = |p: &Path| fs::metadata(p).map(|m| m.permissions().mode() & 0o777).ok();
        assert_eq!(mode(&dir), Some(0o700));
        assert!(home
            .write_control(&serde_json::json!({"token": "x"}))
            .is_ok());
        assert_eq!(mode(&dir.join(CONTROL_FILE)), Some(0o600));
        home.remove_endpoint();
        assert!(!dir.join(CONTROL_FILE).exists());
    }

    #[test]
    fn random_tokens_differ() {
        let a = random_hex(32).unwrap_or_default();
        let b = random_hex(32).unwrap_or_default();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
