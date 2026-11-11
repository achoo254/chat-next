//! Unix domain socket transport: `<config dir>/term-host/control.sock`, mode
//! 0600 inside a 0700 directory, and a peer UID check on every connection.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

/// A connected control stream.
pub struct Stream(UnixStream);

impl Stream {
    pub fn try_clone(&self) -> io::Result<Stream> {
        self.0.try_clone().map(Stream)
    }

    pub fn shutdown(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }

    pub fn set_read_timeout(&self, t: Option<Duration>) {
        let _ = self.0.set_read_timeout(t);
    }

    pub fn set_write_timeout(&self, t: Option<Duration>) {
        let _ = self.0.set_write_timeout(t);
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

pub struct Listener {
    inner: UnixListener,
}

impl Listener {
    /// Bind at `path`. The caller holds the instance lock, so a socket file
    /// already there is stale and removed.
    pub fn bind(path: &Path) -> io::Result<Listener> {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        let inner = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(Listener { inner })
    }

    /// Accept the next connection whose peer runs as our user. Connections
    /// from other users are closed here. `Ok(None)` for a rejected peer.
    pub fn accept(&mut self) -> io::Result<Option<Stream>> {
        let (s, _) = self.inner.accept()?;
        let own = nix::unistd::geteuid().as_raw();
        match peer_uid(&s) {
            Ok(uid) if peer_allowed(uid, own) => Ok(Some(Stream(s))),
            _ => {
                let _ = s.shutdown(Shutdown::Both);
                Ok(None)
            }
        }
    }
}

/// Only the daemon's own user may talk to it.
pub fn peer_allowed(peer_uid: u32, own_uid: u32) -> bool {
    peer_uid == own_uid
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd",
    target_os = "dragonfly"
))]
fn peer_uid(s: &UnixStream) -> io::Result<u32> {
    let (uid, _gid) = nix::unistd::getpeereid(s).map_err(io::Error::from)?;
    Ok(uid.as_raw())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn peer_uid(s: &UnixStream) -> io::Result<u32> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    let cred = getsockopt(s, PeerCredentials).map_err(io::Error::from)?;
    Ok(cred.uid())
}

/// Connect to a daemon's control socket (headless client, tests).
pub fn connect(path: &Path) -> io::Result<Stream> {
    UnixStream::connect(path).map(Stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_same_uid_is_allowed() {
        assert!(peer_allowed(501, 501));
        assert!(!peer_allowed(0, 501));
        assert!(!peer_allowed(502, 501));
    }

    #[test]
    fn socket_is_private_and_peer_is_checked() {
        let dir = tempfile::Builder::new().prefix("th").tempdir_in("/tmp");
        let Ok(dir) = dir else {
            return;
        };
        let path = dir.path().join("s");
        let l = Listener::bind(&path).map_err(|e| e.to_string());
        assert!(l.is_ok(), "{l:?}", l = l.as_ref().err());
        let Ok(mut l) = l else { return };
        let mode = std::fs::metadata(&path).map(|m| m.permissions().mode() & 0o777);
        assert_eq!(mode.ok(), Some(0o600));
        let c = connect(&path);
        assert!(c.is_ok());
        // Our own UID passes the check.
        assert!(matches!(l.accept(), Ok(Some(_))));
    }
}
