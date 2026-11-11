#!/usr/bin/env python3
"""Asks a STUN server for this machine's public address (standard library only).

    python3 infra/stun/stun-probe.py [host[:port]] [--count N]

Default server tunnel.hoandat.com:3478. Prints one line per request with the
mapped address and the round-trip time, then a summary. Exits 1 when no
request was answered.
"""

import argparse
import ipaddress
import os
import socket
import struct
import sys
import time

MAGIC = 0x2112A442


def parse_response(data: bytes, txid: bytes):
    """Returns (ip, port) from XOR-MAPPED-ADDRESS, or None."""
    if len(data) < 20:
        return None
    msg_type, length, cookie = struct.unpack("!HHI", data[:8])
    if msg_type != 0x0101 or cookie != MAGIC or data[8:20] != txid:
        return None
    pos, end = 20, min(len(data), 20 + length)
    while pos + 4 <= end:
        attr, alen = struct.unpack("!HH", data[pos:pos + 4])
        value = data[pos + 4:pos + 4 + alen]
        if attr == 0x0020 and len(value) >= 8:
            family = value[1]
            port = struct.unpack("!H", value[2:4])[0] ^ (MAGIC >> 16)
            key = struct.pack("!I", MAGIC) + txid
            if family == 1:
                raw = bytes(b ^ k for b, k in zip(value[4:8], key))
            elif family == 2 and len(value) >= 20:
                raw = bytes(b ^ k for b, k in zip(value[4:20], key))
            else:
                return None
            return str(ipaddress.ip_address(raw)), port
        pos += 4 + ((alen + 3) & ~3)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("server", nargs="?", default="tunnel.hoandat.com:3478")
    ap.add_argument("--count", type=int, default=8)
    args = ap.parse_args()

    host, _, port = args.server.rpartition(":")
    if not host:
        host, port = args.server, "3478"
    try:
        addr = socket.getaddrinfo(host, int(port), socket.AF_INET, socket.SOCK_DGRAM)[0][4]
    except (OSError, ValueError) as e:
        print(f"cannot resolve {args.server}: {e}", file=sys.stderr)
        return 2

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    sock.settimeout(2.0)
    local_port = sock.getsockname()[1]
    answered, rtts, mapped_seen = 0, [], set()
    for i in range(args.count):
        txid = os.urandom(12)
        t0 = time.perf_counter()
        sock.sendto(struct.pack("!HHI", 0x0001, 0, MAGIC) + txid, addr)
        try:
            while True:
                data, _ = sock.recvfrom(1500)
                mapped = parse_response(data, txid)
                if mapped:
                    break
        except socket.timeout:
            print(f"{i + 1}: no answer within 2 s")
            continue
        rtt = (time.perf_counter() - t0) * 1000
        answered += 1
        rtts.append(rtt)
        mapped_seen.add(mapped)
        print(f"{i + 1}: mapped {mapped[0]}:{mapped[1]} rtt {rtt:.1f} ms")
        time.sleep(0.1)

    print(f"server {args.server}, local port {local_port}, answered {answered}/{args.count}")
    if rtts:
        print(f"rtt min {min(rtts):.1f} / max {max(rtts):.1f} ms, distinct mapped addresses {len(mapped_seen)}")
    return 0 if answered else 1


if __name__ == "__main__":
    sys.exit(main())
