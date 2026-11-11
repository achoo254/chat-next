#!/bin/bash
# Runs as root on the server, from the bundle that deploy.sh streams over SSH:
#   bash install-on-server.sh <bundle dir>
# The bundle holds stun-responder (binary) and stun-responder.service.
# Creates the system user `stun`, installs the binary and the unit, starts the
# service, then only REPORTS the state of UDP 3478 and the firewall. It never
# changes firewall rules, nginx, DNS or any other service.
set -euo pipefail

bundle="${1:?usage: install-on-server.sh <bundle dir>}"
BIN=/usr/local/bin/stun-responder
UNIT=/etc/systemd/system/stun-responder.service
PORT=3478

[ "$(id -u)" = 0 ] || { echo "install-on-server: must run as root" >&2; exit 1; }
for f in stun-responder stun-responder.service; do
  [ -s "$bundle/$f" ] || { echo "install-on-server: missing $f in bundle" >&2; exit 1; }
done

# Refuse to take a port that some other program already holds.
holder="$(ss -H -lunp "sport = :$PORT" 2>/dev/null || true)"
if [ -n "$holder" ] && ! grep -q '"stun-responder"' <<<"$holder"; then
  echo "install-on-server: UDP $PORT is already used by another program:" >&2
  echo "$holder" >&2
  exit 1
fi

echo "== free memory before"
free -m

if ! id stun >/dev/null 2>&1; then
  nologin="$(command -v nologin || echo /sbin/nologin)"
  useradd --system --no-create-home --home-dir / --shell "$nologin" stun
  echo "created system user stun"
fi

# The new binary must at least run on this machine before it replaces anything.
"$bundle/stun-responder" --version

install -o root -g root -m 755 "$bundle/stun-responder" "$BIN.new"
mv -f "$BIN.new" "$BIN"
install -o root -g root -m 644 "$bundle/stun-responder.service" "$UNIT"
if command -v restorecon >/dev/null 2>&1; then
  restorecon "$BIN" "$UNIT"
fi

systemctl daemon-reload
systemctl enable stun-responder.service
systemctl restart stun-responder.service

for _ in 1 2 3 4 5 6 7 8 9 10; do
  systemctl is-active --quiet stun-responder.service && break
  sleep 0.5
done
if ! systemctl is-active --quiet stun-responder.service; then
  echo "install-on-server: service did not start" >&2
  journalctl -u stun-responder.service -n 20 --no-pager >&2 || true
  exit 1
fi

echo "== service"
systemctl show stun-responder.service -p ActiveState -p SubState -p MainPID -p User -p MemoryCurrent
echo "== UDP $PORT listeners"
ss -H -lunp "sport = :$PORT"

echo "== firewall (report only, nothing is changed)"
echo "firewalld: $(systemctl is-active firewalld 2>/dev/null || true)"
if command -v iptables >/dev/null 2>&1; then
  echo "iptables INPUT policy: $(iptables -S INPUT 2>/dev/null | awk '$1 == "-P" {print $3}')"
  echo "iptables INPUT rules: $(iptables -S INPUT 2>/dev/null | grep -c '^-A' || true)"
  echo "iptables INPUT rules that mention udp or $PORT:"
  iptables -S INPUT 2>/dev/null | grep -E -- "-p udp|$PORT" || echo "  (none)"
fi

echo "== free memory after"
free -m
