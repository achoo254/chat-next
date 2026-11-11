//! Handshake, single instance, idle exit, and clean shutdown.
#![cfg(unix)]

mod common;

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::*;
use serde_json::json;
use tunelo_term_host::client::{read_control, AgentClient};
use tunelo_term_host::{start, Config, ExitReason, Logger, StartError, CONTROL_FILE, DIR_NAME};

#[test]
fn wrong_token_or_missing_hello_closes_the_connection() {
    let d = TestDaemon::start();
    let (token, _) = read_control(d.home()).expect("control.json");

    let c = AgentClient::connect_raw(d.home()).expect("connect");
    c.send_json(
        &json!({ "id": 1, "cmd": "hello", "major": 1, "minor": 0, "token": "not-the-token" }),
    )
    .expect("send");
    let reply = c.next_reply(T).expect("error reply");
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"]["code"], "unauthorized");
    assert!(c.wait_closed(T), "socket closed after bad token");

    let c = AgentClient::connect_raw(d.home()).expect("connect");
    c.send_json(&json!({ "id": 1, "cmd": "list" }))
        .expect("send");
    assert_eq!(
        c.next_reply(T).expect("reply")["error"]["code"],
        "unauthorized"
    );
    assert!(c.wait_closed(T));

    let c = AgentClient::connect_raw(d.home()).expect("connect");
    c.send_json(&json!({ "id": 2, "cmd": "hello", "major": 2, "minor": 0, "token": token }))
        .expect("send");
    assert_eq!(
        c.next_reply(T).expect("reply")["error"]["code"],
        "version_mismatch"
    );
    assert!(c.wait_closed(T));

    // A newer minor of the same major is accepted.
    let c = AgentClient::connect_raw(d.home()).expect("connect");
    let hello = c.call(
        "hello",
        json!({ "major": 1, "minor": 7, "token": token, "agentVersion": "future" }),
    );
    assert!(hello.is_ok());
    // No token in any log line.
    assert!(!d.log_text().contains(&token));
}

#[test]
fn control_files_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let d = TestDaemon::start();
    let dir = d.home().join(DIR_NAME);
    let mode = |p: &std::path::Path| {
        std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o777)
            .ok()
    };
    assert_eq!(mode(&dir), Some(0o700));
    assert_eq!(mode(&dir.join(CONTROL_FILE)), Some(0o600));
    assert_eq!(mode(&dir.join("control.sock")), Some(0o600));
}

#[test]
fn one_daemon_per_config_dir() {
    let d = TestDaemon::start();
    let mut cfg = Config::new(d.home());
    cfg.logger = Logger::new(|_| {});
    assert!(matches!(start(cfg), Err(StartError::AlreadyRunning)));
    // The running daemon is unaffected.
    let (agent, _) = d.agent();
    assert!(agent.call("list", json!({})).is_ok());
    // Another config dir gets its own daemon.
    let other = TestDaemon::start();
    assert!(other.agent().0.call("list", json!({})).is_ok());
}

#[test]
fn idle_daemon_exits_and_removes_its_endpoint() {
    let mut d = TestDaemon::start_with(|c| c.idle_timeout = Duration::from_millis(300));
    {
        // A session keeps it alive past the timeout.
        let (agent, _) = d.agent();
        let s = open_sh(&agent);
        std::thread::sleep(Duration::from_millis(600));
        assert!(
            agent.call("list", json!({})).is_ok(),
            "still running with a session"
        );
        agent.call("close", json!({ "session": s })).expect("close");
        agent
            .wait_event(T, |e| e["event"] == "session_exit")
            .expect("exit");
    }
    let t0 = Instant::now();
    assert_eq!(d.wait(), Some(ExitReason::Idle));
    assert!(t0.elapsed() < Duration::from_secs(3));
    assert!(!d.home().join(DIR_NAME).join(CONTROL_FILE).exists());
    assert!(!d.home().join(DIR_NAME).join("control.sock").exists());
}

#[test]
fn shutdown_command_closes_shells_and_children() {
    let mut d = TestDaemon::start();
    let (agent, _) = d.agent();
    let s1 = open_sh(&agent);
    let s2 = open_sh(&agent);
    let mut t = attach_new(&agent, 1, 1, s1);
    let shell = shell_pid(&mut t, s1, "echo SH=$$\r");
    t.input(s1, b"sleep 600\r").expect("sleep");
    let mut sleeper = None;
    assert!(wait_until(T, || {
        let out = Command::new("pgrep")
            .args(["-P", &shell.to_string(), "sleep"])
            .output();
        sleeper = out.ok().and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<i32>()
                .ok()
        });
        sleeper.is_some()
    }));
    let sleeper = sleeper.expect("sleep pid");
    let mut t2 = attach_new(&agent, 2, 1, s2);
    let shell2 = shell_pid(&mut t2, s2, "echo SH=$$\r");
    assert!(alive(shell) && alive(sleeper) && alive(shell2));

    let t0 = Instant::now();
    let r = agent.call("shutdown", json!({}));
    assert!(r.is_ok(), "shutdown replied: {r:?}");
    assert_eq!(d.wait(), Some(ExitReason::ShutdownCommand));
    eprintln!(
        "shutdown took {:.0} ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );
    for pid in [shell, sleeper, shell2] {
        assert!(
            wait_until(Duration::from_secs(3), || !alive(pid)),
            "process {pid} survived"
        );
    }
    assert!(agent.wait_closed(T));
}

#[test]
fn binary_stops_cleanly_on_sigterm() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut child = Command::new(env!("CARGO_BIN_EXE_tunelo-term-host"))
        .env("TUNELO_HOME", dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn daemon");
    let control = dir.path().join(DIR_NAME).join(CONTROL_FILE);
    assert!(wait_until(T, || control.exists()), "control.json written");
    let (agent, hello) = AgentClient::connect(dir.path()).expect("agent");
    assert_eq!(hello["pid"], child.id());
    let s = open_sh(&agent);
    let mut t = attach_new(&agent, 1, 1, s);
    let secret = "typed-Qv7-secret";
    let shell = shell_pid(&mut t, s, &format!("echo {secret} SH=$$\r"));

    // A second instance on the same dir refuses to start (exit code 3).
    let second = Command::new(env!("CARGO_BIN_EXE_tunelo-term-host"))
        .env("TUNELO_HOME", dir.path())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("second");
    assert_eq!(second.code(), Some(3));

    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    )
    .expect("sigterm");
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = child.try_wait().expect("try_wait") {
            break st;
        }
        assert!(Instant::now() < deadline, "daemon did not exit");
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "exit status {status:?}");
    assert!(
        wait_until(Duration::from_secs(3), || !alive(shell)),
        "shell survived"
    );
    assert!(!control.exists(), "control.json removed");
    let mut stderr = String::new();
    use std::io::Read;
    child
        .stderr
        .take()
        .expect("stderr")
        .read_to_string(&mut stderr)
        .expect("read stderr");
    assert!(stderr.contains("started"));
    assert!(!stderr.contains(secret), "typed input in daemon log");
}

#[test]
fn binary_refuses_bad_arguments_and_stun_lists() {
    let dir = tempfile::tempdir().expect("tempdir");
    for (args, stun_env) in [
        (vec!["--bogus"], None),
        (vec!["--stun"], None),
        (vec!["--stun", "no-port"], None),
        (vec![], Some("host:0")),
    ] {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_tunelo-term-host"));
        cmd.args(&args)
            .env("TUNELO_HOME", dir.path())
            .env_remove("TUNELO_TERM_STUN");
        if let Some(v) = stun_env {
            cmd.env("TUNELO_TERM_STUN", v);
        }
        let out = cmd.output().expect("run");
        assert_eq!(out.status.code(), Some(1), "{args:?} {stun_env:?}");
        // Refused before taking the config dir.
        assert!(!dir.path().join(DIR_NAME).exists());
    }
}
