#!/bin/bash
# Tests for install-from-release.sh: what it installs, and above all what it refuses.
#   bash infra/chat/zalo-sandbox/install-from-release.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/install-from-release.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
fails=0

pass() { echo "ok   - $1"; }
fail() {
	echo "FAIL - $1"
	fails=$((fails + 1))
}

# A release directory with a valid bundle and the given host lines.
make_release() {
	local dir="$1"
	shift
	rm -rf "$dir"
	mkdir -p "$dir/zalo-sidecar" "$dir/zalo-sandbox"
	printf 'bundle %s\n' "$RANDOM$RANDOM" >"$dir/zalo-sidecar/zalo-sidecar.cjs"
	# The file is "<digest>  <name>" as on Linux; Git Bash's sha256sum writes " *" for binary mode.
	(cd "$dir/zalo-sidecar" && sha256sum zalo-sidecar.cjs | sed 's/ \*/  /' >zalo-sidecar.cjs.sha256)
	printf '%s\n' "$@" >"$dir/zalo-sandbox/hosts.conf"
}

# Runs the script against a fresh set of destinations; $1 is the mode, $2 the release.
run() {
	ZALO_SIDECAR_DIR="$WORK/dest/sidecar" ZALO_HOSTS="$WORK/dest/etc/hosts.conf" ZALO_IPSET_REFRESH="$WORK/refresh.sh" \
		bash "$SCRIPT" "$1" "$2" >"$WORK/out.txt" 2>&1
}

printf '#!/bin/bash\necho refreshed >>"%s/refresh.log"\n' "$WORK" >"$WORK/refresh.sh"
chmod +x "$WORK/refresh.sh"

GOOD=(zalo.me id.zalo.me chat.zalo.me ws12-msg.chat.zalo.me jr.zaloapp.com "# a comment" "")

# 1. A release without Zalo files changes nothing.
mkdir -p "$WORK/plain"
if run install "$WORK/plain" && [ ! -e "$WORK/dest" ]; then pass "a release without Zalo files installs nothing"; else fail "a release without Zalo files installs nothing"; fi

# 2. A good release is installed, and the host list is refreshed.
make_release "$WORK/r1" "${GOOD[@]}"
if run install "$WORK/r1" &&
	cmp -s "$WORK/r1/zalo-sidecar/zalo-sidecar.cjs" "$WORK/dest/sidecar/zalo-sidecar.cjs" &&
	cmp -s "$WORK/r1/zalo-sidecar/zalo-sidecar.cjs.sha256" "$WORK/dest/sidecar/zalo-sidecar.cjs.sha256" &&
	cmp -s "$WORK/r1/zalo-sandbox/hosts.conf" "$WORK/dest/etc/hosts.conf" &&
	[ "$(wc -l <"$WORK/refresh.log")" -eq 1 ]; then pass "a good release is installed and the address list refreshed"; else fail "a good release is installed and the address list refreshed"; fi

# 3. The same release again changes nothing and does not refresh.
if run install "$WORK/r1" && grep -q "unchanged" "$WORK/out.txt" && [ "$(wc -l <"$WORK/refresh.log")" -eq 1 ]; then pass "the same release again is unchanged and not refreshed"; else fail "the same release again is unchanged and not refreshed"; fi

# 4. A new release replaces the files and keeps the old ones as .prev.
cp "$WORK/dest/sidecar/zalo-sidecar.cjs" "$WORK/old-bundle"
make_release "$WORK/r2" "${GOOD[@]}" ws1-msg.chat.zalo.me
if run install "$WORK/r2" &&
	cmp -s "$WORK/r2/zalo-sidecar/zalo-sidecar.cjs" "$WORK/dest/sidecar/zalo-sidecar.cjs" &&
	cmp -s "$WORK/old-bundle" "$WORK/dest/sidecar/zalo-sidecar.cjs.prev" &&
	[ "$(wc -l <"$WORK/refresh.log")" -eq 2 ]; then pass "a new release replaces the files and keeps the old ones as .prev"; else fail "a new release replaces the files and keeps the old ones as .prev"; fi

# 5. Hosts that must be refused, each in its own release; nothing may change.
snapshot() { cat "$WORK/dest/sidecar/zalo-sidecar.cjs" "$WORK/dest/etc/hosts.conf"; }
before="$(snapshot)"
for bad in evil.com zaloapp.com x.jr.zaloapp.com chat.zaloapp.com zalo.me.evil.com notzalo.me ID.ZALO.ME 10.0.0.1 "zalo.me." "a b.zalo.me" "-x.zalo.me" "chat.zalo.me/x" "*.zalo.me"; do
	make_release "$WORK/bad" zalo.me "$bad"
	if run install "$WORK/bad"; then fail "refuses host '$bad'"; elif [ "$(snapshot)" != "$before" ]; then fail "host '$bad' refused but something changed"; else pass "refuses host '$bad'"; fi
done

# 6. A host list with no host, with a carriage return, or with too many hosts.
make_release "$WORK/bad" "# only a comment"
if run install "$WORK/bad"; then fail "refuses a list with no host"; else pass "refuses a list with no host"; fi
make_release "$WORK/bad" zalo.me
printf 'id.zalo.me\r\n' >>"$WORK/bad/zalo-sandbox/hosts.conf"
if run install "$WORK/bad"; then fail "refuses a carriage return"; else pass "refuses a carriage return"; fi
many=()
for i in $(seq 1 70); do many+=("ws$i-msg.chat.zalo.me"); done
make_release "$WORK/bad" "${many[@]}"
if run install "$WORK/bad"; then fail "refuses more than 64 hosts"; else pass "refuses more than 64 hosts"; fi

# 7. A bundle that does not match its digest, a malformed digest, a missing file.
make_release "$WORK/bad" "${GOOD[@]}"
echo tampered >>"$WORK/bad/zalo-sidecar/zalo-sidecar.cjs"
if run install "$WORK/bad"; then fail "refuses a bundle that does not match its digest"; else pass "refuses a bundle that does not match its digest"; fi
make_release "$WORK/bad" "${GOOD[@]}"
echo "not a digest" >"$WORK/bad/zalo-sidecar/zalo-sidecar.cjs.sha256"
if run install "$WORK/bad"; then fail "refuses a malformed digest"; else pass "refuses a malformed digest"; fi
make_release "$WORK/bad" "${GOOD[@]}"
rm "$WORK/bad/zalo-sandbox/hosts.conf"
if run install "$WORK/bad"; then fail "refuses a release with a missing file"; else pass "refuses a release with a missing file"; fi

# 8. A symbolic link in place of the bundle (skipped where links cannot be made).
make_release "$WORK/bad" "${GOOD[@]}"
mv "$WORK/bad/zalo-sidecar/zalo-sidecar.cjs" "$WORK/real.cjs"
if ln -s "$WORK/real.cjs" "$WORK/bad/zalo-sidecar/zalo-sidecar.cjs" 2>/dev/null && [ -L "$WORK/bad/zalo-sidecar/zalo-sidecar.cjs" ]; then
	if run install "$WORK/bad"; then fail "refuses a symbolic link"; else pass "refuses a symbolic link"; fi
else
	echo "skip - symbolic links cannot be made here"
fi

# 9. validate alone installs nothing.
rm -rf "$WORK/dest"
make_release "$WORK/r3" "${GOOD[@]}"
if run validate "$WORK/r3" && [ ! -e "$WORK/dest" ]; then pass "validate alone installs nothing"; else fail "validate alone installs nothing"; fi

# 10. After a refusal the destinations still hold the last good release.
run install "$WORK/r1" >/dev/null
before="$(snapshot)"
make_release "$WORK/bad" zalo.me evil.com
run install "$WORK/bad" >/dev/null
if [ "$(snapshot)" = "$before" ]; then pass "a refused release leaves the last good files in place"; else fail "a refused release leaves the last good files in place"; fi

echo
if [ "$fails" -eq 0 ]; then echo "all passed"; else echo "$fails failed"; fi
exit "$fails"
