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
            parser: vt100::Parser::new_with_callbacks(rows, cols, 0, TitleCapture::default()),
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
                self.parser.process(&data[..safe]);
            } else {
                self.held.extend_from_slice(&data[..safe]);
                self.parser.process(&self.held);
                self.fed += self.held.len() as u64 - safe as u64;
                self.held.clear();
            }
            self.fed += safe as u64;
            self.held.extend_from_slice(&data[safe..]);
        } else {
            self.held.extend_from_slice(data);
        }
        if self.held.len() > MAX_HELD {
            // A sequence that never ends: give up waiting for it.
            self.parser.process(&self.held);
            self.fed += self.held.len() as u64;
            self.held.clear();
            self.scanner.reset();
        }
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
    /// fully replaced; enters the alternate screen when the app uses it.
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
        vt.extend_from_slice(&screen.state_formatted());
        if vt.len() > MAX_SNAPSHOT_VT {
            vt.truncate(prefix);
            plain_rows(screen, cols, MAX_SNAPSHOT_VT, &mut vt);
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

    #[test]
    fn unterminated_string_does_not_hold_forever() {
        let mut screen = Screen::new(24, 80);
        screen.process(b"\x1b]2;");
        screen.process(&vec![b'x'; MAX_HELD + 10]);
        assert_eq!(screen.fed_offset(), (MAX_HELD + 14) as u64);
    }
}
