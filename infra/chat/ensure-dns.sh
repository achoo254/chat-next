#!/bin/bash
# Creates a proxied Cloudflare A record <name> -> this server's public IP if it
# does not exist (run as root on the server):
#   bash /opt/chat/infra/ensure-dns.sh media-chat.hoandat.com
# Uses the Zone:DNS:Edit token already on this server
# (/etc/letsencrypt/cloudflare-localman.ini, usable only from this IP); the
# token is read into a variable, passed through a header file descriptor and
# never printed. Idempotent: an existing record is left untouched.
set -euo pipefail
NAME="${1:?usage: ensure-dns.sh <host.hoandat.com>}"
ZONE_NAME=hoandat.com
CREDENTIALS=/etc/letsencrypt/cloudflare-localman.ini
API=https://api.cloudflare.com/client/v4
[[ "$NAME" == *".$ZONE_NAME" ]] || { echo "ensure-dns: $NAME is not in $ZONE_NAME" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "ensure-dns: run as root" >&2; exit 1; }

TOKEN="$(sed -n 's/^dns_cloudflare_api_token *= *//p' "$CREDENTIALS" | tr -d '[:space:]')"
[ -n "$TOKEN" ] || { echo "ensure-dns: no token in $CREDENTIALS" >&2; exit 1; }
cf() { curl -fsS -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") -H 'Content-Type: application/json' "$@"; }

ZONE_ID="$(cf "$API/zones?name=$ZONE_NAME" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')"
COUNT="$(cf "$API/zones/$ZONE_ID/dns_records?name=$NAME" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]))')"
if [ "$COUNT" != 0 ]; then
	echo "ensure-dns: $NAME already has $COUNT record(s); unchanged"
	exit 0
fi
IP="$(curl -fsS -4 https://api.ipify.org)"
cf -X POST "$API/zones/$ZONE_ID/dns_records" \
	--data "{\"type\":\"A\",\"name\":\"$NAME\",\"content\":\"$IP\",\"proxied\":true,\"ttl\":1}" >/dev/null
unset TOKEN
echo "ensure-dns: created proxied A record $NAME"
