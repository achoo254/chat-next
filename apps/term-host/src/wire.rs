//! Terminal frames (docs/terminal-wire.md section 3): encode and decode with
//! strict bounds. Decoding never panics and never allocates; it borrows from
//! the input buffer.

/// Protocol version carried by `Hello` in both directions.
pub const VERSION: u8 = 1;
/// Largest frame on any path, header included.
pub const MAX_FRAME: usize = 65536;
/// Largest `Input` payload.
pub const MAX_INPUT: usize = 8192;
/// `type u8` + `session u32`.
pub const HEADER_LEN: usize = 5;
/// Header + `offset u64` of an `Output` frame.
pub const OUTPUT_HEADER_LEN: usize = HEADER_LEN + 8;
/// Largest `Output` payload that still fits in one frame.
pub const MAX_OUTPUT_DATA: usize = MAX_FRAME - OUTPUT_HEADER_LEN;
/// Header + offset + cols + rows + altScreen of a `Snapshot` frame.
pub const SNAPSHOT_HEADER_LEN: usize = HEADER_LEN + 8 + 2 + 2 + 1;
/// Largest VT payload of a `Snapshot`.
pub const MAX_SNAPSHOT_VT: usize = MAX_FRAME - SNAPSHOT_HEADER_LEN;
/// Header + offset + cols + rows + epoch + historyEnd + tailRows + part +
/// parts of a `LiveSnapshot` frame.
pub const LIVE_SNAPSHOT_HEADER_LEN: usize = HEADER_LEN + 8 + 2 + 2 + 4 + 8 + 2 + 1 + 1;
/// Largest VT payload of one `LiveSnapshot` part.
pub const MAX_LIVE_SNAPSHOT_VT: usize = MAX_FRAME - LIVE_SNAPSHOT_HEADER_LEN;
/// Header + reqId + epoch + firstRow + rowCount + part + parts + atStart of a
/// `History` frame.
pub const HISTORY_HEADER_LEN: usize = HEADER_LEN + 2 + 4 + 8 + 2 + 1 + 1 + 1;
/// Largest VT payload of one `History` part.
pub const MAX_HISTORY_VT: usize = MAX_FRAME - HISTORY_HEADER_LEN;
/// Most rows one `HistoryRequest` may ask for.
pub const MAX_HISTORY_ROWS: u16 = 500;
/// `Hello.caps` bit: the client takes `LiveSnapshot` for a fresh attach on the
/// normal screen and asks for older rows with `HistoryRequest` (section 4).
pub const CAP_LIVE_HISTORY: u8 = 0x01;
/// Capabilities this daemon understands.
pub const SUPPORTED_CAPS: u8 = CAP_LIVE_HISTORY;
/// Terminal size bounds for `Resize`, `open` and `resize`.
pub const MIN_DIM: u16 = 1;
pub const MAX_DIM: u16 = 1000;

pub mod client_type {
    pub const HELLO: u8 = 0x01;
    pub const INPUT: u8 = 0x10;
    pub const RESIZE: u8 = 0x11;
    pub const ATTACH: u8 = 0x12;
    pub const DETACH: u8 = 0x13;
    pub const ACK: u8 = 0x14;
    pub const PING: u8 = 0x15;
    pub const PREVIEW: u8 = 0x16;
    pub const HISTORY_REQUEST: u8 = 0x17;
}

pub mod server_type {
    pub const HELLO: u8 = 0x81;
    pub const OUTPUT: u8 = 0x90;
    pub const SNAPSHOT: u8 = 0x91;
    pub const EXIT: u8 = 0x92;
    pub const PREVIEW: u8 = 0x93;
    pub const LIVE_SNAPSHOT: u8 = 0x94;
    pub const PONG: u8 = 0x95;
    pub const HISTORY: u8 = 0x96;
    pub const HISTORY_ERROR: u8 = 0x97;
    pub const ERROR: u8 = 0x9F;
}

/// `Error` frame codes (section 3).
pub mod error_code {
    pub const NO_SUCH_SESSION: u16 = 1;
    pub const SESSION_LIMIT: u16 = 2;
    pub const BAD_FRAME: u16 = 3;
    pub const BAD_VERSION: u16 = 4;
    pub const NOT_ATTACHED: u16 = 5;
    pub const REVOKED: u16 = 6;
}

/// `HistoryError` codes (section 4, "Lịch sử theo yêu cầu").
pub mod history_error {
    /// The rows asked for cannot be served (no output log, or the session's
    /// line numbering is not reliable for this epoch).
    pub const UNAVAILABLE: u8 = 1;
    /// Too many requests, or the machine is already rebuilding its maximum.
    pub const BUSY: u8 = 2;
    /// The request was cancelled (detach, session closed).
    pub const CANCELLED: u8 = 3;
}

/// A frame sent by a client to the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame<'a> {
    Hello {
        version: u8,
        caps: u8,
    },
    Input {
        session: u32,
        data: &'a [u8],
    },
    Resize {
        session: u32,
        cols: u16,
        rows: u16,
    },
    Attach {
        session: u32,
        last_offset: u64,
    },
    Detach {
        session: u32,
    },
    Ack {
        session: u32,
        offset: u64,
    },
    Ping {
        client_micros: u64,
    },
    /// Asks for the session as the daemon's emulator renders it now (a
    /// `Preview`), to show at once while `Attach` replays the whole stream.
    Preview {
        session: u32,
    },
    /// Asks for up to `max_rows` history rows of `epoch` just before
    /// `before_row` (only on an attached session).
    HistoryRequest {
        session: u32,
        req_id: u16,
        epoch: u32,
        before_row: u64,
        max_rows: u16,
    },
}

/// A frame sent by the daemon to a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerFrame<'a> {
    Hello {
        version: u8,
        max_frame: u32,
        /// Present only when the client's `Hello` set a capability bit: an
        /// older client rejects a longer `Hello`.
        caps: Option<u8>,
    },
    Output {
        session: u32,
        offset: u64,
        data: &'a [u8],
    },
    Snapshot {
        session: u32,
        offset: u64,
        cols: u16,
        rows: u16,
        alt_screen: bool,
        vt: &'a [u8],
    },
    /// Answers a client `Preview`: laid out like `Snapshot`, but only to be
    /// shown, never applied to the client's stream; `offset` is the output
    /// offset the rendering reflects.
    Preview {
        session: u32,
        offset: u64,
        cols: u16,
        rows: u16,
        alt_screen: bool,
        vt: &'a [u8],
    },
    /// The screen as it is now, the start of a fresh attach on the normal
    /// screen for a client with `CAP_LIVE_HISTORY`; `Output` follows from
    /// `offset`. The VT is split over `parts` frames (`part` from 0).
    LiveSnapshot {
        session: u32,
        offset: u64,
        cols: u16,
        rows: u16,
        epoch: u32,
        history_end: u64,
        tail_rows: u16,
        part: u8,
        parts: u8,
        vt: &'a [u8],
    },
    /// Answers `HistoryRequest`: `row_count` rows from `first_row`, oldest
    /// first, each ending in CR LF, split over `parts` frames.
    History {
        session: u32,
        req_id: u16,
        epoch: u32,
        first_row: u64,
        row_count: u16,
        part: u8,
        parts: u8,
        at_start: bool,
        vt: &'a [u8],
    },
    HistoryError {
        session: u32,
        req_id: u16,
        code: u8,
    },
    Exit {
        session: u32,
        code: i32,
        signal: u8,
    },
    Pong {
        client_micros: u64,
    },
    Error {
        session: u32,
        code: u16,
        message: &'a str,
    },
}

/// Why a frame could not be decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DecodeError {
    /// Shorter than the header or than the fixed part of its type, or a
    /// fixed-size frame with trailing bytes. Answered with `Error 3`.
    BadLength,
    /// Larger than `MAX_FRAME` (or `MAX_INPUT` for `Input`). `Error 3`.
    TooLarge,
    /// A field out of range (zero size, session id where 0 is required, bad
    /// UTF-8 in an error message). `Error 3`.
    BadValue,
    /// A type this version does not know: ignored by the receiver.
    UnknownType(u8),
}

/// Bounds-checked big-endian reader over a byte slice.
struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.buf.len() < n {
            return Err(DecodeError::BadLength);
        }
        let (head, tail) = self.buf.split_at(n);
        self.buf = tail;
        Ok(head)
    }

    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, DecodeError> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&mut self) -> Result<u64, DecodeError> {
        let b = self.take(8)?;
        let mut a = [0u8; 8];
        a.copy_from_slice(b);
        Ok(u64::from_be_bytes(a))
    }

    fn i32(&mut self) -> Result<i32, DecodeError> {
        Ok(self.u32()? as i32)
    }

    fn rest(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.buf)
    }

    fn end(&self) -> Result<(), DecodeError> {
        if self.buf.is_empty() {
            Ok(())
        } else {
            Err(DecodeError::BadLength)
        }
    }
}

fn header(buf: &[u8]) -> Result<(u8, u32, Reader<'_>), DecodeError> {
    if buf.len() > MAX_FRAME {
        return Err(DecodeError::TooLarge);
    }
    let mut r = Reader { buf };
    let kind = r.u8()?;
    let session = r.u32()?;
    Ok((kind, session, r))
}

fn dim(v: u16) -> Result<u16, DecodeError> {
    if (MIN_DIM..=MAX_DIM).contains(&v) {
        Ok(v)
    } else {
        Err(DecodeError::BadValue)
    }
}

fn connection_level(session: u32) -> Result<(), DecodeError> {
    if session == 0 {
        Ok(())
    } else {
        Err(DecodeError::BadValue)
    }
}

fn session_level(session: u32) -> Result<u32, DecodeError> {
    if session == 0 {
        Err(DecodeError::BadValue)
    } else {
        Ok(session)
    }
}

/// Decode one client frame.
pub fn decode_client(buf: &[u8]) -> Result<ClientFrame<'_>, DecodeError> {
    use client_type as t;
    let (kind, session, mut r) = header(buf)?;
    let frame = match kind {
        t::HELLO => {
            connection_level(session)?;
            let version = r.u8()?;
            let caps = r.u8()?;
            ClientFrame::Hello { version, caps }
        }
        t::INPUT => {
            let data = r.rest();
            if data.len() > MAX_INPUT {
                return Err(DecodeError::TooLarge);
            }
            ClientFrame::Input {
                session: session_level(session)?,
                data,
            }
        }
        t::RESIZE => {
            let cols = dim(r.u16()?)?;
            let rows = dim(r.u16()?)?;
            ClientFrame::Resize {
                session: session_level(session)?,
                cols,
                rows,
            }
        }
        t::ATTACH => ClientFrame::Attach {
            last_offset: r.u64()?,
            session: session_level(session)?,
        },
        t::DETACH => ClientFrame::Detach {
            session: session_level(session)?,
        },
        t::ACK => ClientFrame::Ack {
            offset: r.u64()?,
            session: session_level(session)?,
        },
        t::PING => {
            connection_level(session)?;
            ClientFrame::Ping {
                client_micros: r.u64()?,
            }
        }
        t::PREVIEW => ClientFrame::Preview {
            session: session_level(session)?,
        },
        t::HISTORY_REQUEST => {
            let req_id = r.u16()?;
            let epoch = r.u32()?;
            let before_row = r.u64()?;
            let max_rows = r.u16()?;
            if max_rows == 0 || max_rows > MAX_HISTORY_ROWS {
                return Err(DecodeError::BadValue);
            }
            ClientFrame::HistoryRequest {
                session: session_level(session)?,
                req_id,
                epoch,
                before_row,
                max_rows,
            }
        }
        other => return Err(DecodeError::UnknownType(other)),
    };
    r.end()?;
    Ok(frame)
}

/// Decode one daemon frame (used by the headless client).
pub fn decode_server(buf: &[u8]) -> Result<ServerFrame<'_>, DecodeError> {
    use server_type as t;
    let (kind, session, mut r) = header(buf)?;
    let frame = match kind {
        t::HELLO => {
            connection_level(session)?;
            let version = r.u8()?;
            let max_frame = r.u32()?;
            let caps = if r.buf.is_empty() {
                None
            } else {
                Some(r.u8()?)
            };
            ServerFrame::Hello {
                version,
                max_frame,
                caps,
            }
        }
        t::OUTPUT => ServerFrame::Output {
            session: session_level(session)?,
            offset: r.u64()?,
            data: r.rest(),
        },
        t::SNAPSHOT | t::PREVIEW => {
            let offset = r.u64()?;
            let cols = dim(r.u16()?)?;
            let rows = dim(r.u16()?)?;
            let alt_screen = flag(r.u8()?)?;
            let session = session_level(session)?;
            let vt = r.rest();
            if kind == t::SNAPSHOT {
                ServerFrame::Snapshot {
                    session,
                    offset,
                    cols,
                    rows,
                    alt_screen,
                    vt,
                }
            } else {
                ServerFrame::Preview {
                    session,
                    offset,
                    cols,
                    rows,
                    alt_screen,
                    vt,
                }
            }
        }
        t::LIVE_SNAPSHOT => {
            let offset = r.u64()?;
            let cols = dim(r.u16()?)?;
            let rows = dim(r.u16()?)?;
            let epoch = r.u32()?;
            let history_end = r.u64()?;
            let tail_rows = r.u16()?;
            let (part, parts) = parts(&mut r)?;
            ServerFrame::LiveSnapshot {
                session: session_level(session)?,
                offset,
                cols,
                rows,
                epoch,
                history_end,
                tail_rows,
                part,
                parts,
                vt: r.rest(),
            }
        }
        t::HISTORY => {
            let req_id = r.u16()?;
            let epoch = r.u32()?;
            let first_row = r.u64()?;
            let row_count = r.u16()?;
            let (part, parts) = parts(&mut r)?;
            let at_start = flag(r.u8()?)?;
            ServerFrame::History {
                session: session_level(session)?,
                req_id,
                epoch,
                first_row,
                row_count,
                part,
                parts,
                at_start,
                vt: r.rest(),
            }
        }
        t::HISTORY_ERROR => ServerFrame::HistoryError {
            session: session_level(session)?,
            req_id: r.u16()?,
            code: r.u8()?,
        },
        t::EXIT => ServerFrame::Exit {
            session: session_level(session)?,
            code: r.i32()?,
            signal: r.u8()?,
        },
        t::PONG => {
            connection_level(session)?;
            ServerFrame::Pong {
                client_micros: r.u64()?,
            }
        }
        t::ERROR => {
            let code = r.u16()?;
            let message = std::str::from_utf8(r.rest()).map_err(|_| DecodeError::BadValue)?;
            ServerFrame::Error {
                session,
                code,
                message,
            }
        }
        other => return Err(DecodeError::UnknownType(other)),
    };
    r.end()?;
    Ok(frame)
}

fn flag(v: u8) -> Result<bool, DecodeError> {
    match v {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(DecodeError::BadValue),
    }
}

/// `part u8` · `parts u8`, with `part < parts`.
fn parts(r: &mut Reader<'_>) -> Result<(u8, u8), DecodeError> {
    let part = r.u8()?;
    let parts = r.u8()?;
    if parts == 0 || part >= parts {
        return Err(DecodeError::BadValue);
    }
    Ok((part, parts))
}

fn put_header(out: &mut Vec<u8>, kind: u8, session: u32) {
    out.push(kind);
    out.extend_from_slice(&session.to_be_bytes());
}

/// Exact encoded size of a daemon frame.
pub fn server_frame_len(frame: &ServerFrame<'_>) -> usize {
    HEADER_LEN
        + match frame {
            ServerFrame::Hello { caps, .. } => 1 + 4 + usize::from(caps.is_some()),
            ServerFrame::Output { data, .. } => 8 + data.len(),
            ServerFrame::Snapshot { vt, .. } | ServerFrame::Preview { vt, .. } => {
                SNAPSHOT_HEADER_LEN - HEADER_LEN + vt.len()
            }
            ServerFrame::LiveSnapshot { vt, .. } => {
                LIVE_SNAPSHOT_HEADER_LEN - HEADER_LEN + vt.len()
            }
            ServerFrame::History { vt, .. } => HISTORY_HEADER_LEN - HEADER_LEN + vt.len(),
            ServerFrame::HistoryError { .. } => 2 + 1,
            ServerFrame::Exit { .. } => 4 + 1,
            ServerFrame::Pong { .. } => 8,
            ServerFrame::Error { message, .. } => 2 + message.len(),
        }
}

/// Append one daemon frame to `out`. Callers keep payloads within
/// `MAX_OUTPUT_DATA` / `MAX_SNAPSHOT_VT`; an `Error` message is truncated at a
/// character boundary so the frame always fits.
pub fn encode_server(frame: &ServerFrame<'_>, out: &mut Vec<u8>) {
    use server_type as t;
    match frame {
        ServerFrame::Hello {
            version,
            max_frame,
            caps,
        } => {
            put_header(out, t::HELLO, 0);
            out.push(*version);
            out.extend_from_slice(&max_frame.to_be_bytes());
            if let Some(caps) = caps {
                out.push(*caps);
            }
        }
        ServerFrame::Output {
            session,
            offset,
            data,
        } => {
            put_header(out, t::OUTPUT, *session);
            out.extend_from_slice(&offset.to_be_bytes());
            out.extend_from_slice(data);
        }
        ServerFrame::Snapshot {
            session,
            offset,
            cols,
            rows,
            alt_screen,
            vt,
        }
        | ServerFrame::Preview {
            session,
            offset,
            cols,
            rows,
            alt_screen,
            vt,
        } => {
            let kind = if matches!(frame, ServerFrame::Snapshot { .. }) {
                t::SNAPSHOT
            } else {
                t::PREVIEW
            };
            put_header(out, kind, *session);
            out.extend_from_slice(&offset.to_be_bytes());
            out.extend_from_slice(&cols.to_be_bytes());
            out.extend_from_slice(&rows.to_be_bytes());
            out.push(u8::from(*alt_screen));
            out.extend_from_slice(vt);
        }
        ServerFrame::LiveSnapshot {
            session,
            offset,
            cols,
            rows,
            epoch,
            history_end,
            tail_rows,
            part,
            parts,
            vt,
        } => {
            put_header(out, t::LIVE_SNAPSHOT, *session);
            out.extend_from_slice(&offset.to_be_bytes());
            out.extend_from_slice(&cols.to_be_bytes());
            out.extend_from_slice(&rows.to_be_bytes());
            out.extend_from_slice(&epoch.to_be_bytes());
            out.extend_from_slice(&history_end.to_be_bytes());
            out.extend_from_slice(&tail_rows.to_be_bytes());
            out.push(*part);
            out.push(*parts);
            out.extend_from_slice(vt);
        }
        ServerFrame::History {
            session,
            req_id,
            epoch,
            first_row,
            row_count,
            part,
            parts,
            at_start,
            vt,
        } => {
            put_header(out, t::HISTORY, *session);
            out.extend_from_slice(&req_id.to_be_bytes());
            out.extend_from_slice(&epoch.to_be_bytes());
            out.extend_from_slice(&first_row.to_be_bytes());
            out.extend_from_slice(&row_count.to_be_bytes());
            out.push(*part);
            out.push(*parts);
            out.push(u8::from(*at_start));
            out.extend_from_slice(vt);
        }
        ServerFrame::HistoryError {
            session,
            req_id,
            code,
        } => {
            put_header(out, t::HISTORY_ERROR, *session);
            out.extend_from_slice(&req_id.to_be_bytes());
            out.push(*code);
        }
        ServerFrame::Exit {
            session,
            code,
            signal,
        } => {
            put_header(out, t::EXIT, *session);
            out.extend_from_slice(&code.to_be_bytes());
            out.push(*signal);
        }
        ServerFrame::Pong { client_micros } => {
            put_header(out, t::PONG, 0);
            out.extend_from_slice(&client_micros.to_be_bytes());
        }
        ServerFrame::Error {
            session,
            code,
            message,
        } => {
            put_header(out, t::ERROR, *session);
            out.extend_from_slice(&code.to_be_bytes());
            out.extend_from_slice(truncate_utf8(message, MAX_FRAME - HEADER_LEN - 2).as_bytes());
        }
    }
}

/// Append one client frame to `out` (used by the headless client).
pub fn encode_client(frame: &ClientFrame<'_>, out: &mut Vec<u8>) {
    use client_type as t;
    match frame {
        ClientFrame::Hello { version, caps } => {
            put_header(out, t::HELLO, 0);
            out.push(*version);
            out.push(*caps);
        }
        ClientFrame::Input { session, data } => {
            put_header(out, t::INPUT, *session);
            out.extend_from_slice(data);
        }
        ClientFrame::Resize {
            session,
            cols,
            rows,
        } => {
            put_header(out, t::RESIZE, *session);
            out.extend_from_slice(&cols.to_be_bytes());
            out.extend_from_slice(&rows.to_be_bytes());
        }
        ClientFrame::Attach {
            session,
            last_offset,
        } => {
            put_header(out, t::ATTACH, *session);
            out.extend_from_slice(&last_offset.to_be_bytes());
        }
        ClientFrame::Detach { session } => put_header(out, t::DETACH, *session),
        ClientFrame::Ack { session, offset } => {
            put_header(out, t::ACK, *session);
            out.extend_from_slice(&offset.to_be_bytes());
        }
        ClientFrame::Ping { client_micros } => {
            put_header(out, t::PING, 0);
            out.extend_from_slice(&client_micros.to_be_bytes());
        }
        ClientFrame::Preview { session } => put_header(out, t::PREVIEW, *session),
        ClientFrame::HistoryRequest {
            session,
            req_id,
            epoch,
            before_row,
            max_rows,
        } => {
            put_header(out, t::HISTORY_REQUEST, *session);
            out.extend_from_slice(&req_id.to_be_bytes());
            out.extend_from_slice(&epoch.to_be_bytes());
            out.extend_from_slice(&before_row.to_be_bytes());
            out.extend_from_slice(&max_rows.to_be_bytes());
        }
    }
}

fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client_round_trip(f: ClientFrame<'_>) {
        let mut buf = Vec::new();
        encode_client(&f, &mut buf);
        assert_eq!(decode_client(&buf), Ok(f));
    }

    fn server_round_trip(f: ServerFrame<'_>) {
        let mut buf = Vec::new();
        encode_server(&f, &mut buf);
        assert_eq!(buf.len(), server_frame_len(&f));
        assert_eq!(decode_server(&buf), Ok(f));
    }

    #[test]
    fn client_frames_round_trip() {
        client_round_trip(ClientFrame::Hello {
            version: 1,
            caps: 0,
        });
        client_round_trip(ClientFrame::Input {
            session: 7,
            data: b"ls -la\r",
        });
        client_round_trip(ClientFrame::Input {
            session: 7,
            data: &[0u8; MAX_INPUT],
        });
        client_round_trip(ClientFrame::Resize {
            session: 1,
            cols: 1000,
            rows: 1,
        });
        client_round_trip(ClientFrame::Attach {
            session: u32::MAX,
            last_offset: u64::MAX,
        });
        client_round_trip(ClientFrame::Detach { session: 3 });
        client_round_trip(ClientFrame::Ack {
            session: 3,
            offset: 1 << 40,
        });
        client_round_trip(ClientFrame::Ping {
            client_micros: 123_456_789,
        });
        client_round_trip(ClientFrame::Preview { session: 3 });
        client_round_trip(ClientFrame::HistoryRequest {
            session: 3,
            req_id: 65535,
            epoch: 7,
            before_row: 1 << 40,
            max_rows: MAX_HISTORY_ROWS,
        });
    }

    #[test]
    fn server_frames_round_trip() {
        server_round_trip(ServerFrame::Hello {
            version: 1,
            max_frame: MAX_FRAME as u32,
            caps: None,
        });
        server_round_trip(ServerFrame::Hello {
            version: 1,
            max_frame: MAX_FRAME as u32,
            caps: Some(CAP_LIVE_HISTORY),
        });
        server_round_trip(ServerFrame::LiveSnapshot {
            session: 2,
            offset: 1 << 33,
            cols: 120,
            rows: 40,
            epoch: 3,
            history_end: 9000,
            tail_rows: 40,
            part: 1,
            parts: 2,
            vt: b"\x1bc rows",
        });
        server_round_trip(ServerFrame::History {
            session: 2,
            req_id: 9,
            epoch: 3,
            first_row: 0,
            row_count: 2,
            part: 0,
            parts: 1,
            at_start: true,
            vt: b"a\x1b[m\r\nb\x1b[m\r\n",
        });
        server_round_trip(ServerFrame::HistoryError {
            session: 2,
            req_id: 9,
            code: history_error::BUSY,
        });
        server_round_trip(ServerFrame::Output {
            session: 2,
            offset: 99,
            data: &[b'y'; MAX_OUTPUT_DATA],
        });
        server_round_trip(ServerFrame::Snapshot {
            session: 2,
            offset: 5,
            cols: 80,
            rows: 24,
            alt_screen: true,
            vt: b"\x1bc\x1b[Hhi",
        });
        server_round_trip(ServerFrame::Preview {
            session: 2,
            offset: 7,
            cols: 100,
            rows: 30,
            alt_screen: false,
            vt: b"c[Hlatest",
        });
        server_round_trip(ServerFrame::Exit {
            session: 2,
            code: -1,
            signal: 9,
        });
        server_round_trip(ServerFrame::Pong { client_micros: 42 });
        server_round_trip(ServerFrame::Error {
            session: 0,
            code: error_code::REVOKED,
            message: "thiết bị đã bị thu hồi",
        });
        let mut max = Vec::new();
        encode_server(
            &ServerFrame::Output {
                session: 1,
                offset: 0,
                data: &[0; MAX_OUTPUT_DATA],
            },
            &mut max,
        );
        assert_eq!(max.len(), MAX_FRAME);
    }

    #[test]
    fn truncated_frames_are_bad_length() {
        let mut buf = Vec::new();
        encode_client(
            &ClientFrame::Ack {
                session: 1,
                offset: 10,
            },
            &mut buf,
        );
        for n in 0..buf.len() {
            assert_eq!(
                decode_client(&buf[..n]),
                Err(DecodeError::BadLength),
                "len {n}"
            );
        }
        let mut extra = buf.clone();
        extra.push(0);
        assert_eq!(decode_client(&extra), Err(DecodeError::BadLength));
    }

    #[test]
    fn oversized_frames_are_rejected() {
        let mut input = vec![client_type::INPUT, 0, 0, 0, 1];
        input.extend_from_slice(&[0; MAX_INPUT + 1]);
        assert_eq!(decode_client(&input), Err(DecodeError::TooLarge));
        let huge = vec![client_type::INPUT; MAX_FRAME + 1];
        assert_eq!(decode_client(&huge), Err(DecodeError::TooLarge));
        assert_eq!(decode_server(&huge), Err(DecodeError::TooLarge));
    }

    #[test]
    fn unknown_types_are_reported_for_ignoring() {
        assert_eq!(
            decode_client(&[0x7e, 0, 0, 0, 0, 1, 2]),
            Err(DecodeError::UnknownType(0x7e))
        );
        assert_eq!(
            decode_server(&[0x01, 0, 0, 0, 0]),
            Err(DecodeError::UnknownType(0x01))
        );
    }

    #[test]
    fn out_of_range_values_are_rejected() {
        let mut resize = Vec::new();
        encode_client(
            &ClientFrame::Resize {
                session: 1,
                cols: 0,
                rows: 24,
            },
            &mut resize,
        );
        assert_eq!(decode_client(&resize), Err(DecodeError::BadValue));
        let mut big = Vec::new();
        encode_client(
            &ClientFrame::Resize {
                session: 1,
                cols: 80,
                rows: 1001,
            },
            &mut big,
        );
        assert_eq!(decode_client(&big), Err(DecodeError::BadValue));
        // Input for session 0 and Ping for a session are malformed.
        assert_eq!(
            decode_client(&[client_type::INPUT, 0, 0, 0, 0, b'a']),
            Err(DecodeError::BadValue)
        );
        let mut ping = vec![client_type::PING, 0, 0, 0, 1];
        ping.extend_from_slice(&[0; 8]);
        assert_eq!(decode_client(&ping), Err(DecodeError::BadValue));
        // Error with invalid UTF-8.
        assert_eq!(
            decode_server(&[server_type::ERROR, 0, 0, 0, 0, 0, 3, 0xff]),
            Err(DecodeError::BadValue)
        );
    }

    #[test]
    fn hello_is_five_bytes_unless_the_client_set_a_capability() {
        let mut old = Vec::new();
        encode_server(
            &ServerFrame::Hello {
                version: VERSION,
                max_frame: MAX_FRAME as u32,
                caps: None,
            },
            &mut old,
        );
        assert_eq!(old.len(), HEADER_LEN + 5);
        let mut new = Vec::new();
        encode_server(
            &ServerFrame::Hello {
                version: VERSION,
                max_frame: MAX_FRAME as u32,
                caps: Some(CAP_LIVE_HISTORY),
            },
            &mut new,
        );
        assert_eq!(new.len(), HEADER_LEN + 6);
        new.push(0);
        assert_eq!(decode_server(&new), Err(DecodeError::BadLength));
    }

    #[test]
    fn history_request_bounds() {
        let mut buf = Vec::new();
        let req = |max_rows, session| ClientFrame::HistoryRequest {
            session,
            req_id: 1,
            epoch: 0,
            before_row: 10,
            max_rows,
        };
        for bad in [0, MAX_HISTORY_ROWS + 1, u16::MAX] {
            buf.clear();
            encode_client(&req(bad, 1), &mut buf);
            assert_eq!(decode_client(&buf), Err(DecodeError::BadValue), "{bad}");
        }
        buf.clear();
        encode_client(&req(1, 0), &mut buf);
        assert_eq!(decode_client(&buf), Err(DecodeError::BadValue));
        buf.clear();
        encode_client(&req(1, 1), &mut buf);
        buf.push(0);
        assert_eq!(decode_client(&buf), Err(DecodeError::BadLength));
    }

    #[test]
    fn parts_and_flags_are_checked() {
        let frame = |part, parts| ServerFrame::LiveSnapshot {
            session: 1,
            offset: 0,
            cols: 80,
            rows: 24,
            epoch: 0,
            history_end: 0,
            tail_rows: 0,
            part,
            parts,
            vt: b"",
        };
        for (part, parts) in [(0, 0), (1, 1), (5, 2)] {
            let mut buf = Vec::new();
            encode_server(&frame(part, parts), &mut buf);
            assert_eq!(decode_server(&buf), Err(DecodeError::BadValue));
        }
        let mut hist = Vec::new();
        encode_server(
            &ServerFrame::History {
                session: 1,
                req_id: 0,
                epoch: 0,
                first_row: 0,
                row_count: 0,
                part: 0,
                parts: 1,
                at_start: true,
                vt: b"",
            },
            &mut hist,
        );
        hist[HISTORY_HEADER_LEN - 1] = 2;
        assert_eq!(decode_server(&hist), Err(DecodeError::BadValue));
    }

    #[test]
    fn largest_parts_fill_a_frame_exactly() {
        let vt = vec![b'x'; MAX_LIVE_SNAPSHOT_VT];
        let live = ServerFrame::LiveSnapshot {
            session: 1,
            offset: 0,
            cols: 80,
            rows: 24,
            epoch: 0,
            history_end: 0,
            tail_rows: 0,
            part: 0,
            parts: 1,
            vt: &vt,
        };
        assert_eq!(server_frame_len(&live), MAX_FRAME);
        server_round_trip(live);
        let vt = vec![b'y'; MAX_HISTORY_VT];
        let hist = ServerFrame::History {
            session: 1,
            req_id: 0,
            epoch: 0,
            first_row: 0,
            row_count: 1,
            part: 0,
            parts: 1,
            at_start: true,
            vt: &vt,
        };
        assert_eq!(server_frame_len(&hist), MAX_FRAME);
        server_round_trip(hist);
    }

    #[test]
    fn decoding_garbage_never_panics() {
        // Deterministic pseudo-random fuzz over every type byte and short lengths.
        let mut seed: u64 = 0x9e37_79b9_7f4a_7c15;
        for _ in 0..20_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let len = (seed % 40) as usize;
            let mut buf: Vec<u8> = (0..len).map(|i| (seed >> (i % 8 * 8)) as u8).collect();
            if let Some(first) = buf.first_mut() {
                *first = (seed >> 3) as u8;
            }
            let _ = decode_client(&buf);
            let _ = decode_server(&buf);
        }
    }

    #[test]
    fn error_messages_are_truncated_on_char_boundary() {
        let long = "ă".repeat(MAX_FRAME);
        let mut buf = Vec::new();
        encode_server(
            &ServerFrame::Error {
                session: 0,
                code: 3,
                message: &long,
            },
            &mut buf,
        );
        assert!(buf.len() <= MAX_FRAME);
        assert!(matches!(decode_server(&buf), Ok(ServerFrame::Error { .. })));
    }
}
