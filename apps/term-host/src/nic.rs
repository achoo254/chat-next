//! Local addresses for the direct path: interface enumeration (LAN, VPN,
//! Tailscale), one UDP socket per address, and a STUN binding client that
//! learns the server-reflexive address of each socket. `str0m` leaves all of
//! this to the application.

use std::io;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::{Duration, Instant};

/// STUN server used when nothing else is configured (phase 1, S5).
pub const DEFAULT_STUN: &str = "tunnel.hoandat.com:3478";
/// Overrides the STUN server list: comma separated `host:port`, empty for none.
pub const STUN_ENV: &str = "TUNELO_TERM_STUN";
/// At most this many local sockets per peer connection.
pub const MAX_SOCKETS: usize = 16;
/// At most this many STUN servers are asked.
pub const MAX_STUN_SERVERS: usize = 4;

const STUN_HEADER: usize = 20;
const MAGIC_COOKIE: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
/// Send times of a binding request relative to the first one.
const STUN_SCHEDULE: [Duration; 4] = [
    Duration::ZERO,
    Duration::from_millis(500),
    Duration::from_millis(1500),
    Duration::from_millis(3500),
];
/// Give up this long after the last request.
const STUN_GIVE_UP: Duration = Duration::from_secs(2);

/// Whether an interface address can carry the direct path.
pub fn usable(ip: IpAddr, allow_loopback: bool) -> bool {
    if ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    if ip.is_loopback() {
        return allow_loopback;
    }
    match ip {
        // IPv4 link-local is refused by the ICE layer too.
        IpAddr::V4(v4) => !v4.is_link_local() && !v4.is_broadcast(),
        // fe80::/10: needs a scope id and never leaves the link.
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
    }
}

/// Addresses of interfaces that are up, filtered by [`usable`], without
/// duplicates, at most [`MAX_SOCKETS`].
pub fn local_addresses(allow_loopback: bool) -> io::Result<Vec<IpAddr>> {
    let mut out: Vec<IpAddr> = Vec::new();
    for ip in interface_addresses()? {
        if usable(ip, allow_loopback) && !out.contains(&ip) {
            out.push(ip);
            if out.len() == MAX_SOCKETS {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(unix)]
fn interface_addresses() -> io::Result<Vec<IpAddr>> {
    use nix::net::if_::InterfaceFlags;
    let mut out = Vec::new();
    for ifa in nix::ifaddrs::getifaddrs().map_err(io::Error::from)? {
        if !ifa.flags.contains(InterfaceFlags::IFF_UP) {
            continue;
        }
        let Some(addr) = ifa.address else { continue };
        if let Some(v4) = addr.as_sockaddr_in() {
            out.push(IpAddr::V4(v4.ip()));
        } else if let Some(v6) = addr.as_sockaddr_in6() {
            out.push(IpAddr::V6(v6.ip()));
        }
    }
    Ok(out)
}

// Windows only: compile-checked with x86_64-pc-windows-gnu, not run yet.
#[cfg(windows)]
fn interface_addresses() -> io::Result<Vec<IpAddr>> {
    use std::net::{Ipv4Addr, Ipv6Addr};
    use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
        GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH, IP_ADAPTER_UNICAST_ADDRESS_LH,
    };
    use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, AF_INET6, AF_UNSPEC, SOCKADDR_IN, SOCKADDR_IN6,
    };

    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let mut len: u32 = 16 * 1024;
    for _ in 0..4 {
        // u64 elements keep the buffer aligned for the adapter structs.
        let mut buf: Vec<u64> = vec![0; (len as usize).div_ceil(8)];
        let first = buf.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
        // SAFETY: `first` points to `len` writable, aligned bytes; the call
        // fills them with a linked list that stays inside `buf`.
        let rc = unsafe {
            GetAdaptersAddresses(
                u32::from(AF_UNSPEC),
                flags,
                std::ptr::null(),
                first,
                &mut len,
            )
        };
        if rc == ERROR_BUFFER_OVERFLOW {
            continue;
        }
        if rc != NO_ERROR {
            return Err(io::Error::from_raw_os_error(rc as i32));
        }
        let mut out = Vec::new();
        let mut adapter = first as *const IP_ADAPTER_ADDRESSES_LH;
        // SAFETY: every pointer below comes from the list written into `buf`
        // by GetAdaptersAddresses (null-terminated), which is still alive;
        // socket addresses are read only after checking their family and
        // length.
        unsafe {
            while let Some(a) = adapter.as_ref() {
                if a.OperStatus == IfOperStatusUp {
                    let mut uni: *const IP_ADAPTER_UNICAST_ADDRESS_LH = a.FirstUnicastAddress;
                    while let Some(u) = uni.as_ref() {
                        let sa = u.Address.lpSockaddr;
                        let sa_len = u.Address.iSockaddrLength as usize;
                        if let Some(s) = sa.as_ref() {
                            if s.sa_family == AF_INET
                                && sa_len >= std::mem::size_of::<SOCKADDR_IN>()
                            {
                                let v4 = &*(sa as *const SOCKADDR_IN);
                                let raw = v4.sin_addr.S_un.S_addr;
                                out.push(IpAddr::V4(Ipv4Addr::from(u32::from_be(raw))));
                            } else if s.sa_family == AF_INET6
                                && sa_len >= std::mem::size_of::<SOCKADDR_IN6>()
                            {
                                let v6 = &*(sa as *const SOCKADDR_IN6);
                                out.push(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.u.Byte)));
                            }
                        }
                        uni = u.Next;
                    }
                }
                adapter = a.Next as *const _;
            }
        }
        return Ok(out);
    }
    Err(io::Error::other("adapter list kept growing"))
}

/// Bind one UDP socket (ephemeral port) per address. Addresses that cannot
/// be bound are skipped.
pub fn bind_sockets(addrs: &[IpAddr]) -> Vec<UdpSocket> {
    addrs
        .iter()
        .filter_map(|ip| UdpSocket::bind(SocketAddr::new(*ip, 0)).ok())
        .collect()
}

/// Parse a STUN server list: comma separated `host:port`. Blank entries are
/// skipped; an entry without a valid port is an error.
pub fn parse_stun_list(s: &str) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in s.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (host, port) = entry
            .rsplit_once(':')
            .ok_or_else(|| format!("STUN server {entry:?} needs host:port"))?;
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() || host.len() > 253 || port.parse::<u16>().map_or(true, |p| p == 0) {
            return Err(format!("STUN server {entry:?} is not host:port"));
        }
        out.push(entry.to_string());
        if out.len() == MAX_STUN_SERVERS {
            break;
        }
    }
    Ok(out)
}

/// The STUN server list: the `--stun` flag wins over [`STUN_ENV`], which
/// wins over [`DEFAULT_STUN`]. An empty value disables STUN.
pub fn stun_servers(flag: Option<&str>, env: Option<&str>) -> Result<Vec<String>, String> {
    match flag.or(env) {
        Some(list) => parse_stun_list(list),
        None => Ok(vec![DEFAULT_STUN.to_string()]),
    }
}

/// Resolve the STUN servers (blocking DNS; call off the hot path).
pub fn resolve_servers(list: &[String]) -> Vec<SocketAddr> {
    let mut out: Vec<SocketAddr> = Vec::new();
    for entry in list {
        if let Ok(addrs) = entry.to_socket_addrs() {
            for a in addrs {
                if !out.contains(&a) {
                    out.push(a);
                }
            }
        }
    }
    out
}

/// A STUN Binding request (RFC 5389) without attributes.
pub fn binding_request(txid: &[u8; 12]) -> [u8; STUN_HEADER] {
    let mut m = [0u8; STUN_HEADER];
    m[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Length 0.
    m[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    m[8..20].copy_from_slice(txid);
    m
}

fn transaction_id(buf: &[u8]) -> Option<[u8; 12]> {
    buf.get(8..20)?.try_into().ok()
}

/// The mapped address of a Binding success response for `txid`, if `buf`
/// is one. Prefers XOR-MAPPED-ADDRESS, falls back to MAPPED-ADDRESS.
pub fn parse_binding_response(buf: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    let head = buf.get(..STUN_HEADER)?;
    if u16::from_be_bytes([head[0], head[1]]) != BINDING_SUCCESS
        || u32::from_be_bytes([head[4], head[5], head[6], head[7]]) != MAGIC_COOKIE
        || transaction_id(buf)? != *txid
    {
        return None;
    }
    let len = usize::from(u16::from_be_bytes([head[2], head[3]]));
    let body = buf.get(STUN_HEADER..STUN_HEADER + len)?;
    let mut plain = None;
    let mut at = 0;
    while at + 4 <= body.len() {
        let kind = u16::from_be_bytes([body[at], body[at + 1]]);
        let alen = usize::from(u16::from_be_bytes([body[at + 2], body[at + 3]]));
        let value = body.get(at + 4..at + 4 + alen)?;
        match kind {
            ATTR_XOR_MAPPED_ADDRESS => return decode_address(value, Some(txid)),
            ATTR_MAPPED_ADDRESS => plain = decode_address(value, None),
            _ => {}
        }
        // Attributes are padded to 4 bytes.
        at += 4 + alen.div_ceil(4) * 4;
    }
    plain
}

fn decode_address(v: &[u8], xor_txid: Option<&[u8; 12]>) -> Option<SocketAddr> {
    let family = *v.get(1)?;
    let mut port = u16::from_be_bytes([*v.get(2)?, *v.get(3)?]);
    let cookie = MAGIC_COOKIE.to_be_bytes();
    if xor_txid.is_some() {
        port ^= (MAGIC_COOKIE >> 16) as u16;
    }
    match family {
        0x01 => {
            let mut a: [u8; 4] = v.get(4..8)?.try_into().ok()?;
            if xor_txid.is_some() {
                for (b, k) in a.iter_mut().zip(cookie) {
                    *b ^= k;
                }
            }
            Some(SocketAddr::new(IpAddr::from(a), port))
        }
        0x02 => {
            let mut a: [u8; 16] = v.get(4..20)?.try_into().ok()?;
            if let Some(txid) = xor_txid {
                let key = cookie.iter().chain(txid.iter());
                for (b, k) in a.iter_mut().zip(key) {
                    *b ^= k;
                }
            }
            Some(SocketAddr::new(IpAddr::from(a), port))
        }
        _ => None,
    }
}

/// One outstanding binding transaction: socket index and server.
struct Probe {
    sock: usize,
    server: SocketAddr,
    txid: [u8; 12],
    started: Instant,
    sent: usize,
    done: bool,
}

/// Binding transactions of one peer connection: every local socket asks
/// every STUN server of its address family, with retransmissions.
#[derive(Default)]
pub struct StunProbes {
    probes: Vec<Probe>,
}

/// A request to put on the wire.
pub struct StunSend {
    pub sock: usize,
    pub server: SocketAddr,
    pub request: [u8; STUN_HEADER],
}

impl StunProbes {
    /// Start probes for `locals` (index = socket index) against `servers`.
    pub fn start(
        &mut self,
        locals: &[SocketAddr],
        servers: &[SocketAddr],
        now: Instant,
    ) -> io::Result<()> {
        for (sock, local) in locals.iter().enumerate() {
            // Loopback sockets cannot reach a STUN server.
            if local.ip().is_loopback() {
                continue;
            }
            for server in servers.iter().filter(|s| s.is_ipv4() == local.is_ipv4()) {
                let mut txid = [0u8; 12];
                getrandom::fill(&mut txid)
                    .map_err(|e| io::Error::other(format!("random source failed: {e}")))?;
                self.probes.push(Probe {
                    sock,
                    server: *server,
                    txid,
                    started: now,
                    sent: 0,
                    done: false,
                });
            }
        }
        Ok(())
    }

    /// Requests due now (first sends and retransmissions).
    pub fn due(&mut self, now: Instant, out: &mut Vec<StunSend>) {
        for p in self.probes.iter_mut().filter(|p| !p.done) {
            match STUN_SCHEDULE.get(p.sent) {
                Some(at) if p.started + *at <= now => {
                    p.sent += 1;
                    out.push(StunSend {
                        sock: p.sock,
                        server: p.server,
                        request: binding_request(&p.txid),
                    });
                }
                Some(_) => {}
                None => {
                    if let Some(last) = STUN_SCHEDULE.last() {
                        if p.started + *last + STUN_GIVE_UP <= now {
                            p.done = true;
                        }
                    }
                }
            }
        }
    }

    /// When to call [`StunProbes::due`] next.
    pub fn next_at(&self) -> Option<Instant> {
        self.probes
            .iter()
            .filter(|p| !p.done)
            .filter_map(|p| match STUN_SCHEDULE.get(p.sent) {
                Some(at) => Some(p.started + *at),
                None => STUN_SCHEDULE.last().map(|l| p.started + *l + STUN_GIVE_UP),
            })
            .min()
    }

    /// Whether `buf`, received on socket `sock` from `from`, answers one of
    /// our probes. `Some(mapped)` when it does (the packet is consumed).
    pub fn on_packet(&mut self, sock: usize, from: SocketAddr, buf: &[u8]) -> Option<SocketAddr> {
        let txid = transaction_id(buf)?;
        let p = self
            .probes
            .iter_mut()
            .find(|p| !p.done && p.sock == sock && p.server == from && p.txid == txid)?;
        let mapped = parse_binding_response(buf, &p.txid)?;
        p.done = true;
        Some(mapped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    /// A Binding success response as a STUN server writes it.
    fn response(txid: &[u8; 12], mapped: SocketAddr) -> Vec<u8> {
        let mut attr = vec![0u8, if mapped.is_ipv4() { 1 } else { 2 }];
        attr.extend_from_slice(&(mapped.port() ^ (MAGIC_COOKIE >> 16) as u16).to_be_bytes());
        let key: Vec<u8> = MAGIC_COOKIE
            .to_be_bytes()
            .iter()
            .chain(txid.iter())
            .copied()
            .collect();
        let ip: Vec<u8> = match mapped.ip() {
            IpAddr::V4(v) => v.octets().to_vec(),
            IpAddr::V6(v) => v.octets().to_vec(),
        };
        attr.extend(ip.iter().zip(key).map(|(b, k)| b ^ k));
        let mut m = Vec::new();
        m.extend_from_slice(&BINDING_SUCCESS.to_be_bytes());
        m.extend_from_slice(&((4 + attr.len()) as u16).to_be_bytes());
        m.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        m.extend_from_slice(txid);
        m.extend_from_slice(&ATTR_XOR_MAPPED_ADDRESS.to_be_bytes());
        m.extend_from_slice(&(attr.len() as u16).to_be_bytes());
        m.extend_from_slice(&attr);
        m
    }

    #[test]
    fn address_filter() {
        let v4 = |a, b, c, d| IpAddr::V4(Ipv4Addr::new(a, b, c, d));
        assert!(usable(v4(192, 168, 1, 5), false));
        // Tailscale CGNAT range and VPN addresses are ordinary addresses.
        assert!(usable(v4(100, 101, 102, 103), false));
        assert!(usable(v4(10, 8, 0, 6), false));
        assert!(!usable(v4(127, 0, 0, 1), false));
        assert!(usable(v4(127, 0, 0, 1), true));
        assert!(!usable(v4(169, 254, 3, 4), true));
        assert!(!usable(v4(0, 0, 0, 0), true));
        assert!(!usable(v4(224, 0, 0, 1), true));
        let link_local: Ipv6Addr = "fe80::1".parse().unwrap_or(Ipv6Addr::UNSPECIFIED);
        assert!(!usable(IpAddr::V6(link_local), true));
        let tailscale: Ipv6Addr = "fd7a:115c:a1e0::1".parse().unwrap_or(Ipv6Addr::UNSPECIFIED);
        assert!(usable(IpAddr::V6(tailscale), false));
        assert!(!usable(IpAddr::V6(Ipv6Addr::LOCALHOST), false));
    }

    #[test]
    fn local_addresses_respect_the_loopback_flag() {
        let with = local_addresses(true).unwrap_or_default();
        assert!(with.iter().any(|ip| ip.is_loopback()), "{with:?}");
        let without = local_addresses(false).unwrap_or_default();
        assert!(without.iter().all(|ip| usable(*ip, false)));
        assert!(without.len() <= MAX_SOCKETS);
    }

    #[test]
    fn stun_list_parsing() {
        assert_eq!(
            parse_stun_list(" a.example:3478, b.example:19302 ,"),
            Ok(vec!["a.example:3478".into(), "b.example:19302".into()])
        );
        assert_eq!(parse_stun_list(""), Ok(vec![]));
        assert_eq!(parse_stun_list("[::1]:3478"), Ok(vec!["[::1]:3478".into()]));
        assert!(parse_stun_list("nohost").is_err());
        assert!(parse_stun_list("host:0").is_err());
        assert!(parse_stun_list("host:99999").is_err());
        assert!(parse_stun_list(":3478").is_err());
        assert_eq!(stun_servers(None, None), Ok(vec![DEFAULT_STUN.to_string()]));
        assert_eq!(stun_servers(None, Some("")), Ok(vec![]));
        assert_eq!(
            stun_servers(Some("f.example:1"), Some("e.example:2")),
            Ok(vec!["f.example:1".to_string()])
        );
        assert!(stun_servers(None, Some("bad")).is_err());
    }

    #[test]
    fn binding_response_round_trip_and_rejections() {
        let txid = [9u8; 12];
        let req = binding_request(&txid);
        assert_eq!(&req[0..2], &[0, 1]);
        assert_eq!(transaction_id(&req), Some(txid));
        for mapped in [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)), 40000),
            SocketAddr::new(
                IpAddr::V6("2001:db8::7".parse().unwrap_or(Ipv6Addr::UNSPECIFIED)),
                40001,
            ),
        ] {
            let resp = response(&txid, mapped);
            assert_eq!(parse_binding_response(&resp, &txid), Some(mapped));
            // Wrong transaction, truncated, or a request: not ours.
            assert_eq!(parse_binding_response(&resp, &[1u8; 12]), None);
            assert_eq!(parse_binding_response(&resp[..resp.len() - 3], &txid), None);
        }
        assert_eq!(parse_binding_response(&req, &txid), None);
        // Garbage of every short length never panics.
        let junk = [0xffu8; 64];
        for n in 0..junk.len() {
            assert_eq!(parse_binding_response(&junk[..n], &txid), None);
        }
    }

    #[test]
    fn probes_retransmit_then_give_up_and_match_responses() {
        let t0 = Instant::now();
        let local: SocketAddr = "192.0.2.10:5000"
            .parse()
            .unwrap_or(SocketAddr::from(([0; 4], 0)));
        let server: SocketAddr = "198.51.100.1:3478"
            .parse()
            .unwrap_or(SocketAddr::from(([0; 4], 0)));
        let v6server: SocketAddr = "[2001:db8::1]:3478"
            .parse()
            .unwrap_or(SocketAddr::from(([0; 4], 0)));
        let mut p = StunProbes::default();
        assert!(p.start(&[local], &[server, v6server], t0).is_ok());
        let mut out = Vec::new();
        p.due(t0, &mut out);
        assert_eq!(out.len(), 1, "only the server of the same family");
        assert_eq!(p.next_at(), Some(t0 + Duration::from_millis(500)));
        out.clear();
        p.due(t0 + Duration::from_millis(400), &mut out);
        assert!(out.is_empty());
        p.due(t0 + Duration::from_millis(3500), &mut out);
        assert_eq!(out.len(), 1, "one send per call");
        p.due(t0 + Duration::from_millis(3500), &mut out);
        p.due(t0 + Duration::from_millis(3500), &mut out);
        assert_eq!(out.len(), 3);
        let txid = transaction_id(&out[0].request).unwrap_or_default();
        let mapped: SocketAddr = "203.0.113.9:6000"
            .parse()
            .unwrap_or(SocketAddr::from(([0; 4], 0)));
        let resp = response(&txid, mapped);
        // From another source: ignored.
        assert_eq!(p.on_packet(0, local, &resp), None);
        assert_eq!(p.on_packet(0, server, &resp), Some(mapped));
        // Answered once only.
        assert_eq!(p.on_packet(0, server, &resp), None);
        assert_eq!(p.next_at(), None);

        let mut q = StunProbes::default();
        assert!(q.start(&[local], &[server], t0).is_ok());
        for ms in [0, 500, 1500, 3500] {
            q.due(t0 + Duration::from_millis(ms), &mut out);
        }
        assert!(q.next_at().is_some());
        q.due(t0 + Duration::from_millis(5500), &mut out);
        assert_eq!(q.next_at(), None, "gave up");
    }
}
