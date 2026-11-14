//! Headless emulator that keeps the screen of a session for `Snapshot`.
//!
//! The emulator is only fed up to a *safe boundary*: a byte offset where the
//! stream is not inside an escape sequence or a UTF-8 character. A snapshot is
//! taken at that boundary and the bytes after it are replayed as `Output`, so
//! a sequence split across PTY reads is never cut in half (no gap, no overlap).

use crate::wire::{MAX_DIM, MAX_SNAPSHOT_VT, MIN_DIM};

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
/// Erase the scrollback (ED 3), which vt100 ignores: a program sends it with a
/// full redraw (Claude Code reprints its whole conversation after it), so the
/// history kept must go too or a client would see that conversation twice.
const ERASE_SCROLLBACK: &[u8] = b"\x1b[3J";

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
        StrEscape => match b {
            b'\\' => Ground,
            0x1b => StrEscape,
            _ => Str,
        },
    }
}

#[derive(Default)]
struct TitleCapture {
    title: String,
}

impl vt100::Callbacks for TitleCapture {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let t = String::from_utf8_lossy(title);
        self.title = t.chars().take(MAX_TITLE).collect();
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

pub struct Screen {
    parser: vt100::Parser<TitleCapture>,
    scanner: BoundaryScanner,
    /// Bytes read but not yet fed because they end inside a sequence.
    held: Vec<u8>,
    /// Stream offset up to which the emulator state is exact.
    fed: u64,
}

impl Screen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Screen {
            parser: vt100::Parser::new_with_callbacks(
                rows,
                cols,
                SCROLLBACK_ROWS,
                TitleCapture::default(),
            ),
            scanner: BoundaryScanner::default(),
            held: Vec::new(),
            fed: 0,
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
                self.fed += held.len() as u64 - safe as u64;
            }
            self.fed += safe as u64;
            self.held.extend_from_slice(&data[safe..]);
        } else {
            self.held.extend_from_slice(data);
        }
        if self.held.len() > MAX_HELD {
            // A sequence that never ends: give up waiting for it.
            let held = std::mem::take(&mut self.held);
            self.feed(&held);
            self.fed += held.len() as u64;
            self.scanner.reset();
        }
    }

    /// Hands bytes to the emulator, dropping the history kept at each ED 3
    /// (complete sequences only: callers feed up to a safe boundary).
    fn feed(&mut self, mut data: &[u8]) {
        while let Some(at) = data
            .windows(ERASE_SCROLLBACK.len())
            .position(|w| w == ERASE_SCROLLBACK)
        {
            let end = at + ERASE_SCROLLBACK.len();
            self.parser.process(&data[..end]);
            self.drop_scrollback();
            data = &data[end..];
        }
        self.parser.process(data);
    }

    /// Forgets the rows above the normal screen: a new emulator takes over the
    /// screen as it is (contents, cursor and its visibility, attributes, input
    /// modes, title). What state_formatted() does not carry is lost: a scroll
    /// region (DECSTBM), origin mode and a saved cursor, until the program sets
    /// them again (Claude Code and a shell's `clear` use none of them). The
    /// history of a program on the alternate screen stays, as its screen would
    /// be lost.
    fn drop_scrollback(&mut self) {
        let screen = self.parser.screen();
        if screen.alternate_screen() {
            return;
        }
        let (rows, cols) = screen.size();
        let state = screen.state_formatted();
        let title = std::mem::take(&mut self.parser.callbacks_mut().title);
        let mut parser =
            vt100::Parser::new_with_callbacks(rows, cols, SCROLLBACK_ROWS, TitleCapture { title });
        parser.process(&state);
        self.parser = parser;
    }

    /// Offset the next snapshot would carry.
    pub fn fed_offset(&self) -> u64 {
        self.fed
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.screen_mut().set_size(rows, cols);
    }

    pub fn title(&self) -> &str {
        &self.parser.callbacks().title
    }

    /// VT bytes that rebuild the screen on a client that writes them right
    /// after resizing to `cols`x`rows`. Begins with RIS so the client state is
    /// fully replaced; enters the alternate screen when the app uses it. On the
    /// normal screen the newest rows of history that fit the frame come first,
    /// scrolled off the top, so the client can scroll back to them.
    pub fn snapshot(&self) -> Snapshot {
        let screen = self.parser.screen();
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
            offset: self.fed,
            cols: cols.clamp(MIN_DIM, MAX_DIM),
            rows: rows.clamp(MIN_DIM, MAX_DIM),
            alt_screen,
            vt,
        }
    }
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
        let s = screen.parser.screen();
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
