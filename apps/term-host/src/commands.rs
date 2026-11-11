//! Parsing and validation of agent commands (section 6). Everything coming
//! from the control socket is checked here before the hub acts on it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::conn::DeviceKey;
use crate::control::token_matches;
use crate::pty::OpenSpec;
use crate::wire::{MAX_DIM, MIN_DIM};

pub const MAJOR: u64 = 1;
/// 1: `hello` lists the live connections (`connections`).
pub const MINOR: u64 = 1;
/// Default lifetime of a grant without a transport.
pub const DEFAULT_GRANT_MS: u64 = 60_000;
pub const MAX_GRANT_MS: u64 = 600_000;
const MAX_STRING: usize = 4096;
const MAX_ARGS: usize = 64;
const MAX_SIGNAL_TEXT: usize = 64 * 1024;
const MAX_REVOKED: usize = 10_000;

/// Error codes of section 6.
pub mod code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const SESSION_LIMIT: &str = "session_limit";
    pub const NO_SUCH_SESSION: &str = "no_such_session";
    pub const NO_SUCH_CONN: &str = "no_such_conn";
    pub const REVOKED: &str = "revoked";
    pub const VERSION_MISMATCH: &str = "version_mismatch";
    pub const INTERNAL: &str = "internal";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdError {
    pub code: &'static str,
    pub message: String,
}

fn bad(message: impl Into<String>) -> CmdError {
    CmdError {
        code: code::BAD_REQUEST,
        message: message.into(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalKind {
    Offer,
    Candidate,
    End,
}

#[derive(Debug)]
pub enum Command {
    Open(OpenSpec),
    Close {
        session: u32,
    },
    Resize {
        session: u32,
        cols: u16,
        rows: u16,
    },
    List,
    Grant {
        conn: u32,
        key: DeviceKey,
        expires_ms: u64,
    },
    Signal {
        conn: u32,
        kind: SignalKind,
        /// The offer SDP (`offer` only).
        sdp: Option<String>,
        /// One `candidate:...` line (`candidate` only; empty = end).
        candidate: Option<String>,
    },
    RelayOpen {
        conn: u32,
    },
    ConnClose {
        conn: u32,
    },
    RevokeDevice {
        key: DeviceKey,
    },
    SetRevoked {
        keys: Vec<DeviceKey>,
    },
    AckAudit {
        up_to: u64,
    },
    Shutdown,
    /// `hello` after the handshake.
    Hello,
}

#[derive(Debug, Clone)]
pub struct HelloParams {
    pub minor: u64,
    pub agent_version: String,
}

/// Why a first command was refused (the connection is closed after it).
#[derive(Debug, Clone)]
pub enum HelloReject {
    NotHello,
    BadToken(Value),
    Version(Value),
}

impl HelloReject {
    pub fn id(&self) -> Value {
        match self {
            HelloReject::NotHello => Value::Null,
            HelloReject::BadToken(id) | HelloReject::Version(id) => id.clone(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            HelloReject::Version(_) => code::VERSION_MISMATCH,
            _ => code::UNAUTHORIZED,
        }
    }

    /// Text safe for logs and replies: never contains the token.
    pub fn reason(&self) -> &'static str {
        match self {
            HelloReject::NotHello => "first command must be hello",
            HelloReject::BadToken(_) => "bad token",
            HelloReject::Version(_) => "unsupported major version",
        }
    }
}

/// Check the first command: `hello` with the right token and major.
pub fn parse_hello(body: &[u8], token: &str) -> Result<(Value, HelloParams), HelloReject> {
    let v: Value = serde_json::from_slice(body).map_err(|_| HelloReject::NotHello)?;
    let id = request_id(&v).ok_or(HelloReject::NotHello)?;
    if v.get("cmd").and_then(Value::as_str) != Some("hello") {
        return Err(HelloReject::NotHello);
    }
    let given = v.get("token").and_then(Value::as_str).unwrap_or("");
    if !token_matches(given, token) {
        return Err(HelloReject::BadToken(id));
    }
    let major = v.get("major").and_then(Value::as_u64);
    if major != Some(MAJOR) {
        return Err(HelloReject::Version(id));
    }
    let minor = v.get("minor").and_then(Value::as_u64).unwrap_or(0);
    let agent_version = v
        .get("agentVersion")
        .and_then(Value::as_str)
        .unwrap_or("")
        .chars()
        .take(64)
        .collect();
    Ok((
        id,
        HelloParams {
            minor,
            agent_version,
        },
    ))
}

/// A request id must be an integer; anything else cannot be answered.
fn request_id(v: &Value) -> Option<Value> {
    let id = v.get("id")?;
    if id.is_i64() || id.is_u64() {
        Some(id.clone())
    } else {
        None
    }
}

/// Parse a command. Returns the id to answer with (null if unusable) and the
/// command or the error to reply.
pub fn parse(body: &[u8]) -> (Value, Result<Command, CmdError>) {
    let v: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return (Value::Null, Err(bad("invalid JSON"))),
    };
    let Some(id) = request_id(&v) else {
        return (Value::Null, Err(bad("id must be an integer")));
    };
    let Some(cmd) = v.get("cmd").and_then(Value::as_str) else {
        return (id, Err(bad("cmd must be a string")));
    };
    let result = match cmd {
        "hello" => Ok(Command::Hello),
        "open" => params::<OpenP>(&v).and_then(open_spec).map(Command::Open),
        "close" => params::<SessionP>(&v).map(|p| Command::Close { session: p.session }),
        "resize" => params::<ResizeP>(&v).and_then(|p| {
            Ok(Command::Resize {
                session: p.session,
                cols: dim(p.cols, "cols")?,
                rows: dim(p.rows, "rows")?,
            })
        }),
        "list" => Ok(Command::List),
        "grant" => params::<GrantP>(&v).and_then(|p| {
            let expires_ms = p.expires_ms.unwrap_or(DEFAULT_GRANT_MS);
            if !(1..=MAX_GRANT_MS).contains(&expires_ms) {
                return Err(bad(format!("expiresMs must be 1..={MAX_GRANT_MS}")));
            }
            Ok(Command::Grant {
                conn: p.conn,
                key: device_key(&p.device_key)?,
                expires_ms,
            })
        }),
        "signal" => params::<SignalP>(&v).and_then(|p| {
            let kind = match p.kind.as_str() {
                "offer" => SignalKind::Offer,
                "candidate" => SignalKind::Candidate,
                "end" => SignalKind::End,
                _ => return Err(bad("kind must be offer, candidate or end")),
            };
            for text in [&p.sdp, &p.candidate].into_iter().flatten() {
                if text.len() > MAX_SIGNAL_TEXT || text.contains('\0') {
                    return Err(bad("signal text too long or contains NUL"));
                }
            }
            match kind {
                SignalKind::Offer if p.sdp.as_deref().is_none_or(str::is_empty) => {
                    return Err(bad("offer needs sdp"))
                }
                SignalKind::Candidate if p.candidate.is_none() => {
                    return Err(bad("candidate needs candidate"))
                }
                _ => {}
            }
            Ok(Command::Signal {
                conn: p.conn,
                kind,
                sdp: p.sdp,
                candidate: p.candidate,
            })
        }),
        "relay_open" => params::<ConnP>(&v).map(|p| Command::RelayOpen { conn: p.conn }),
        "conn_close" => params::<ConnP>(&v).map(|p| Command::ConnClose { conn: p.conn }),
        "revoke_device" => params::<KeyP>(&v).and_then(|p| {
            Ok(Command::RevokeDevice {
                key: device_key(&p.device_key)?,
            })
        }),
        "set_revoked" => params::<KeysP>(&v).and_then(|p| {
            if p.device_keys.len() > MAX_REVOKED {
                return Err(bad("too many deviceKeys"));
            }
            let keys = p
                .device_keys
                .iter()
                .map(|k| device_key(k))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Command::SetRevoked { keys })
        }),
        "ack_audit" => params::<AckP>(&v).map(|p| Command::AckAudit { up_to: p.up_to }),
        "shutdown" => Ok(Command::Shutdown),
        _ => Err(bad("unknown cmd")),
    };
    (id, result)
}

fn params<T: DeserializeOwned>(v: &Value) -> Result<T, CmdError> {
    T::deserialize(v).map_err(|e| bad(format!("bad parameters: {e}")))
}

fn dim(v: u32, name: &str) -> Result<u16, CmdError> {
    u16::try_from(v)
        .ok()
        .filter(|d| (MIN_DIM..=MAX_DIM).contains(d))
        .ok_or_else(|| bad(format!("{name} must be {MIN_DIM}..={MAX_DIM}")))
}

fn device_key(s: &str) -> Result<DeviceKey, CmdError> {
    DeviceKey::parse(s).ok_or_else(|| bad("deviceKey must be 32 bytes base64url"))
}

fn checked_text(s: &str, what: &str) -> Result<(), CmdError> {
    if s.is_empty() || s.len() > MAX_STRING || s.contains('\0') {
        Err(bad(format!(
            "{what} must be 1..={MAX_STRING} bytes without NUL"
        )))
    } else {
        Ok(())
    }
}

fn open_spec(p: OpenP) -> Result<OpenSpec, CmdError> {
    let cols = dim(p.cols, "cols")?;
    let rows = dim(p.rows, "rows")?;
    if let Some(shell) = &p.shell {
        checked_text(shell, "shell")?;
    }
    let args = p.args.unwrap_or_default();
    if args.len() > MAX_ARGS {
        return Err(bad("too many args"));
    }
    if p.shell.is_none() && !args.is_empty() {
        return Err(bad("args need shell"));
    }
    for a in &args {
        if a.len() > MAX_STRING || a.contains('\0') {
            return Err(bad("arg too long or contains NUL"));
        }
    }
    let cwd = match p.cwd {
        Some(c) => {
            checked_text(&c, "cwd")?;
            let path = PathBuf::from(c);
            if !path.is_absolute() || !path.is_dir() {
                return Err(bad("cwd must be an existing absolute directory"));
            }
            Some(path)
        }
        None => None,
    };
    let mut claude_config_dir = None;
    for (k, v) in p.env.unwrap_or_default() {
        if k != "CLAUDE_CONFIG_DIR" {
            return Err(bad("env only accepts CLAUDE_CONFIG_DIR"));
        }
        checked_text(&v, "CLAUDE_CONFIG_DIR")?;
        claude_config_dir = Some(v);
    }
    Ok(OpenSpec {
        cols,
        rows,
        shell: p.shell,
        args,
        cwd,
        claude_config_dir,
    })
}

#[derive(Deserialize)]
struct OpenP {
    cols: u32,
    rows: u32,
    shell: Option<String>,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    env: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize)]
struct SessionP {
    session: u32,
}

#[derive(Deserialize)]
struct ResizeP {
    session: u32,
    cols: u32,
    rows: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantP {
    conn: u32,
    device_key: String,
    expires_ms: Option<u64>,
}

#[derive(Deserialize)]
struct SignalP {
    conn: u32,
    kind: String,
    sdp: Option<String>,
    candidate: Option<String>,
}

#[derive(Deserialize)]
struct ConnP {
    conn: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyP {
    device_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeysP {
    device_keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckP {
    up_to: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(v: Value) -> (Value, Result<Command, CmdError>) {
        parse(v.to_string().as_bytes())
    }

    fn key() -> String {
        DeviceKey::parse(&"A".repeat(43))
            .map(|k| k.encode())
            .unwrap_or_default()
    }

    #[test]
    fn hello_requires_token_and_major() {
        let ok = json!({"id": 1, "cmd": "hello", "token": "t0k", "major": 1, "minor": 3, "agentVersion": "2.1"});
        let r = parse_hello(ok.to_string().as_bytes(), "t0k");
        assert!(matches!(
            r,
            Ok((Value::Number(_), HelloParams { minor: 3, .. }))
        ));
        let wrong = json!({"id": 1, "cmd": "hello", "token": "nope", "major": 1});
        assert!(matches!(
            parse_hello(wrong.to_string().as_bytes(), "t0k"),
            Err(HelloReject::BadToken(_))
        ));
        let missing = json!({"id": 1, "cmd": "hello", "major": 1});
        assert!(matches!(
            parse_hello(missing.to_string().as_bytes(), "t0k"),
            Err(HelloReject::BadToken(_))
        ));
        let major = json!({"id": 1, "cmd": "hello", "token": "t0k", "major": 2});
        assert!(matches!(
            parse_hello(major.to_string().as_bytes(), "t0k"),
            Err(HelloReject::Version(_))
        ));
        let list = json!({"id": 1, "cmd": "list", "token": "t0k"});
        assert!(matches!(
            parse_hello(list.to_string().as_bytes(), "t0k"),
            Err(HelloReject::NotHello)
        ));
        assert!(matches!(
            parse_hello(b"{not json", "t0k"),
            Err(HelloReject::NotHello)
        ));
        // The rejection text never echoes the token.
        assert!(!HelloReject::BadToken(Value::Null).reason().contains("nope"));
    }

    #[test]
    fn open_is_validated() {
        let (_, r) = p(json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24}));
        assert!(matches!(
            r,
            Ok(Command::Open(OpenSpec {
                cols: 80,
                rows: 24,
                ..
            }))
        ));
        for bad_open in [
            json!({"id": 1, "cmd": "open", "cols": 0, "rows": 24}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 1001}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "env": {"PATH": "/x"}}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "cwd": "relative"}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "cwd": "/definitely/not/here"}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "args": ["-c"]}),
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "shell": ""}),
            json!({"id": 1, "cmd": "open", "cols": "80", "rows": 24}),
        ] {
            let (_, r) = p(bad_open.clone());
            assert!(
                matches!(
                    &r,
                    Err(CmdError {
                        code: code::BAD_REQUEST,
                        ..
                    })
                ),
                "{bad_open}"
            );
        }
        let (_, r) = p(
            json!({"id": 1, "cmd": "open", "cols": 80, "rows": 24, "env": {"CLAUDE_CONFIG_DIR": "/tmp/c"}}),
        );
        assert!(matches!(
            r,
            Ok(Command::Open(OpenSpec {
                claude_config_dir: Some(_),
                ..
            }))
        ));
    }

    #[test]
    fn ids_and_unknown_commands() {
        assert_eq!(parse(b"garbage").0, Value::Null);
        let (id, r) = p(json!({"id": "x", "cmd": "list"}));
        assert_eq!(id, Value::Null);
        assert!(r.is_err());
        let (id, r) = p(json!({"id": 9, "cmd": "fly"}));
        assert_eq!(id, json!(9));
        assert!(matches!(
            r,
            Err(CmdError {
                code: code::BAD_REQUEST,
                ..
            })
        ));
    }

    #[test]
    fn grant_and_revocation_parameters() {
        let (_, r) = p(json!({"id": 1, "cmd": "grant", "conn": 4, "deviceKey": key()}));
        assert!(matches!(
            r,
            Ok(Command::Grant {
                conn: 4,
                expires_ms: DEFAULT_GRANT_MS,
                ..
            })
        ));
        let (_, r) = p(json!({"id": 1, "cmd": "grant", "conn": 4, "deviceKey": "short"}));
        assert!(r.is_err());
        let (_, r) =
            p(json!({"id": 1, "cmd": "grant", "conn": 4, "deviceKey": key(), "expiresMs": 0}));
        assert!(r.is_err());
        let (_, r) = p(json!({"id": 1, "cmd": "set_revoked", "deviceKeys": [key(), key()]}));
        assert!(matches!(r, Ok(Command::SetRevoked { keys }) if keys.len() == 2));
        let (_, r) = p(json!({"id": 1, "cmd": "set_revoked", "deviceKeys": ["bad"]}));
        assert!(r.is_err());
        let (_, r) = p(json!({"id": 1, "cmd": "signal", "conn": 1, "kind": "dance"}));
        assert!(r.is_err());
        let (_, r) = p(json!({"id": 1, "cmd": "signal", "conn": 1, "kind": "offer"}));
        assert!(r.is_err(), "offer without sdp");
        let (_, r) = p(json!({"id": 1, "cmd": "signal", "conn": 1, "kind": "candidate"}));
        assert!(r.is_err(), "candidate without candidate");
        let (_, r) =
            p(json!({"id": 1, "cmd": "signal", "conn": 1, "kind": "candidate", "candidate": ""}));
        assert!(matches!(
            r,
            Ok(Command::Signal {
                kind: SignalKind::Candidate,
                ..
            })
        ));
        let (_, r) = p(json!({"id": 1, "cmd": "signal", "conn": 1, "kind": "end"}));
        assert!(matches!(
            r,
            Ok(Command::Signal {
                kind: SignalKind::End,
                ..
            })
        ));
    }
}
