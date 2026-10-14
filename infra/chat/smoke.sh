#!/bin/bash
# Smoke test of production from outside (run after every deploy):
#   bash infra/chat/smoke.sh [https://chat.hoandat.com]
# Checks the web app, the API health, that sign-in redirects to the IdP with
# the chat-web client, and that the realtime route refuses a socket without a
# session, and that the webhook route answers an unknown hook with
# hook_not_found. Exits non-zero on the first failure.
set -euo pipefail
BASE="${1:-https://chat.hoandat.com}"
fail() { echo "smoke: FAIL $*" >&2; exit 1; }

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$code" = 200 ] || fail "GET / -> $code"
curl -fsS "$BASE/healthz" | grep -q '"db":"connected"' || fail "/healthz not connected"
# Right after a restart the API discovers the IdP in the background and
# answers 503 until then, so give sign-in a short grace period.
login_ok=""
for _ in $(seq 1 15); do
	loc="$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/auth/login")"
	case "$loc" in
	https://auth.hoandat.com/*client_id=chat-web*) login_ok=1; break ;;
	esac
	sleep 2
done
[ -n "$login_ok" ] || fail "/auth/login does not redirect to the IdP with chat-web"
code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/proto' -H 'Connect-Protocol-Version: 1' -X POST --data-binary '' -H "Origin: $BASE" "$BASE/rpc/app.v1.UsersService/GetSelf")"
[ "$code" = 401 ] || fail "GetSelf without a session -> $code (want 401)"
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $BASE" "$BASE/ws")"
[ "$code" = 401 ] || fail "/ws without a session -> $code (want 401)"
hook="$(curl -s -X POST -H 'Content-Type: application/json' --data '{}' "$BASE/hook/hk_AAAAAAAAAAAA/smokeprobe0000000000")"
case "$hook" in *'"hook_not_found"'*) ;; *) fail "/hook/ unknown hook -> $hook (want hook_not_found)" ;; esac
echo "smoke: ok ($BASE)"
