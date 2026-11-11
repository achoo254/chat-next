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
}

pub mod server_type {
    pub const HELLO: u8 = 0x81;
    pub const OUTPUT: u8 = 0x90;
    pub const SNAPSHOT: u8 = 0x91;
    pub const EXIT: u8 = 0x92;
    pub const PONG: u8 = 0x95;
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

/// A frame sent by a client to the daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientFrame<'a> {
    Hello { version: u8, caps: u8 },
    Input { session: u32, data: &'a [u8] },
    Resize { session: u32, cols: u16, rows: u16 },
    Attach { session: u32, last_offset: u64 },
    Detach { session: u32 },
    Ack { session: u32, offset: u64 },
    Ping { client_micros: u64 },
}

/// A frame sent by the daemon to a client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerFrame<'a> {
    Hello {
        version: u8,
        max_frame: u32,
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
            ServerFrame::Hello {
                version: r.u8()?,
                max_frame: r.u32()?,
            }
        }
        t::OUTPUT => ServerFrame::Output {
            session: session_level(session)?,
            offset: r.u64()?,
            data: r.rest(),
        },
        t::SNAPSHOT => {
            let offset = r.u64()?;
            let cols = dim(r.u16()?)?;
            let rows = dim(r.u16()?)?;
            let alt_screen = match r.u8()? {
                0 => false,
                1 => true,
                _ => return Err(DecodeError::BadValue),
            };
            ServerFrame::Snapshot {
                session: session_level(session)?,
                offset,
                cols,
                rows,
                alt_screen,
                vt: r.rest(),
            }
        }
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

fn put_header(out: &mut Vec<u8>, kind: u8, session: u32) {
    out.push(kind);
    out.extend_from_slice(&session.to_be_bytes());
}

/// Exact encoded size of a daemon frame.
pub fn server_frame_len(frame: &ServerFrame<'_>) -> usize {
    HEADER_LEN
        + match frame {
            ServerFrame::Hello { .. } => 1 + 4,
            ServerFrame::Output { data, .. } => 8 + data.len(),
            ServerFrame::Snapshot { vt, .. } => SNAPSHOT_HEADER_LEN - HEADER_LEN + vt.len(),
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
        ServerFrame::Hello { version, max_frame } => {
            put_header(out, t::HELLO, 0);
            out.push(*version);
            out.extend_from_slice(&max_frame.to_be_bytes());
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
        } => {
            put_header(out, t::SNAPSHOT, *session);
            out.extend_from_slice(&offset.to_be_bytes());
            out.extend_from_slice(&cols.to_be_bytes());
            out.extend_from_slice(&rows.to_be_bytes());
            out.push(u8::from(*alt_screen));
            out.extend_from_slice(vt);
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
    }

    #[test]
    fn server_frames_round_trip() {
        server_round_trip(ServerFrame::Hello {
            version: 1,
            max_frame: MAX_FRAME as u32,
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
