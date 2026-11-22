#!/bin/bash
# Installs what a release carries for the Zalo sidecar: the reviewed bundle (zalo-sidecar/) and the
# firewall's host list (zalo-sandbox/hosts.conf). Run as root by activate-incoming.sh:
#   install-from-release.sh validate <release-dir>   before the release is activated; exit 2 refuses it
#   install-from-release.sh install  <release-dir>   after the release is active
# A release without these files changes nothing here.
#
# The upload comes from CI, so it is checked here, by a root-owned script that changes only through a
# root deploy (infra/chat/deploy.sh), before anything reaches the firewall:
#   - the bundle must be a plain file of a bounded size whose SHA-256 matches its .sha256 file;
#   - every host in hosts.conf must be a plain lower-case name under zalo.me, or one of the few exact
#     hosts named in EXTRA_HOSTS below. Widening the firewall beyond zalo.me therefore needs a change
#     to this script, which CI cannot make.
# The firewall mode (learn or enforce) is never touched.
set -euo pipefail

MODE="${1:?usage: install-from-release.sh validate|install <release-dir>}"
DIR="${2:?usage: install-from-release.sh validate|install <release-dir>}"
SIDECAR_DIR="${ZALO_SIDECAR_DIR:-/opt/chat/zalo-sidecar}"
HOSTS_FILE="${ZALO_HOSTS:-/etc/zalo-sandbox/hosts.conf}"
REFRESH="${ZALO_IPSET_REFRESH:-/usr/local/sbin/zalo-ipset-refresh}"
# Exact hosts outside zalo.me: jr.zaloapp.com is where a QR login's session check ends up.
EXTRA_HOSTS=" jr.zaloapp.com "
MAX_BUNDLE_BYTES=$((8 * 1024 * 1024))
MAX_HOSTS=64

BUNDLE="$DIR/zalo-sidecar/zalo-sidecar.cjs"
DIGEST="$DIR/zalo-sidecar/zalo-sidecar.cjs.sha256"
HOSTS="$DIR/zalo-sandbox/hosts.conf"

die() {
	echo "install-from-release: $*" >&2
	exit 2
}

# Owner arguments only when running as root (the tests run as an ordinary user).
OWNER=()
[ "$(id -u)" -eq 0 ] && OWNER=(-o root -g root)

[ -e "$DIR/zalo-sidecar" ] || [ -e "$DIR/zalo-sandbox" ] || {
	echo "release carries no Zalo files; nothing to install"
	exit 0
}

validate() {
	local f
	for f in "$BUNDLE" "$DIGEST" "$HOSTS"; do
		[ -f "$f" ] && [ ! -L "$f" ] || die "missing or not a plain file: ${f#"$DIR"/}"
	done
	[ "$(stat -c %s "$BUNDLE")" -le "$MAX_BUNDLE_BYTES" ] || die "bundle is larger than $MAX_BUNDLE_BYTES bytes"
	[ "$(wc -l <"$DIGEST")" -eq 1 ] && grep -Eq '^[0-9a-f]{64}  zalo-sidecar\.cjs$' "$DIGEST" || die "the .sha256 file is not '<64 hex>  zalo-sidecar.cjs'"
	(cd "$DIR/zalo-sidecar" && sha256sum -c --status zalo-sidecar.cjs.sha256) || die "bundle does not match its .sha256 file"

	local count=0 line
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in "" | \#*) continue ;; esac
		[[ "$line" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$ ]] || die "hosts.conf: not a plain lower-case name: '${line:0:80}'"
		if [ "$line" != zalo.me ] && [[ "$line" != *.zalo.me ]] && [[ "$EXTRA_HOSTS" != *" $line "* ]]; then
			die "hosts.conf: '$line' is not under zalo.me and not an approved exact host"
		fi
		count=$((count + 1))
	done <"$HOSTS"
	[ "$count" -ge 1 ] || die "hosts.conf lists no host"
	[ "$count" -le "$MAX_HOSTS" ] || die "hosts.conf lists more than $MAX_HOSTS hosts"
}

# Puts $1 in place of $2 (kept as $2.prev) unless they are the same. Prints whether it changed.
replace_file() {
	local src="$1" dst="$2"
	if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
		return 1
	fi
	[ ! -f "$dst" ] || cp -p "$dst" "$dst.prev"
	install -m 644 "${OWNER[@]}" "$src" "$dst.new"
	mv -f "$dst.new" "$dst"
}

install_files() {
	install -d -m 755 "${OWNER[@]}" "$SIDECAR_DIR" "$(dirname "$HOSTS_FILE")"
	local bundle_changed=0 hosts_changed=0
	replace_file "$BUNDLE" "$SIDECAR_DIR/zalo-sidecar.cjs" && bundle_changed=1
	replace_file "$DIGEST" "$SIDECAR_DIR/zalo-sidecar.cjs.sha256" && bundle_changed=1
	replace_file "$HOSTS" "$HOSTS_FILE" && hosts_changed=1
	echo "zalo sidecar bundle: $([ $bundle_changed = 1 ] && echo updated || echo unchanged); firewall host list: $([ $hosts_changed = 1 ] && echo updated || echo unchanged)"
	if [ "$hosts_changed" = 1 ] && [ -x "$REFRESH" ]; then
		# A failed DNS lookup makes the refresh exit 1 without removing anything; the timer retries.
		"$REFRESH" || echo "zalo-ipset-refresh reported a failed lookup; the timer will retry" >&2
	fi
}

case "$MODE" in
validate) validate ;;
install)
	validate
	install_files
	;;
*) die "unknown mode '$MODE'" ;;
esac
