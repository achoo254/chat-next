//! History rows on request (docs/terminal-wire.md section 4, "Lịch sử theo
//! yêu cầu"): a client that started from a `LiveSnapshot` asks for the rows
//! before it page by page. The newest rows come straight from the live
//! emulator's scrollback; older ones are rebuilt from the session's output
//! log on a worker thread, by the same [`Feeder`] the live screen uses, so the
//! numbering is the same. Nothing is kept for good: a rebuild leaves a window
//! of rows in a cache that expires when nobody reads it.

use std::collections::{BTreeMap, VecDeque};
use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::screen::{EpochPin, Feeder, PIECE_ROWS_MARGIN};
use crate::wire::{ServerFrame, MAX_HISTORY_VT};

/// Rows a rebuild keeps before the row asked for, so the pages that follow
/// (older rows) come from the cache.
pub const REBUILD_ROWS: u64 = 2000;
/// Most bytes of formatted rows one rebuild keeps.
const REBUILD_BYTES: usize = 8 * 1024 * 1024;
/// Rebuilds running at once on the whole machine.
pub const MAX_RUNNING: usize = 2;
/// Rebuilds waiting for a free slot; more are refused as busy.
pub const MAX_QUEUED: usize = 8;
/// Bytes of cached rows of all sessions together.
pub const CACHE_BYTES: usize = 32 * 1024 * 1024;
/// A cache nobody read for this long is dropped.
pub const CACHE_TTL: Duration = Duration::from_secs(60);
/// Log read size of a rebuild.
const READ_CHUNK: usize = 64 * 1024;
/// Requests per second per connection, and the burst allowed.
const RATE_PER_SEC: f64 = 10.0;
const RATE_BURST: f64 = 20.0;

/// What a rebuild replays and which rows it keeps.
#[derive(Debug, Clone)]
pub struct RebuildSpec {
    pub path: PathBuf,
    pub pin: EpochPin,
    /// Keep rows `[from, to)`.
    pub from: u64,
    pub to: u64,
}

#[derive(Debug)]
pub enum Built {
    /// Rows from `first` on, consecutive, oldest first (the oldest may be
    /// later than asked when the byte cap was reached).
    Rows {
        first: u64,
        rows: Vec<Vec<u8>>,
    },
    Failed(String),
    Cancelled,
}

/// Replay the pinned epoch from the log and keep the rows asked for.
pub fn rebuild(spec: &RebuildSpec, cancel: &AtomicBool) -> Built {
    match rebuild_rows(spec, cancel) {
        Ok(Some((first, rows))) => Built::Rows { first, rows },
        Ok(None) => Built::Cancelled,
        Err(e) => Built::Failed(e.to_string()),
    }
}

fn rebuild_rows(
    spec: &RebuildSpec,
    cancel: &AtomicBool,
) -> io::Result<Option<(u64, Vec<Vec<u8>>)>> {
    let pin = &spec.pin;
    // Enough scrollback that no piece saturates the row count (see PIECE).
    let tallest = pin
        .resizes
        .iter()
        .map(|r| r.rows)
        .chain([pin.start.rows])
        .max()
        .unwrap_or(pin.start.rows);
    let keep = usize::from(tallest) + PIECE_ROWS_MARGIN;
    let mut feeder = Feeder::new(&pin.start, keep, String::new());
    let file = File::open(&spec.path)?;
    let mut kept: VecDeque<Vec<u8>> = VecDeque::new();
    let mut kept_first = spec.from;
    let mut kept_bytes = 0usize;
    let mut buf = vec![0u8; READ_CHUNK];
    let mut resizes = pin.resizes.iter().peekable();
    let mut pos = pin.start.offset;
    while pos < pin.fed && feeder.lines() < spec.to {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        while let Some(r) = resizes.next_if(|r| r.offset <= pos) {
            feeder.resize(r.rows, r.cols);
        }
        let stop = resizes.peek().map_or(pin.fed, |r| r.offset.min(pin.fed));
        let n = usize::try_from(stop - pos).map_or(READ_CHUNK, |left| left.min(READ_CHUNK));
        read_exact_at(&file, &mut buf[..n], pos)?;
        let (from, to) = (spec.from, spec.to);
        feeder.feed(&buf[..n], &mut |f, first, count| {
            let lo = first.max(from);
            let hi = (first + count).min(to);
            if lo >= hi {
                return;
            }
            let Some(rows) = f.history_rows(lo, hi) else {
                return;
            };
            if kept.is_empty() {
                kept_first = lo;
            }
            for row in rows {
                kept_bytes += row.len();
                kept.push_back(row);
            }
            while kept_bytes > REBUILD_BYTES {
                let Some(old) = kept.pop_front() else { break };
                kept_bytes -= old.len();
                kept_first += 1;
            }
        });
        if feeder.take_started().is_some() {
            return Err(io::Error::other("the log does not match the pinned epoch"));
        }
        pos += n as u64;
    }
    if !feeder.exact() {
        return Err(io::Error::other("the rebuilt numbering is not exact"));
    }
    if feeder.lines() < spec.to {
        return Err(io::Error::other(format!(
            "the log numbered {} rows, {} expected",
            feeder.lines(),
            spec.to
        )));
    }
    Ok(Some((kept_first, kept.into())))
}

#[cfg(unix)]
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    file.read_exact_at(buf, offset)
}

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

/// A rebuild waiting for or holding a slot.
pub struct Job {
    pub token: u64,
    pub session: u32,
    pub spec: RebuildSpec,
    pub cancel: Arc<AtomicBool>,
}

/// The rebuild a connection waits for (at most one page in flight each).
pub struct InFlight {
    pub token: u64,
    pub session: u32,
    pub req_id: u16,
    pub epoch: u32,
    pub before: u64,
    pub max_rows: u16,
    pub cancel: Arc<AtomicBool>,
}

/// A page ready to go out, part by part, behind the connection's output.
pub struct Page {
    pub session: u32,
    pub req_id: u16,
    pub epoch: u32,
    pub first_row: u64,
    pub row_count: u16,
    pub at_start: bool,
    pub parts: Vec<Vec<u8>>,
    /// Next part to send.
    pub next: usize,
}

impl Page {
    /// Rows `first_row..` (each followed by SGR reset and CR LF) split on
    /// row boundaries into parts that fit a frame. Rows that would need more
    /// than 255 parts are dropped from the oldest end.
    pub fn new(session: u32, req_id: u16, epoch: u32, first_row: u64, rows: &[Vec<u8>]) -> Page {
        let lines: Vec<Vec<u8>> = rows
            .iter()
            .map(|row| {
                let mut line = row.clone();
                line.truncate(MAX_HISTORY_VT - 5);
                line.extend_from_slice(b"\x1b[m\r\n");
                line
            })
            .collect();
        let mut skip = 0;
        loop {
            let parts = pack(&lines[skip..]);
            if parts.len() <= usize::from(u8::MAX) {
                let first_row = first_row + skip as u64;
                return Page {
                    session,
                    req_id,
                    epoch,
                    first_row,
                    row_count: (lines.len() - skip) as u16,
                    at_start: first_row == 0,
                    parts,
                    next: 0,
                };
            }
            skip += (lines.len() - skip) / 8 + 1;
        }
    }

    /// The epoch changed or nothing is older: no rows, at the start.
    pub fn empty(session: u32, req_id: u16, epoch: u32) -> Page {
        Page {
            session,
            req_id,
            epoch,
            first_row: 0,
            row_count: 0,
            at_start: true,
            parts: vec![Vec::new()],
            next: 0,
        }
    }

    pub fn frame(&self, part: usize) -> ServerFrame<'_> {
        ServerFrame::History {
            session: self.session,
            req_id: self.req_id,
            epoch: self.epoch,
            first_row: self.first_row,
            row_count: self.row_count,
            part: part as u8,
            parts: self.parts.len() as u8,
            at_start: self.at_start,
            vt: &self.parts[part],
        }
    }
}

/// Lines packed greedily into parts of at most `MAX_HISTORY_VT` bytes.
fn pack(lines: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut parts = Vec::new();
    let mut current: Vec<u8> = Vec::new();
    for line in lines {
        if !current.is_empty() && current.len() + line.len() > MAX_HISTORY_VT {
            parts.push(std::mem::take(&mut current));
        }
        current.extend_from_slice(line);
    }
    parts.push(current);
    parts
}

/// Requests of one connection: a token bucket.
pub struct Rate {
    tokens: f64,
    at: Instant,
}

impl Rate {
    pub fn new(now: Instant) -> Rate {
        Rate {
            tokens: RATE_BURST,
            at: now,
        }
    }

    pub fn try_take(&mut self, now: Instant) -> bool {
        let dt = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        self.tokens = (self.tokens + dt * RATE_PER_SEC).min(RATE_BURST);
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

/// Rows a rebuild left for one session's epoch.
struct Cached {
    epoch: u32,
    first: u64,
    rows: Vec<Vec<u8>>,
    bytes: usize,
    used: Instant,
}

/// Rebuild slots, the queue and the caches of the whole daemon.
#[derive(Default)]
pub struct Rebuilds {
    pub running: usize,
    pub queue: VecDeque<Job>,
    next_token: u64,
    caches: BTreeMap<u32, Cached>,
}

impl Rebuilds {
    pub fn token(&mut self) -> u64 {
        self.next_token += 1;
        self.next_token
    }

    /// Rows `[from, to)` of `session`'s `epoch` if the cache has them all.
    pub fn cached(
        &mut self,
        session: u32,
        epoch: u32,
        from: u64,
        to: u64,
        now: Instant,
    ) -> Option<Vec<Vec<u8>>> {
        let c = self.caches.get_mut(&session)?;
        if c.epoch != epoch || from < c.first || to > c.first + c.rows.len() as u64 {
            return None;
        }
        c.used = now;
        let lo = (from - c.first) as usize;
        let hi = (to - c.first) as usize;
        Some(c.rows[lo..hi].to_vec())
    }

    pub fn store(
        &mut self,
        session: u32,
        epoch: u32,
        first: u64,
        rows: Vec<Vec<u8>>,
        now: Instant,
    ) {
        let bytes = rows.iter().map(Vec::len).sum();
        self.caches.insert(
            session,
            Cached {
                epoch,
                first,
                rows,
                bytes,
                used: now,
            },
        );
        // Over the machine-wide cap: drop the least recently read others.
        while self.cache_bytes() > CACHE_BYTES {
            let oldest = self
                .caches
                .iter()
                .filter(|(&s, _)| s != session)
                .min_by_key(|(_, c)| c.used)
                .map(|(&s, _)| s);
            match oldest {
                Some(s) => {
                    self.caches.remove(&s);
                }
                None => break,
            }
        }
    }

    pub fn cache_bytes(&self) -> usize {
        self.caches.values().map(|c| c.bytes).sum()
    }

    pub fn forget(&mut self, session: u32) {
        self.caches.remove(&session);
        for job in self.queue.iter().filter(|j| j.session == session) {
            job.cancel.store(true, Ordering::Relaxed);
        }
    }

    pub fn expire(&mut self, now: Instant) {
        self.caches
            .retain(|_, c| now.saturating_duration_since(c.used) < CACHE_TTL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screen::{Screen, SCROLLBACK_ROWS};
    use crate::wire::MAX_DIM;

    /// Deterministic chunk sizes from 1 to 700 bytes.
    fn chunks(data: &[u8], mut seed: u64) -> Vec<&[u8]> {
        let mut out = Vec::new();
        let mut at = 0;
        while at < data.len() {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let n = (seed % 700 + 1) as usize;
            let end = (at + n).min(data.len());
            out.push(&data[at..end]);
            at = end;
        }
        out
    }

    /// Output with everything that moves rows: line floods, autowrap, wide
    /// characters, a scroll region (no history), the alternate screen entered
    /// and left in the middle of reads, CSI S, an OSC longer than the held
    /// limit, and colours.
    fn busy_stream(tag: &str) -> Vec<u8> {
        let mut s = Vec::new();
        for i in 0..300 {
            s.extend_from_slice(
                format!("\x1b[3{}m{tag} line {i} 漢字\x1b[m\r\n", i % 8).as_bytes(),
            );
        }
        s.extend_from_slice(&"w".repeat(1000).into_bytes());
        s.extend_from_slice(b"\r\n");
        // A scroll region scrolls nothing into the history.
        s.extend_from_slice(b"\x1b[2;5r\x1b[5;1H");
        for i in 0..50 {
            s.extend_from_slice(format!("{tag} region {i}\n").as_bytes());
        }
        s.extend_from_slice(b"\x1b[r\x1b[24;1H");
        s.extend_from_slice(b"\x1b[?1049h\x1b[2J");
        for i in 0..80 {
            s.extend_from_slice(format!("{tag} alt {i}\r\n").as_bytes());
        }
        s.extend_from_slice(b"\x1b[?1049l");
        s.extend_from_slice(b"\x1b[7S");
        s.extend_from_slice(b"\x1b]2;");
        s.extend_from_slice(&vec![b't'; 5000]);
        s.push(0x07);
        for i in 0..400 {
            s.extend_from_slice(format!("{tag} tail {i}\r\n").as_bytes());
        }
        s.extend_from_slice(b"\x1b[200S");
        for i in 0..1000u32 {
            s.extend_from_slice(format!("{i}\n").as_bytes());
        }
        s
    }

    /// The live screen fed in `seed`-sized reads, resized at some of them.
    fn live(stream: &[u8], seed: u64, resize: bool) -> Screen {
        let mut screen = Screen::new(24, 80);
        for (i, c) in chunks(stream, seed).into_iter().enumerate() {
            screen.process(c);
            if resize && i % 37 == 5 {
                let (rows, cols) = if i % 2 == 0 { (30, 100) } else { (20, 60) };
                screen.resize(rows, cols);
            }
        }
        screen
    }

    /// Every history row of an emulator that keeps them all, fed with the
    /// pinned resizes at their offsets.
    fn truth(stream: &[u8], pin: &EpochPin) -> Vec<Vec<u8>> {
        let mut p = vt100::Parser::new(pin.start.rows, pin.start.cols, 10_000_000);
        p.process(&pin.start.state);
        let mut pos = pin.start.offset as usize;
        for r in &pin.resizes {
            p.process(&stream[pos..r.offset as usize]);
            pos = r.offset as usize;
            p.screen_mut().set_size(r.rows, r.cols);
        }
        p.process(&stream[pos..pin.fed as usize]);
        let s = p.screen_mut();
        s.set_scrollback(usize::MAX);
        let total = s.scrollback();
        (1..=total)
            .rev()
            .map(|back| {
                s.set_scrollback(back);
                s.rows_formatted(0, MAX_DIM).next().unwrap_or_default()
            })
            .collect()
    }

    fn rebuilt(stream: &[u8], pin: &EpochPin, from: u64, to: u64) -> Vec<Vec<u8>> {
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir")
        };
        let path = tmp.path().join("log");
        assert!(std::fs::write(&path, stream).is_ok());
        let spec = RebuildSpec {
            path,
            pin: pin.clone(),
            from,
            to,
        };
        match rebuild(&spec, &AtomicBool::new(false)) {
            Built::Rows { first, rows } => {
                assert_eq!(first, from);
                rows
            }
            other => panic!("rebuild: {other:?}"),
        }
    }

    #[test]
    fn live_numbering_matches_an_emulator_that_keeps_every_row() {
        let stream = busy_stream("a");
        for seed in [1, 7, 99, 12345] {
            for resize in [false, true] {
                let mut screen = live(&stream, seed, resize);
                let Some(pin) = screen.pin() else {
                    panic!("epoch not pinnable")
                };
                let want = truth(&stream, &pin);
                assert_eq!(
                    screen.lines(),
                    want.len() as u64,
                    "seed {seed} resize {resize}"
                );
                let lines = screen.lines();
                let held = screen.oldest_held();
                assert_eq!(lines - held, SCROLLBACK_ROWS as u64);
                let Some(rows) = screen.history_rows(held, lines) else {
                    panic!("live rows")
                };
                assert!(
                    rows == want[held as usize..],
                    "live rows differ, seed {seed}"
                );
            }
        }
    }

    #[test]
    fn rebuild_from_the_log_numbers_rows_like_the_live_screen() {
        let stream = busy_stream("b");
        for seed in [3, 42] {
            let screen = live(&stream, seed, true);
            let Some(pin) = screen.pin() else {
                panic!("epoch not pinnable")
            };
            assert!(!pin.resizes.is_empty());
            let want = truth(&stream, &pin);
            let all = rebuilt(&stream, &pin, 0, pin.lines);
            assert!(all == want, "rebuild differs, seed {seed}");
            // A window in the middle, as a page asks for it.
            let part = rebuilt(&stream, &pin, 100, 350);
            assert!(part == want[100..350]);
        }
    }

    #[test]
    fn resize_inside_a_split_sequence_applies_at_the_fed_offset() {
        let mut stream = Vec::new();
        for i in 0..60 {
            stream.extend_from_slice(
                format!("\x1b[32mrow {i} {}\x1b[m\r\n", "z".repeat(70)).as_bytes(),
            );
        }
        let cut = stream.len();
        stream.extend_from_slice(b"\x1b[3");
        let mut screen = Screen::new(24, 80);
        screen.process(&stream);
        // The read ended inside CSI: the emulator is fed up to before it.
        assert_eq!(screen.fed_offset(), cut as u64);
        screen.resize(10, 40);
        let mut rest = b"1mafter\x1b[m\r\n".to_vec();
        for i in 0..40 {
            rest.extend_from_slice(format!("more {i} {}\r\n", "y".repeat(50)).as_bytes());
        }
        screen.process(&rest);
        stream.extend_from_slice(&rest);
        let Some(pin) = screen.pin() else {
            panic!("pin")
        };
        assert_eq!(pin.resizes[0].offset, cut as u64);
        let want = truth(&stream, &pin);
        assert_eq!(screen.lines(), want.len() as u64);
        assert!(rebuilt(&stream, &pin, 0, pin.lines) == want);
    }

    #[test]
    fn every_spelling_of_ed3_and_ris_starts_an_epoch_whose_rows_never_hold_older_ones() {
        let mut stream = Vec::new();
        let mut epochs = 0;
        for (n, erase) in [
            &b"\x1b[3J"[..],
            b"\x1b[03J",
            b"\x1b[3;J",
            b"\x1b[?3J",
            b"\x1b[3;5J",
            b"\x1bc",
        ]
        .iter()
        .enumerate()
        {
            for i in 0..100 {
                stream.extend_from_slice(format!("old{n} {i}\r\n").as_bytes());
            }
            stream.extend_from_slice(b"\x1b[2J");
            stream.extend_from_slice(erase);
            epochs += 1;
        }
        // On the alternate screen ED 3 starts nothing; with no rows yet neither.
        stream.extend_from_slice(b"\x1b[3J\x1b[?1049h\x1b[3J\x1b[?1049l");
        for i in 0..80 {
            stream.extend_from_slice(format!("new {i}\r\n").as_bytes());
        }
        for seed in [5, 77, 2024] {
            let mut screen = live(&stream, seed, false);
            assert_eq!(screen.epoch(), epochs, "seed {seed}");
            let Some(pin) = screen.pin() else {
                panic!("pin")
            };
            let rows = rebuilt(&stream, &pin, 0, pin.lines);
            let text: Vec<String> = rows
                .iter()
                .map(|r| String::from_utf8_lossy(r).into_owned())
                .collect();
            assert!(text.iter().all(|t| !t.contains("old")), "seed {seed}");
            assert!(text.first().is_some_and(|t| t.contains("new 0")));
            let held = screen.oldest_held();
            let lines = screen.lines();
            assert!(screen.history_rows(held, lines) == Some(rows[held as usize..].to_vec()));
        }
        // ED 3 cut between two reads is still seen.
        let mut screen = Screen::new(5, 20);
        screen.process(b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng\r\n\x1b[");
        screen.process(b"3J");
        assert_eq!((screen.epoch(), screen.lines()), (1, 0));
    }

    #[test]
    fn a_sequence_right_after_an_unterminated_string_is_seen_like_the_emulator_sees_it() {
        // ESC inside OSC/DCS ends the string: RIS, ED 3 and a screen switch
        // right after one still start an epoch or isolate the switch.
        for erase in [&b"\x1bc"[..], b"\x1b[3J"] {
            let mut stream = Vec::new();
            for i in 0..120 {
                stream.extend_from_slice(format!("SECRET{i:02}\r\n").as_bytes());
            }
            // Clear the screen first, as a full redraw does: ED 3 only erases the history.
            stream.extend_from_slice(b"\x1b[2J\x1b[H");
            stream.extend_from_slice(b"\x1b]0;unterminated title");
            stream.extend_from_slice(erase);
            stream.extend_from_slice(b"\x1b]2;t");
            stream.extend_from_slice(b"\x1b[?1049h");
            for i in 0..30 {
                stream.extend_from_slice(format!("alt {i}\r\n").as_bytes());
            }
            stream.extend_from_slice(b"\x1bP1;2q\x1b[?1049l");
            for i in 0..900 {
                stream.extend_from_slice(format!("after {i}\r\n").as_bytes());
            }
            for seed in [1, 13, 404] {
                let mut screen = live(&stream, seed, false);
                assert_eq!(screen.epoch(), 1, "seed {seed}");
                let Some(pin) = screen.pin() else {
                    panic!("pin")
                };
                let want = truth(&stream, &pin);
                assert_eq!(screen.lines(), want.len() as u64, "seed {seed}");
                let rows = rebuilt(&stream, &pin, 0, pin.lines);
                assert!(rows == want, "seed {seed}");
                let text = rows.iter().map(|r| String::from_utf8_lossy(r).into_owned());
                assert!(text.clone().all(|t| !t.contains("SECRET")), "seed {seed}");
                let held = screen.oldest_held();
                let lines = screen.lines();
                assert!(screen.history_rows(held, lines) == Some(rows[held as usize..].to_vec()));
            }
        }
    }

    #[test]
    fn pages_split_on_rows_and_fit_frames() {
        let rows: Vec<Vec<u8>> = (0..500)
            .map(|i| format!("{i:03} {}", "q".repeat(400)).into_bytes())
            .collect();
        let page = Page::new(1, 2, 3, 1000, &rows);
        assert_eq!((page.first_row, page.row_count), (1000, 500));
        assert!(page.parts.len() > 1);
        let mut all = Vec::new();
        for (i, part) in page.parts.iter().enumerate() {
            assert!(part.len() <= MAX_HISTORY_VT);
            assert!(part.ends_with(b"\r\n"));
            let f = page.frame(i);
            assert!(crate::wire::server_frame_len(&f) <= crate::wire::MAX_FRAME);
            all.extend_from_slice(part);
        }
        assert_eq!(all.windows(2).filter(|w| w == b"\r\n").count(), 500);
        assert!(!Page::new(1, 2, 3, 0, &rows[..1]).parts.is_empty());
        assert!(Page::new(1, 2, 3, 0, &rows[..1]).at_start);
    }

    #[test]
    fn cache_is_capped_machine_wide_and_expires() {
        let mut r = Rebuilds::default();
        let now = Instant::now();
        let big = vec![vec![0u8; 1024 * 1024]; 20];
        r.store(1, 0, 0, big.clone(), now);
        r.store(2, 0, 0, big.clone(), now + Duration::from_secs(1));
        assert!(r.cache_bytes() <= CACHE_BYTES);
        assert!(r.cached(2, 0, 0, 20, now).is_some());
        assert!(r.cached(1, 0, 0, 20, now).is_none());
        assert!(r.cached(2, 1, 0, 20, now).is_none(), "another epoch");
        r.expire(now + CACHE_TTL + Duration::from_secs(5));
        assert_eq!(r.cache_bytes(), 0);
    }

    #[test]
    fn cancelled_rebuild_stops() {
        let stream = busy_stream("c");
        let screen = live(&stream, 9, false);
        let Some(pin) = screen.pin() else {
            panic!("pin")
        };
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir")
        };
        let path = tmp.path().join("log");
        assert!(std::fs::write(&path, &stream).is_ok());
        let spec = RebuildSpec {
            path,
            to: pin.lines,
            pin,
            from: 0,
        };
        assert!(matches!(
            rebuild(&spec, &AtomicBool::new(true)),
            Built::Cancelled
        ));
    }

    /// Cost of the first rebuilt page of a long session, as the plan
    /// budgets it (first page within a second for a 50 MB log). Run with
    /// `cargo test --release --lib history::tests::rebuild_cost -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn rebuild_cost() {
        let mut stream = Vec::with_capacity(52 * 1024 * 1024);
        let mut i = 0u64;
        while stream.len() < 50 * 1024 * 1024 {
            stream.extend_from_slice(
                format!("\x1b[3{}mrow {i} {}\x1b[m\r\n", i % 8, "x".repeat(60)).as_bytes(),
            );
            if i % 20_000 == 19_999 {
                // A full redraw now and then, without erasing the history.
                stream.extend_from_slice(b"\x1b[2J\x1b[H");
            }
            i += 1;
        }
        let mut screen = Screen::new(40, 120);
        let t = Instant::now();
        for c in stream.chunks(64 * 1024) {
            screen.process(c);
        }
        let live = t.elapsed();
        let Some(pin) = screen.pin() else {
            panic!("pin")
        };
        let Ok(tmp) = tempfile::tempdir() else {
            panic!("tempdir")
        };
        let path = tmp.path().join("log");
        assert!(std::fs::write(&path, &stream).is_ok());
        // The first page older than the live scrollback, with the cache window.
        let before = pin.lines - SCROLLBACK_ROWS as u64;
        let spec = RebuildSpec {
            path,
            from: before - REBUILD_ROWS,
            to: before,
            pin,
        };
        let t = Instant::now();
        let Built::Rows { rows, .. } = rebuild(&spec, &AtomicBool::new(false)) else {
            panic!("rebuild")
        };
        let took = t.elapsed();
        let bytes: usize = rows.iter().map(Vec::len).sum();
        println!(
            "log {} MB, {} rows; live feed {:?}; rebuild {:?}; kept {} rows, {} KB",
            stream.len() / (1024 * 1024),
            spec.pin.lines,
            live,
            took,
            rows.len(),
            bytes / 1024
        );
    }
}
