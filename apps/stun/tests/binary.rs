//! Runs the real binary on loopback and talks to it over UDP.

use std::net::{SocketAddr, UdpSocket};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

struct Server {
    child: Child,
    addr: SocketAddr,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn start() -> Server {
    // Reserve a free port, release it, then hand it to the binary.
    let addr = UdpSocket::bind("127.0.0.1:0")
        .and_then(|s| s.local_addr())
        .expect("free port");
    let child = Command::new(env!("CARGO_BIN_EXE_stun-responder"))
        .args(["--listen", &addr.to_string()])
        .env_remove("STUN_LISTEN")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn stun-responder");
    Server { child, addr }
}

fn request(txid: &[u8; 12]) -> Vec<u8> {
    let mut m = vec![0x00, 0x01, 0x00, 0x00];
    m.extend_from_slice(&MAGIC);
    m.extend_from_slice(txid);
    m
}

fn client() -> UdpSocket {
    let c = UdpSocket::bind("127.0.0.1:0").expect("client socket");
    c.set_read_timeout(Some(Duration::from_millis(300)))
        .expect("timeout");
    c
}

/// Sends a request until the server answers (it may still be starting).
fn first_answer(server: &Server, c: &UdpSocket, txid: &[u8; 12]) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut buf = [0u8; 128];
    while Instant::now() < deadline {
        c.send_to(&request(txid), server.addr).expect("send");
        if let Ok((n, _)) = c.recv_from(&mut buf) {
            return buf[..n].to_vec();
        }
    }
    panic!("no answer from stun-responder within 5 s");
}

#[test]
fn answers_with_the_source_address() {
    let server = start();
    let c = client();
    let txid = [7u8; 12];
    let resp = first_answer(&server, &c, &txid);
    assert_eq!(&resp[0..2], &[0x01, 0x01], "Binding success");
    assert_eq!(&resp[8..20], &txid);
    let port = u16::from_be_bytes([resp[26], resp[27]]) ^ 0x2112;
    let ip: Vec<u8> = resp[28..32].iter().zip(MAGIC).map(|(a, k)| a ^ k).collect();
    assert_eq!(ip, [127, 0, 0, 1]);
    assert_eq!(port, c.local_addr().expect("addr").port());
}

#[test]
fn ignores_garbage_and_limits_each_source() {
    let server = start();
    let c = client();
    first_answer(&server, &c, &[1u8; 12]);
    // Let the window of the probe above end so the burst below starts a
    // fresh one; the burst takes far less than a second.
    std::thread::sleep(Duration::from_millis(1100));

    c.send_to(b"not stun at all, just bytes", server.addr)
        .expect("send");
    for i in 0..40u8 {
        c.send_to(&request(&[i; 12]), server.addr).expect("send");
    }
    let mut answered = 0;
    let mut buf = [0u8; 128];
    while c.recv_from(&mut buf).is_ok() {
        answered += 1;
    }
    assert_eq!(answered, 20, "20 answers per second per source");
}
