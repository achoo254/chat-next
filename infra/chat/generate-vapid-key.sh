#!/bin/bash
# Adds a Web Push VAPID private key to an env file, once:
#   bash generate-vapid-key.sh /opt/chat/.env     (production, as root)
#   bash infra/chat/generate-vapid-key.sh deploy/dev/.env
# The key is a fresh P-256 private key written as
# WEB_PUSH_VAPID_PRIVATE_KEY=<32-byte scalar, base64url>. The server derives
# the public key (the applicationServerKey browsers subscribe with) from it.
# An existing key is never replaced: browsers subscribed with the old key
# would stop getting pushes until the app subscribes them again.
# The private key is never printed; the public key is, to compare with
# what PushService.GetWebPushConfig returns after the restart.
set -euo pipefail

die() { echo "generate-vapid-key: $*" >&2; exit 1; }
ENV_FILE="${1:-}"
[ -n "$ENV_FILE" ] || die "usage: $0 <env file>"
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist"
if grep -q '^WEB_PUSH_VAPID_PRIVATE_KEY=' "$ENV_FILE"; then
	echo "generate-vapid-key: $ENV_FILE already has WEB_PUSH_VAPID_PRIVATE_KEY; left unchanged"
	exit 0
fi
command -v openssl >/dev/null || die "openssl is required"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
openssl ecparam -name prime256v1 -genkey -noout -outform DER -out "$tmp/key.der" 2>/dev/null
# SEC 1 ECPrivateKey of P-256 without parameters' surprises:
# 30 77 02 01 01 04 20 <32-byte scalar> a0 0a <curve oid> a1 44 03 42 00 <65-byte public key>.
[ "$(head -c 7 "$tmp/key.der" | od -An -tx1 | tr -d ' \n')" = "30770201010420" ] \
	|| die "unexpected key encoding from openssl"
[ "$(wc -c <"$tmp/key.der" | tr -d ' ')" = "121" ] || die "unexpected key length from openssl"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
private="$(tail -c +8 "$tmp/key.der" | head -c 32 | b64url)"
public="$(tail -c 65 "$tmp/key.der" | b64url)"
[ "${#private}" -eq 43 ] && [ "${#public}" -eq 87 ] || die "unexpected key sizes"

printf 'WEB_PUSH_VAPID_PRIVATE_KEY=%s\n' "$private" >>"$ENV_FILE"
unset private
echo "generate-vapid-key: added WEB_PUSH_VAPID_PRIVATE_KEY to $ENV_FILE"
echo "generate-vapid-key: public key (applicationServerKey) $public"
