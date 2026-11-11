//! `tunelo-term-host` binary: one daemon per tunelo config dir.
//!
//! Config dir: `TUNELO_HOME`, else `%APPDATA%\tunelo` on Windows and
//! `$XDG_CONFIG_HOME/tunelo` or `~/.config/tunelo` elsewhere (same rule as
//! the agent). Exits 0 on a clean stop, 3 when another daemon already owns
//! the config dir, 1 on other errors.
//!
//! `--stun host:port[,host:port]` (or `TUNELO_TERM_STUN`) sets the STUN
//! servers for the direct path; an empty list disables STUN. Default:
//! `tunnel.hoandat.com:3478`.

use std::path::PathBuf;
use std::process::ExitCode;

use tunelo_term_host::{nic, start, Config, Logger, StartError, Stopper};

fn config_dir() -> Option<PathBuf> {
    if let Some(h) = std::env::var_os("TUNELO_HOME").filter(|h| !h.is_empty()) {
        return Some(PathBuf::from(h));
    }
    if cfg!(windows) {
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
        })?;
        return Some(appdata.join("tunelo"));
    }
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("tunelo"))
}

#[cfg(unix)]
fn install_stop_handler(stopper: Stopper, log: &Logger) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    match Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        Ok(mut signals) => {
            let spawned = std::thread::Builder::new()
                .name("signals".into())
                .spawn(move || {
                    if signals.forever().next().is_some() {
                        stopper.stop();
                    }
                });
            if spawned.is_err() {
                log.warn("could not start the signal thread");
            }
        }
        Err(e) => log.warn(&format!("could not install signal handlers: {e}")),
    }
}

#[cfg(windows)]
mod win_ctrl {
    use std::sync::OnceLock;
    use tunelo_term_host::Stopper;
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT,
        CTRL_SHUTDOWN_EVENT,
    };

    static STOPPER: OnceLock<Stopper> = OnceLock::new();

    unsafe extern "system" fn handler(kind: u32) -> windows_sys::core::BOOL {
        match kind {
            CTRL_C_EVENT | CTRL_BREAK_EVENT | CTRL_CLOSE_EVENT | CTRL_SHUTDOWN_EVENT => {
                if let Some(s) = STOPPER.get() {
                    s.stop();
                }
                1
            }
            _ => 0,
        }
    }

    pub fn install(stopper: Stopper, log: &tunelo_term_host::Logger) {
        let _ = STOPPER.set(stopper);
        // SAFETY: registers a handler with the signature the API expects; it
        // only touches a OnceLock and a channel sender.
        if unsafe { SetConsoleCtrlHandler(Some(handler), 1) } == 0 {
            log.warn("could not install the console control handler");
        }
    }
}

#[cfg(windows)]
fn install_stop_handler(stopper: Stopper, log: &Logger) {
    win_ctrl::install(stopper, log);
}

/// The `--stun` value, if given (`--stun LIST` or `--stun=LIST`).
fn stun_flag(args: &[String]) -> Result<Option<String>, String> {
    let mut stun = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == "--stun" {
            let v = it.next().ok_or("--stun needs a value")?;
            stun = Some(v.clone());
        } else if let Some(v) = a.strip_prefix("--stun=") {
            stun = Some(v.to_string());
        } else {
            return Err(format!("unknown argument {a:?}"));
        }
    }
    Ok(stun)
}

fn main() -> ExitCode {
    let log = Logger::stderr();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = std::env::var(nic::STUN_ENV).ok();
    let stun = stun_flag(&args).and_then(|flag| nic::stun_servers(flag.as_deref(), env.as_deref()));
    let stun = match stun {
        Ok(s) => s,
        Err(e) => {
            log.warn(&e);
            return ExitCode::from(1);
        }
    };
    let Some(home) = config_dir() else {
        log.warn("cannot find the config dir: set TUNELO_HOME");
        return ExitCode::from(1);
    };
    let mut config = Config::new(home);
    config.logger = log.clone();
    config.stun_servers = stun;
    let daemon = match start(config) {
        Ok(d) => d,
        Err(StartError::AlreadyRunning) => {
            log.info("another daemon already runs for this config dir");
            return ExitCode::from(3);
        }
        Err(e) => {
            log.warn(&format!("start failed: {e}"));
            return ExitCode::from(1);
        }
    };
    install_stop_handler(daemon.stopper(), &log);
    daemon.wait();
    ExitCode::SUCCESS
}
