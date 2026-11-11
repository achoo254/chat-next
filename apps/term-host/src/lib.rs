//! `tunelo-term-host`: the daemon that holds the PTYs of remote terminals.
//!
//! Spec: `docs/terminal-wire.md` (terminal frames and the local control
//! protocol). Threads and channels only, no async runtime:
//! - one hub thread owns all state (`hub`),
//! - one listener thread accepts control connections (`control`),
//! - each agent link has a reader and a writer thread,
//! - each session has PTY reader, writer and waiter threads (`pty`),
//! - each direct (WebRTC) peer has one thread driving `str0m` plus one
//!   reader thread per local UDP socket (`rtc`, `nic`).

pub mod audit;
#[cfg(unix)]
pub mod client;
pub mod commands;
pub mod conn;
pub mod control;
pub mod flow;
mod home;
mod hub;
pub mod nic;
pub mod pty;
pub mod ring;
pub mod rtc;
pub mod screen;
pub mod session;
pub mod wire;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crossbeam_channel::Sender;
use serde_json::json;

use control::ControlMsg;
pub use home::{HomeError, CONTROL_FILE, DIR_NAME};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Exit after this long with no session and no connection.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// Where log lines go. Lines never contain terminal input or output.
#[derive(Clone)]
pub struct Logger(Arc<dyn Fn(&str) + Send + Sync>);

impl Logger {
    pub fn new(f: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Logger(Arc::new(f))
    }

    pub fn stderr() -> Self {
        Logger::new(|line| eprintln!("tunelo-term-host: {line}"))
    }

    pub fn info(&self, msg: &str) {
        (self.0)(msg);
    }

    pub fn warn(&self, msg: &str) {
        (self.0)(&format!("warning: {msg}"));
    }
}

pub struct Config {
    /// The tunelo config dir (`TUNELO_HOME`); state lives in `term-host/`.
    pub home: PathBuf,
    pub ring_bytes: usize,
    pub idle_timeout: Duration,
    pub max_sessions: usize,
    /// STUN servers (`host:port`) for server-reflexive candidates; empty
    /// for none. Default [`nic::DEFAULT_STUN`].
    pub stun_servers: Vec<String>,
    /// Offer loopback addresses on the direct path. Tests only: browsers
    /// such as WebKit refuse them and real clients are never local.
    pub allow_loopback: bool,
    pub logger: Logger,
}

impl Config {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Config {
            home: home.into(),
            ring_bytes: session::DEFAULT_RING_BYTES,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_sessions: session::MAX_SESSIONS,
            stun_servers: vec![nic::DEFAULT_STUN.to_string()],
            allow_loopback: false,
            logger: Logger::stderr(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitReason {
    /// Signal or `Stopper::stop`.
    Stopped,
    ShutdownCommand,
    Idle,
}

impl fmt::Display for ExitReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ExitReason::Stopped => "stop requested",
            ExitReason::ShutdownCommand => "shutdown command",
            ExitReason::Idle => "idle",
        })
    }
}

#[derive(Debug)]
pub enum StartError {
    AlreadyRunning,
    Home(String),
    Io(std::io::Error),
}

impl fmt::Display for StartError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StartError::AlreadyRunning => {
                f.write_str("another daemon already runs for this config dir")
            }
            StartError::Home(m) => write!(f, "config dir: {m}"),
            StartError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl From<HomeError> for StartError {
    fn from(e: HomeError) -> Self {
        match e {
            HomeError::AlreadyRunning => StartError::AlreadyRunning,
            HomeError::NotPrivate(m) => StartError::Home(m),
            HomeError::Io(e) => StartError::Io(e),
        }
    }
}

/// Requests a clean stop from another thread (signal handlers, embedders).
#[derive(Clone)]
pub struct Stopper(Sender<ControlMsg>);

impl Stopper {
    pub fn stop(&self) {
        let _ = self.0.send(ControlMsg::Stop);
    }
}

/// A running daemon.
pub struct Daemon {
    hub: JoinHandle<ExitReason>,
    listener: JoinHandle<()>,
    stopper: Stopper,
    stopping: Arc<AtomicBool>,
    endpoint: PathBuf,
    home: home::Home,
    log: Logger,
}

impl Daemon {
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// `<home>/term-host`.
    pub fn state_dir(&self) -> &Path {
        self.home.dir()
    }

    /// Wait for the daemon to exit, then remove its endpoint and lock.
    pub fn wait(self) -> ExitReason {
        let reason = self.hub.join().unwrap_or(ExitReason::Stopped);
        self.stopping.store(true, Ordering::SeqCst);
        // Unblock the listener's accept.
        let _ = control::connect(&self.endpoint);
        let _ = self.listener.join();
        self.home.remove_endpoint();
        self.log.info(&format!("exited ({reason})"));
        reason
    }
}

/// Take the config dir, open the control endpoint and start serving.
pub fn start(config: Config) -> Result<Daemon, StartError> {
    let log = config.logger.clone();
    let home = home::take(&config.home)?;
    let token: Arc<str> = home::random_hex(32).map_err(StartError::Io)?.into();

    #[cfg(unix)]
    let (mut listener, endpoint, endpoint_field) = {
        let path = home.dir().join(home::SOCKET_FILE);
        let l = control::Listener::bind(&path).map_err(StartError::Io)?;
        let field = json!({ "socket": path.to_string_lossy() });
        (l, path, field)
    };
    #[cfg(windows)]
    let (mut listener, endpoint, endpoint_field) = {
        let name = format!(
            "tunelo-term-host-{}",
            home::random_hex(16).map_err(StartError::Io)?
        );
        let l = control::Listener::bind_pipe(&name).map_err(StartError::Io)?;
        let path = PathBuf::from(format!(r"\\.\pipe\{name}"));
        let field = json!({ "pipe": path.to_string_lossy() });
        (l, path, field)
    };

    let mut info = json!({
        "token": &*token,
        "pid": std::process::id(),
        "major": commands::MAJOR,
        "minor": commands::MINOR,
        "daemonVersion": VERSION,
    });
    if let (Some(obj), Some(extra)) = (info.as_object_mut(), endpoint_field.as_object()) {
        obj.extend(extra.clone());
    }
    home.write_control(&info).map_err(StartError::Io)?;

    let (control_tx, control_rx) = crossbeam_channel::unbounded();
    let hub = hub::Hub::new(
        hub::HubConfig {
            ring_bytes: config.ring_bytes,
            idle_timeout: config.idle_timeout,
            max_sessions: config.max_sessions,
            rtc: rtc::RtcSettings {
                stun_servers: config.stun_servers.into(),
                allow_loopback: config.allow_loopback,
                log: log.clone(),
            },
            log: log.clone(),
        },
        control_rx,
        control_tx.clone(),
    );
    let hub = thread::Builder::new()
        .name("hub".into())
        .spawn(move || hub.run())
        .map_err(StartError::Io)?;

    let stopping = Arc::new(AtomicBool::new(false));
    let listener = {
        let stopping = stopping.clone();
        let hub_tx = control_tx.clone();
        let log = log.clone();
        thread::Builder::new()
            .name("control-listen".into())
            .spawn(move || loop {
                let accepted = listener.accept();
                if stopping.load(Ordering::SeqCst) {
                    return;
                }
                match accepted {
                    Ok(Some(stream)) => {
                        control::spawn_link(stream, token.clone(), hub_tx.clone(), log.clone())
                    }
                    Ok(None) => log.warn("control: refused a client of another user"),
                    Err(e) => {
                        log.warn(&format!("control: accept failed: {e}"));
                        thread::sleep(Duration::from_millis(100));
                    }
                }
            })
    };
    let listener = match listener {
        Ok(l) => l,
        Err(e) => {
            let _ = control_tx.send(ControlMsg::Stop);
            let _ = hub.join();
            home.remove_endpoint();
            return Err(StartError::Io(e));
        }
    };
    log.info(&format!(
        "started (version {VERSION}, pid {})",
        std::process::id()
    ));
    Ok(Daemon {
        hub,
        listener,
        stopper: Stopper(control_tx),
        stopping,
        endpoint,
        home,
        log,
    })
}
