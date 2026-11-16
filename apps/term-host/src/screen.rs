//! Headless emulator that keeps the screen of a session: the window title for
//! `list`, the `LiveSnapshot` a client with `CAP_LIVE_HISTORY` starts from on
//! the normal screen, and the rendered `Snapshot` of the fallback used when
//! the session's output log failed (older clients normally get the raw stream
//! replayed from offset 0, never a rendering).
//!
//! History rows are numbered: every row that scrolls off the top of the
//! normal screen gets the next number of its *epoch*. An epoch ends where the
//! program erases the history (ED 3 on the normal screen, or RIS) while it
//! holds rows; numbering restarts at 0 in the next one. The same [`Feeder`]
//! drives the live emulator and a rebuild from the output log
//! (`history.rs`), so both number every row the same way whatever the read
//! sizes were.
//!
//! The emulator is only fed up to a *safe boundary*: a byte offset where the
//! stream is not inside an escape sequence or a UTF-8 character. A snapshot is
//! taken at that boundary and the bytes after it are replayed as `Output`, so
//! a sequence split across PTY reads is never cut in half (no gap, no overlap).

use crate::wire::{MAX_DIM, MAX_LIVE_SNAPSHOT_VT, MAX_SNAPSHOT_VT, MIN_DIM};

/// Longest tail held back waiting for a sequence to end. A stream that never
/// terminates a string sequence is fed anyway once this much is pending.
const MAX_HELD: usize = 4096;
/// Longest window title kept for `list`.
const MAX_TITLE: usize = 256;
/// Rows of the normal screen kept after they scroll off its top, so a client
/// that attaches later can scroll back to them (as many as fit a frame: a few
/// hundred rows with colours, so keeping more would only cost memory, about
/// 32 bytes per cell: 3.2 MB for a session 200 columns wide).
pub const SCROLLBACK_ROWS: usize = 500;
/// Longest piece fed to the emulator at once. Counting the rows a piece
/// scrolls off reads vt100's scrollback position, which saturates at the
/// scrollback length: a piece of this many bytes scrolls at most one row per
/// byte, plus one `CSI S` (pieces are cut after each), so the count stays
/// exact while that sum is below the length (always for a rebuild, which
/// keeps more rows; on the live screen unless one `CSI S` scrolls more than
/// about 250 rows of a screen that tall, which marks the epoch unreliable).
const PIECE: usize = 240;
/// Scrollback beyond the screen height that keeps a piece's row count exact
/// (one row per byte of a piece, plus the margin of the position read).
pub const PIECE_ROWS_MARGIN: usize = PIECE + 8;
/// Most resizes remembered for one epoch (a rebuild applies them at the same
/// offsets). Beyond this the epoch's history is only what the live
/// scrollback holds.
const MAX_RESIZES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Ground,
    /// After ESC.
    Escape,
    /// ESC followed by intermediates (ESC ( B and friends).
    EscapeIntermediate,
    /// Inside CSI parameters.
    Csi,
    /// Inside OSC / DCS / SOS / PM / APC strings.
    Str,
    /// Inside a string, just saw ESC (maybe ST).
    StrEscape,
    /// Inside a UTF-8 character, continuation bytes still expected.
    Utf8(u8),
}

/// Tracks whether the stream sits on a boundary where a snapshot can be cut.
#[derive(Debug, Clone)]
pub struct BoundaryScanner {
    state: ScanState,
}

impl Default for BoundaryScanner {
    fn default() -> Self {
        BoundaryScanner {
            state: ScanState::Ground,
        }
    }
}

impl BoundaryScanner {
    /// Feed `data`; returns the length of the longest prefix that ends on a
    /// safe boundary (0 if none inside this chunk).
    pub fn scan(&mut self, data: &[u8]) -> usize {
        let mut safe = 0;
        for (i, &b) in data.iter().enumerate() {
            self.state = step(self.state, b);
            if self.state == ScanState::Ground {
                safe = i + 1;
            }
        }
        safe
    }

    pub fn at_boundary(&self) -> bool {
        self.state == ScanState::Ground
    }

    fn reset(&mut self) {
        self.state = ScanState::Ground;
    }
}

fn step(state: ScanState, b: u8) -> ScanState {
    use ScanState::*;
    match state {
        Ground | Utf8(_) if b == 0x1b => Escape,
        Ground => match b {
            0xc2..=0xdf => Utf8(1),
            0xe0..=0xef => Utf8(2),
            0xf0..=0xf4 => Utf8(3),
            _ => Ground,
        },
        Utf8(n) => {
            if (0x80..=0xbf).contains(&b) {
                if n <= 1 {
                    Ground
                } else {
                    Utf8(n - 1)
                }
            } else {
                // Broken UTF-8: the emulator replaces it, treat as ended.
                step(Ground, b)
            }
        }
        Escape => match b {
            b'[' => Csi,
            b']' | b'P' | b'X' | b'^' | b'_' => Str,
            0x20..=0x2f => EscapeIntermediate,
            0x1b => Escape,
            _ => Ground,
        },
        EscapeIntermediate => match b {
            0x20..=0x2f => EscapeIntermediate,
            0x1b => Escape,
            _ => Ground,
        },
        Csi => match b {
            0x40..=0x7e => Ground,
            0x1b => Escape,
            // CAN / SUB abort a sequence.
            0x18 | 0x1a => Ground,
            _ => Csi,
        },
        Str => match b {
            0x07 => Ground,
            0x1b => StrEscape,
            0x18 | 0x1a => Ground,
            _ => Str,
        },
        // ESC ends the string as the emulator sees it (ESC \\ is ST, any
        // other byte starts a new escape sequence).
        StrEscape => match b {
            b'\\' => Ground,
            _ => step(Escape, b),
        },
    }
}

#[derive(Default)]
struct Hooks {
    title: String,
    /// ED 3 (`CSI 3 J`, `CSI ? 3 J` in any spelling) was parsed; vt100
    /// itself ignores it.
    erase_history: bool,
}

impl vt100::Callbacks for Hooks {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let t = String::from_utf8_lossy(title);
        self.title = t.chars().take(MAX_TITLE).collect();
    }

    fn unhandled_csi(
        &mut self,
        _: &mut vt100::Screen,
        i1: Option<u8>,
        _: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        if c == 'J'
            && matches!(i1, None | Some(b'?'))
            && params.first().and_then(|p| p.first()) == Some(&3)
        {
            self.erase_history = true;
        }
    }
}

/// Where an epoch starts: what a rebuild loads before feeding the log from
/// `offset` on. The emulator of every epoch is created from this, live and
/// rebuilt alike.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochStart {
    pub epoch: u32,
    pub offset: u64,
    pub rows: u16,
    pub cols: u16,
    /// `state_formatted` of the screen the epoch begins with (empty for the
    /// first epoch).
    pub state: Vec<u8>,
}

/// A resize applied once the emulator was fed up to `offset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Resize {
    pub offset: u64,
    pub rows: u16,
    pub cols: u16,
}

/// Why the feeder cut a piece where it did.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cut {
    Plain,
    /// The piece is exactly a sequence that may switch screens or reset the
    /// terminal; its scroll count is 0 by construction.
    Isolated,
}

/// An emulator fed in pieces that keeps the history row numbering exact.
pub struct Feeder {
    parser: vt100::Parser<Hooks>,
    /// Scrollback length of `parser`.
    keep: usize,
    /// Sequence state across calls, for the cut points.
    scan: ScanState,
    /// Rows scrolled off the normal screen in this epoch.
    lines: u64,
    /// `lines` counts every row (no saturated piece in this epoch).
    exact: bool,
    epoch: u32,
    /// Stream offset of the next byte fed.
    offset: u64,
    /// Rows the scrollback holds now.
    held: usize,
    /// Set when an epoch began during the last `feed`.
    started: Option<EpochStart>,
}

impl Feeder {
    /// The emulator of `start` (same for live and rebuilt), keeping `keep`
    /// rows of scrollback.
    pub fn new(start: &EpochStart, keep: usize, title: String) -> Feeder {
        let mut parser = vt100::Parser::new_with_callbacks(
            start.rows,
            start.cols,
            keep,
            Hooks {
                title,
                erase_history: false,
            },
        );
        parser.process(&start.state);
        let screen = parser.screen_mut();
        screen.set_scrollback(usize::MAX);
        let held = screen.scrollback();
        screen.set_scrollback(0);
        Feeder {
            parser,
            keep,
            scan: ScanState::Ground,
            lines: 0,
            exact: true,
            epoch: start.epoch,
            offset: start.offset,
            held,
            started: None,
        }
    }

    pub fn screen(&self) -> &vt100::Screen {
        self.parser.screen()
    }

    pub fn lines(&self) -> u64 {
        self.lines
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn exact(&self) -> bool {
        self.exact
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
    }

    fn title(&self) -> &str {
        &self.parser.callbacks().title
    }

    /// The epoch that began during the last `feed`, if any (the newest).
    pub fn take_started(&mut self) -> Option<EpochStart> {
        self.started.take()
    }

    /// Feed the next bytes of the stream. `on_rows(first, count)` hears of
    /// every run of rows that scrolled off, numbered in the current epoch;
    /// they are the newest `count` rows of the scrollback when it is called.
    pub fn feed(&mut self, data: &[u8], on_rows: &mut dyn FnMut(&mut Feeder, u64, u64)) {
        let mut start = 0;
        // Where the escape sequence being scanned began in `data`.
        let mut seq_start: Option<usize> = None;
        for (i, &b) in data.iter().enumerate() {
            let prev = self.scan;
            self.scan = step(prev, b);
            // An ESC that may start a sequence (also the one ending a string).
            if (self.scan == ScanState::Escape && prev != ScanState::Escape)
                || (self.scan == ScanState::StrEscape && prev != ScanState::StrEscape)
            {
                seq_start = Some(i);
            }
            if self.scan == ScanState::Ground && prev != ScanState::Ground {
                let after_esc = matches!(prev, ScanState::Escape | ScanState::StrEscape);
                let isolate =
                    matches!((prev, b), (ScanState::Csi, b'h' | b'l')) || (after_esc && b == b'c');
                let cut_after = matches!((prev, b), (ScanState::Csi, b'J' | b'S'));
                if isolate {
                    let s = seq_start.unwrap_or(start).max(start);
                    if s > start {
                        self.piece(&data[start..s], Cut::Plain, on_rows);
                    }
                    self.piece(&data[s..=i], Cut::Isolated, on_rows);
                    start = i + 1;
                } else if cut_after {
                    self.piece(&data[start..=i], Cut::Plain, on_rows);
                    start = i + 1;
                }
            }
            if i + 1 - start >= PIECE {
                self.piece(&data[start..=i], Cut::Plain, on_rows);
                start = i + 1;
            }
        }
        if start < data.len() {
            self.piece(&data[start..], Cut::Plain, on_rows);
        }
    }

    fn piece(&mut self, bytes: &[u8], cut: Cut, on_rows: &mut dyn FnMut(&mut Feeder, u64, u64)) {
        let screen = self.parser.screen_mut();
        let alt_before = screen.alternate_screen();
        screen.set_scrollback(usize::MAX);
        let len_before = screen.scrollback();
        screen.set_scrollback(1);
        self.parser.process(bytes);
        self.offset += bytes.len() as u64;
        let screen = self.parser.screen_mut();
        let alt_after = screen.alternate_screen();
        let at = screen.scrollback();
        screen.set_scrollback(usize::MAX);
        let len_after = screen.scrollback();
        screen.set_scrollback(0);
        self.held = len_after;
        let scrolled = if cut == Cut::Isolated || alt_before || alt_after {
            // History is only the normal screen's, and a switch or reset
            // scrolls nothing (it is alone in its piece).
            0
        } else if len_before == 0 {
            // Position 1 is not settable on an empty scrollback.
            if len_after >= self.keep {
                self.exact = false;
            }
            len_after as u64
        } else {
            // The position moves up one per row scrolled off, capped at the length.
            if at == 0 || at >= self.keep {
                self.exact = false;
            }
            at.saturating_sub(1) as u64
        };
        if scrolled > 0 {
            let first = self.lines;
            self.lines += scrolled;
            on_rows(self, first, scrolled);
        }
        let erased = std::mem::take(&mut self.parser.callbacks_mut().erase_history);
        let reset = cut == Cut::Isolated && bytes.ends_with(b"\x1bc");
        if (erased && !alt_after || reset) && self.lines > 0 {
            self.begin_epoch();
        }
    }

    /// The history was erased: the next epoch starts from the screen as it
    /// is, on a new emulator built from it (what `state_formatted` does not
    /// carry is lost: a scroll region, origin mode and a saved cursor, until
    /// the program sets them again; Claude Code and a shell's `clear` use
    /// none of them).
    fn begin_epoch(&mut self) {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let start = EpochStart {
            epoch: self.epoch.wrapping_add(1),
            offset: self.offset,
            rows,
            cols,
            state: screen.state_formatted(),
        };
        let title = std::mem::take(&mut self.parser.callbacks_mut().title);
        *self = Feeder::new(&start, self.keep, title);
        self.started = Some(start);
    }

    /// Rows `[from, to)` of the current epoch formatted (full width, no line
    /// end), oldest first; None unless the scrollback still holds all of
    /// them (the newest `keep` rows).
    pub fn history_rows(&mut self, from: u64, to: u64) -> Option<Vec<Vec<u8>>> {
        if from > to || to > self.lines || from < self.oldest_held() {
            return None;
        }
        let lines = self.lines;
        let view = self.parser.screen_mut();
        let mut out = Vec::with_capacity((to - from) as usize);
        for row in from..to {
            view.set_scrollback((lines - row) as usize);
            out.push(view.rows_formatted(0, MAX_DIM).next().unwrap_or_default());
        }
        view.set_scrollback(0);
        Some(out)
    }

    /// Oldest row number the scrollback still holds.
    pub fn oldest_held(&self) -> u64 {
        self.lines.saturating_sub(self.held as u64)
    }
}

/// A snapshot ready to put in a `Snapshot` frame.
pub struct Snapshot {
    pub offset: u64,
    pub cols: u16,
    pub rows: u16,
    pub alt_screen: bool,
    pub vt: Vec<u8>,
}

/// The VT of a `LiveSnapshot`, before it is split into frames.
pub struct LiveSnapshot {
    pub offset: u64,
    pub cols: u16,
    pub rows: u16,
    pub epoch: u32,
    /// History rows before this number are not in `vt` (asked for with
    /// `HistoryRequest`); `tail_rows` rows from it are, above the screen.
    pub history_end: u64,
    pub tail_rows: u16,
    pub vt: Vec<u8>,
}

/// What a rebuild of the current epoch needs, pinned at one moment.
#[derive(Debug, Clone)]
pub struct EpochPin {
    pub start: EpochStart,
    pub resizes: Vec<Resize>,
    /// Feed the log up to here.
    pub fed: u64,
    /// Rows the live screen numbered by then.
    pub lines: u64,
}

pub struct Screen {
    feeder: Feeder,
    scanner: BoundaryScanner,
    /// Bytes read but not yet fed because they end inside a sequence.
    held: Vec<u8>,
    /// Where the current epoch began, and the resizes since.
    epoch_start: EpochStart,
    resizes: Vec<Resize>,
    /// More resizes than `MAX_RESIZES` in this epoch: no rebuild.
    resizes_lost: bool,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        let epoch_start = EpochStart {
            epoch: 0,
            offset: 0,
            rows,
            cols,
            state: Vec::new(),
        };
        Screen {
            feeder: Feeder::new(&epoch_start, SCROLLBACK_ROWS, String::new()),
            scanner: BoundaryScanner::default(),
            held: Vec::new(),
            epoch_start,
            resizes: Vec::new(),
            resizes_lost: false,
        }
    }

    /// Feed raw output (in stream order).
    pub fn process(&mut self, data: &[u8]) {
        let safe = self.scanner.scan(data);
        if safe > 0 {
            if self.held.is_empty() {
                self.feed(&data[..safe]);
            } else {
                self.held.extend_from_slice(&data[..safe]);
                let held = std::mem::take(&mut self.held);
                self.feed(&held);
            }
            self.held.extend_from_slice(&data[safe..]);
        } else {
            self.held.extend_from_slice(data);
        }
        if self.held.len() > MAX_HELD {
            // A sequence that never ends: give up waiting for it.
            let held = std::mem::take(&mut self.held);
            self.feed(&held);
            self.scanner.reset();
        }
    }

    fn feed(&mut self, data: &[u8]) {
        self.feeder.feed(data, &mut |_, _, _| {});
        if let Some(start) = self.feeder.take_started() {
            self.epoch_start = start;
            self.resizes.clear();
            self.resizes_lost = false;
        }
    }

    /// Offset the next snapshot would carry.
    pub fn fed_offset(&self) -> u64 {
        self.feeder.offset()
    }

    /// Resize the emulator once fed up to `fed_offset()`, recorded so a
    /// rebuild of the epoch applies it at the same point. The same size
    /// again changes nothing.
    pub fn resize(&mut self, rows: u16, cols: u16) {
        if self.feeder.screen().size() == (rows, cols) {
            return;
        }
        self.feeder.resize(rows, cols);
        if self.resizes.len() >= MAX_RESIZES {
            self.resizes_lost = true;
        } else {
            self.resizes.push(Resize {
                offset: self.fed_offset(),
                rows,
                cols,
            });
        }
    }

    pub fn title(&self) -> &str {
        self.feeder.title()
    }

    pub fn epoch(&self) -> u32 {
        self.feeder.epoch()
    }

    /// History rows numbered so far in the current epoch.
    pub fn lines(&self) -> u64 {
        self.feeder.lines()
    }

    pub fn alternate_screen(&self) -> bool {
        self.feeder.screen().alternate_screen()
    }

    /// Every history row of the current epoch has its number.
    pub fn exact(&self) -> bool {
        self.feeder.exact()
    }

    /// A client may start from a `LiveSnapshot`: the normal screen is shown
    /// and every history row of the epoch has its number.
    pub fn live_ready(&self) -> bool {
        !self.alternate_screen() && self.feeder.exact()
    }

    /// Rows `[from, to)` of the current epoch from the live scrollback (the
    /// newest `SCROLLBACK_ROWS`); None when they are not all there.
    pub fn history_rows(&mut self, from: u64, to: u64) -> Option<Vec<Vec<u8>>> {
        self.feeder.history_rows(from, to)
    }

    /// Oldest row of the epoch the live scrollback still holds.
    pub fn oldest_held(&self) -> u64 {
        self.feeder.oldest_held()
    }

    /// The current epoch as a rebuild must replay it; None when it cannot
    /// (numbering unreliable or too many resizes).
    pub fn pin(&self) -> Option<EpochPin> {
        if !self.feeder.exact() || self.resizes_lost {
            return None;
        }
        Some(EpochPin {
            start: self.epoch_start.clone(),
            resizes: self.resizes.clone(),
            fed: self.fed_offset(),
            lines: self.lines(),
        })
    }

    /// The screen as it is now with the newest history rows above it that
    /// fit one frame (at most one screen of them): RIS, title, those rows
    /// scrolled into the client's scrollback, then the screen state. Only
    /// for the normal screen (`live_ready`).
    pub fn live_snapshot(&mut self) -> LiveSnapshot {
        let (rows, cols) = self.feeder.screen().size();
        let mut vt = Vec::with_capacity(4096);
        vt.extend_from_slice(b"\x1bc");
        let title = self.title();
        if !title.is_empty() {
            vt.extend_from_slice(b"\x1b]2;");
            vt.extend_from_slice(title.as_bytes());
            vt.push(0x07);
        }
        let lines = self.lines();
        let budget = MAX_LIVE_SNAPSHOT_VT.saturating_sub(vt.len());
        let max_tail = u64::from(rows).min(lines - self.oldest_held());
        let tail = tail_rows(&mut self.feeder, lines, max_tail, rows, budget, &mut vt);
        vt.extend_from_slice(&self.feeder.screen().state_formatted());
        LiveSnapshot {
            offset: self.fed_offset(),
            cols: cols.clamp(MIN_DIM, MAX_DIM),
            rows: rows.clamp(MIN_DIM, MAX_DIM),
            epoch: self.epoch(),
            history_end: lines - tail,
            tail_rows: tail as u16,
            vt,
        }
    }

    /// VT bytes that rebuild the screen on a client that writes them right
    /// after resizing to `cols`x`rows`. Begins with RIS so the client state is
    /// fully replaced; enters the alternate screen when the app uses it. On the
    /// normal screen the newest rows of history that fit the frame come first,
    /// scrolled off the top, so the client can scroll back to them.
    pub fn snapshot(&self) -> Snapshot {
        let screen = self.feeder.screen();
        let (rows, cols) = screen.size();
        let alt_screen = screen.alternate_screen();
        let mut vt = Vec::with_capacity(4096);
        vt.extend_from_slice(b"\x1bc");
        if alt_screen {
            vt.extend_from_slice(b"\x1b[?1049h");
        }
        let title = self.title();
        if !title.is_empty() {
            vt.extend_from_slice(b"\x1b]2;");
            vt.extend_from_slice(title.as_bytes());
            vt.push(0x07);
        }
        let prefix = vt.len();
        let state = screen.state_formatted();
        if prefix + state.len() > MAX_SNAPSHOT_VT {
            plain_rows(screen, cols, MAX_SNAPSHOT_VT, &mut vt);
        } else {
            if !alt_screen {
                history(screen, MAX_SNAPSHOT_VT - prefix - state.len(), &mut vt);
            }
            vt.extend_from_slice(&state);
        }
        Snapshot {
            offset: self.fed_offset(),
            cols: cols.clamp(MIN_DIM, MAX_DIM),
            rows: rows.clamp(MIN_DIM, MAX_DIM),
            alt_screen,
            vt,
        }
    }
}

/// Up to `max` of the newest history rows (`lines` numbered so far) that fit
/// `budget` bytes, oldest first, each on its own line, then enough line feeds
/// that all of them scroll off the top of a client screen of `rows` rows
/// that starts at the home position. Returns how many.
fn tail_rows(
    feeder: &mut Feeder,
    lines: u64,
    max: u64,
    rows: u16,
    budget: usize,
    out: &mut Vec<u8>,
) -> u64 {
    let push = usize::from(rows.saturating_sub(1));
    let mut picked: Vec<Vec<u8>> = Vec::new();
    let mut used = push;
    let held = feeder.history_rows(lines - max, lines).unwrap_or_default();
    for mut line in held.into_iter().rev() {
        line.extend_from_slice(b"\x1b[m\r\n");
        if used + line.len() > budget {
            break;
        }
        used += line.len();
        picked.push(line);
    }
    if picked.is_empty() {
        return 0;
    }
    for line in picked.iter().rev() {
        out.extend_from_slice(line);
    }
    out.extend(std::iter::repeat_n(b'\n', push));
    picked.len() as u64
}

/// The newest rows above the normal screen that fit `budget` bytes, oldest
/// first, each on its own line, then enough line feeds that every one of them
/// has scrolled off the top of a client that starts at the home position.
/// Nothing when there is no history or not even one row fits.
fn history(screen: &vt100::Screen, budget: usize, out: &mut Vec<u8>) {
    let (rows, cols) = screen.size();
    let mut view = screen.clone();
    view.set_scrollback(usize::MAX);
    let total = view.scrollback();
    if total == 0 {
        return;
    }
    // Line feeds after the rows, pushing the last of them off the screen.
    let push = usize::from(rows.saturating_sub(1));
    let mut lines: Vec<Vec<u8>> = Vec::new();
    let mut used = push;
    // Newest first: at scrollback offset `n` the view's top row is history row `total - n`.
    for offset in 1..=total {
        view.set_scrollback(offset);
        let mut line = view.rows_formatted(0, cols).next().unwrap_or_default();
        line.extend_from_slice(b"\x1b[m\r\n");
        if used + line.len() > budget {
            break;
        }
        used += line.len();
        lines.push(line);
    }
    if lines.is_empty() {
        return;
    }
    for line in lines.iter().rev() {
        out.extend_from_slice(line);
    }
    out.extend(std::iter::repeat_n(b'\n', push));
}

/// Degraded snapshot that fits a frame: plain text of the bottom rows that
/// fit (no colors), then cursor position, cursor visibility and input modes.
fn plain_rows(screen: &vt100::Screen, cols: u16, max: usize, out: &mut Vec<u8>) {
    let mut tail = Vec::new();
    let (cy, cx) = screen.cursor_position();
    tail.extend_from_slice(format!("\x1b[{};{}H", cy + 1, cx + 1).as_bytes());
    if screen.hide_cursor() {
        tail.extend_from_slice(b"\x1b[?25l");
    }
    tail.extend_from_slice(&screen.input_mode_formatted());
    let lines: Vec<String> = screen.rows(0, cols).collect();
    let budget = max.saturating_sub(out.len() + tail.len());
    let mut body: Vec<Vec<u8>> = Vec::new();
    let mut used = 0;
    for (i, line) in lines.iter().enumerate().rev() {
        let mut row = format!("\x1b[{};1H", i + 1).into_bytes();
        row.extend_from_slice(line.trim_end().as_bytes());
        if used + row.len() > budget {
            break;
        }
        used += row.len();
        body.push(row);
    }
    for row in body.iter().rev() {
        out.extend_from_slice(row);
    }
    out.extend_from_slice(&tail);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply a snapshot followed by the bytes after its offset on a fresh
    /// emulator, as a client would, and return the resulting screen text.
    fn client_view(snap: &Snapshot, after: &[u8]) -> (String, (u16, u16), bool) {
        let mut p = vt100::Parser::new(snap.rows, snap.cols, 0);
        p.process(&snap.vt);
        p.process(after);
        let s = p.screen();
        (s.contents(), s.cursor_position(), s.alternate_screen())
    }

    fn reference(stream: &[u8], rows: u16, cols: u16) -> (String, (u16, u16), bool) {
        let mut p = vt100::Parser::new(rows, cols, 0);
        p.process(stream);
        let s = p.screen();
        (s.contents(), s.cursor_position(), s.alternate_screen())
    }

    #[test]
    fn scanner_finds_boundaries() {
        let mut s = BoundaryScanner::default();
        assert_eq!(s.scan(b"ab\x1b[3"), 2);
        assert!(!s.at_boundary());
        assert_eq!(s.scan(b"1mX"), 3);
        assert_eq!(s.scan("tiếng".as_bytes()), "tiếng".len());
        let v = "ế".as_bytes();
        assert_eq!(s.scan(&v[..1]), 0);
        assert_eq!(s.scan(&v[1..]), 2);
        assert_eq!(s.scan(b"\x1b]2;title"), 0);
        assert_eq!(s.scan(b"\x1b\\z"), 3);
        assert_eq!(s.scan(b"\x1b(B"), 3);
    }

    #[test]
    fn snapshot_at_every_split_point_has_no_gap_or_overlap() {
        let stream = "\x1b[?1049h\x1b[2J\x1b[1;1H\x1b[38;2;255;0;0mđỏ\x1b[0m xin chào\r\n\x1b]2;vim\x07\x1b[5;10Hcursor"
            .as_bytes()
            .to_vec();
        let want = reference(&stream, 24, 80);
        for split in 0..=stream.len() {
            let mut screen = Screen::new(24, 80);
            screen.process(&stream[..split]);
            let snap = screen.snapshot();
            assert!(snap.offset as usize <= split);
            let got = client_view(&snap, &stream[snap.offset as usize..]);
            assert_eq!(got, want, "split at {split}");
        }
    }

    #[test]
    fn snapshot_reproduces_attributes_and_title() {
        let mut screen = Screen::new(5, 20);
        screen.process(b"\x1b]2;my title\x07\x1b[1;4;31mred\x1b[0m plain");
        let snap = screen.snapshot();
        assert_eq!(screen.title(), "my title");
        assert!(!snap.alt_screen);
        let mut p = vt100::Parser::new(5, 20, 0);
        p.process(&snap.vt);
        let cell = p
            .screen()
            .cell(0, 0)
            .map(|c| (c.bold(), c.underline(), c.fgcolor()));
        assert_eq!(cell, Some((true, true, vt100::Color::Idx(1))));
        assert_eq!(p.screen().cursor_position(), (0, 9));
    }

    #[test]
    fn oversized_snapshot_degrades_to_plain_text_that_fits() {
        let mut screen = Screen::new(200, 400);
        let mut s = Vec::new();
        for r in 0..200 {
            for c in 0..400 {
                s.extend_from_slice(
                    format!(
                        "\x1b[38;5;{}m{}",
                        (r + c) % 256,
                        (b'a' + (c % 26) as u8) as char
                    )
                    .as_bytes(),
                );
            }
        }
        screen.process(&s);
        let snap = screen.snapshot();
        assert!(snap.vt.len() <= MAX_SNAPSHOT_VT);
        let mut p = vt100::Parser::new(200, 400, 0);
        p.process(&snap.vt);
        // The bottom row survives in plain text.
        let last: String = p.screen().rows(0, 400).last().unwrap_or_default();
        assert!(last.starts_with("abcdefghij"));
    }

    /// What a client keeps after writing a snapshot on a fresh emulator: its history rows (oldest first) and its screen.
    fn client_history(snap: &Snapshot) -> (Vec<String>, String) {
        let mut p = vt100::Parser::new(snap.rows, snap.cols, 500);
        p.process(&snap.vt);
        let contents = p.screen().contents();
        let mut view = p.screen().clone();
        view.set_scrollback(usize::MAX);
        let total = view.scrollback();
        let rows = (1..=total)
            .rev()
            .map(|offset| {
                view.set_scrollback(offset);
                view.rows(0, snap.cols).next().unwrap_or_default()
            })
            .collect();
        (rows, contents)
    }

    #[test]
    fn snapshot_carries_the_history_above_the_screen() {
        let mut screen = Screen::new(5, 30);
        for i in 1..=40 {
            screen.process(format!("\x1b[32mline {i}\x1b[m\r\n").as_bytes());
        }
        screen.process(b"prompt> ");
        let snap = screen.snapshot();
        let (rows, contents) = client_history(&snap);
        let want: Vec<String> = (1..=36).map(|i| format!("line {i}")).collect();
        assert_eq!(rows, want);
        assert_eq!(contents, "line 37\nline 38\nline 39\nline 40\nprompt> ");
        assert_eq!(client_view(&snap, b"").1, (4, 8));
    }

    #[test]
    fn snapshot_history_keeps_the_newest_rows_that_fit_a_frame() {
        let mut screen = Screen::new(5, 400);
        let wide = "x".repeat(390);
        for i in 0..SCROLLBACK_ROWS {
            screen.process(format!("{i:05} {wide}\r\n").as_bytes());
        }
        let snap = screen.snapshot();
        assert!(snap.vt.len() <= MAX_SNAPSHOT_VT);
        let (rows, _) = client_history(&snap);
        assert!(
            rows.len() > 100 && rows.len() < SCROLLBACK_ROWS - 4,
            "{} rows",
            rows.len()
        );
        let newest = format!("{:05}", SCROLLBACK_ROWS - 5);
        assert!(rows.last().is_some_and(|r| r.starts_with(&newest)));
    }

    #[test]
    fn erase_scrollback_forgets_the_history_but_not_the_screen() {
        let mut screen = Screen::new(5, 30);
        screen.process(b"\x1b]2;claude\x07");
        for i in 1..=20 {
            screen.process(format!("old {i}\r\n").as_bytes());
        }
        // A full redraw split across reads: clear, then the reprint.
        screen.process(b"\x1b[2J\x1b[3");
        screen.process(b"J\x1b[Hnew 1\r\nnew 2\r\nnew 3\r\nnew 4\r\nnew 5\r\nnew 6\r\n");
        let snap = screen.snapshot();
        let (rows, contents) = client_history(&snap);
        assert_eq!(rows, vec!["new 1".to_string(), "new 2".to_string()]);
        assert!(contents.starts_with("new 3"));
        assert_eq!(screen.title(), "claude");
    }

    #[test]
    fn erase_scrollback_keeps_the_cursor_attributes_and_input_modes() {
        let mut screen = Screen::new(5, 30);
        for i in 1..=8 {
            screen.process(format!("old {i}\r\n").as_bytes());
        }
        // Hidden cursor, bracketed paste, application cursor keys, bold red pen, cursor at row 3 col 5.
        screen.process(b"\x1b[?25l\x1b[?2004h\x1b[?1h\x1b[1;31m\x1b[3J\x1b[3;5H");
        screen.process(b"x");
        let s = screen.feeder.screen();
        assert!(s.hide_cursor());
        assert!(s.bracketed_paste());
        assert!(s.application_cursor());
        assert_eq!(s.cursor_position(), (2, 5));
        let cell = s.cell(2, 4).map(|c| (c.contents(), c.bold(), c.fgcolor()));
        assert_eq!(cell, Some(("x", true, vt100::Color::Idx(1))));
        let (rows, _) = client_history(&screen.snapshot());
        assert!(rows.is_empty());
    }

    #[test]
    fn alternate_screen_snapshot_has_no_history() {
        let mut screen = Screen::new(5, 30);
        for i in 1..=20 {
            screen.process(format!("old {i}\r\n").as_bytes());
        }
        screen.process(b"\x1b[?1049hfull screen");
        let snap = screen.snapshot();
        assert!(snap.alt_screen);
        assert!(!String::from_utf8_lossy(&snap.vt).contains("old 1"));
    }

    #[test]
    fn unterminated_string_does_not_hold_forever() {
        let mut screen = Screen::new(24, 80);
        screen.process(b"\x1b]2;");
        screen.process(&vec![b'x'; MAX_HELD + 10]);
        assert_eq!(screen.fed_offset(), (MAX_HELD + 14) as u64);
    }
}
