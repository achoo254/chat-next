#!/bin/bash
# Smoke test of production from outside (run after every deploy):
#   bash infra/chat/smoke.sh [https://chat.hoandat.com]
# Checks the web app, the API health, and that sign-in redirects to the IdP
# with the chat-web client. Exits non-zero on the first failure.
set -euo pipefail
BASE="${1:-https://chat.hoandat.com}"
fail() { echo "smoke: FAIL $*" >&2; exit 1; }

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$code" = 200 ] || fail "GET / -> $code"
curl -fsS "$BASE/healthz" | grep -q '"db":"connected"' || fail "/healthz not connected"
loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/login")"
case "$loc" in
https://auth.hoandat.com/*client_id=chat-web*) ;;
*) fail "/auth/login does not redirect to the IdP with chat-web" ;;
esac
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/proto' -H 'Connect-Protocol-Version: 1' -X POST --data-binary '' -H "Origin: $BASE" "$BASE/rpc/app.v1.UsersService/GetSelf")"
[ "$code" = 401 ] || fail "GetSelf without a session -> $code (want 401)"
echo "smoke: ok ($BASE)"
