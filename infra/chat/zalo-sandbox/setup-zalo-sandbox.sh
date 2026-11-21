#!/bin/bash
# Prepares the shared server for the Zalo sidecar: its OS user, the firewall around that user, the
# DNS-driven address list and the place for the reviewed bundle. Nothing here starts the sidecar
# or turns the adapter on (that is the ZALO_* settings of chat-api, a separate step). Run as root,
# from this directory:  bash setup-zalo-sandbox.sh
# Idempotent. Only the Zalo user's own outgoing traffic is ever filtered.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
die() { echo "setup-zalo-sandbox: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"

echo "== backup of the current rules"
backup="/root/iptables-before-zalo-sandbox-$(date +%Y%m%d-%H%M%S).rules"
( umask 077; iptables-save >"$backup" )
echo "saved $backup"

echo "== ipset"
rpm -q ipset >/dev/null 2>&1 || dnf install -y ipset >/dev/null
command -v ipset >/dev/null || die "ipset not installed"

echo "== user"
id zalo >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin zalo
[ "$(id -u zalo)" -ne 0 ] || die "zalo has uid 0"

echo "== files"
install -m 755 "$HERE/zalo-sandboxctl" /usr/local/sbin/zalo-sandboxctl
install -m 755 "$HERE/zalo-ipset-refresh" /usr/local/sbin/zalo-ipset-refresh
install -m 644 "$HERE/zalo-ipset-refresh.service" "$HERE/zalo-ipset-refresh.timer" "$HERE/zalo-sandbox.service" /etc/systemd/system/
install -d -m 755 /etc/zalo-sandbox /var/lib/zalo-sandbox
[ -e /etc/zalo-sandbox/hosts.conf ] || install -m 644 "$HERE/hosts.conf" /etc/zalo-sandbox/hosts.conf
[ -e /etc/zalo-sandbox/mode ] || echo enforce >/etc/zalo-sandbox/mode
# Root-owned, nobody else writes: the reviewed bundle is copied here by the deploy (or by hand).
install -d -m 755 -o root -g root /opt/chat/zalo-sidecar

echo "== sudoers rule (the one command chat-api may run as zalo)"
visudo -cf "$HERE/zalo-sidecar.sudoers" >/dev/null || die "zalo-sidecar.sudoers does not parse"
install -m 0440 -o root -g root "$HERE/zalo-sidecar.sudoers" /etc/sudoers.d/zalo-sidecar
visudo -c >/dev/null || { rm -f /etc/sudoers.d/zalo-sidecar; die "sudoers broke, rule removed"; }

echo "== units"
systemctl daemon-reload
systemctl enable --now zalo-ipset-refresh.timer >/dev/null
systemctl enable zalo-sandbox.service >/dev/null
systemctl start zalo-sandbox.service
/usr/local/sbin/zalo-sandboxctl status
