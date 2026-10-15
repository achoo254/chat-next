#!/bin/bash
# Smoke test of production from outside (run after every deploy):
#   bash infra/chat/smoke.sh [https://chat.hoandat.com]
# Checks the web app, the API health, that sign-in redirects to the IdP with
# the chat-web client, and that the realtime route refuses a socket without a
# session, and that the webhook route answers an unknown hook with
# hook_not_found, that the Bot API answers a call without a token with 401
# unauthorized, and (when configured) that the media host answers with
# storage reachable and strict headers. Exits non-zero on the first failure.
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
bot="$(curl -s -w ' %{http_code}' "$BASE/bot/v1/me")"
case "$bot" in *'"unauthorized"'*' 401') ;; *) fail "/bot/v1/me without a token -> $bot (want 401 unauthorized)" ;; esac
# Media host (when media is configured): storage reachable, unknown tokens
# 404, no cookie and strict headers.
MEDIA="${MEDIA_BASE:-https://media-chat.hoandat.com}"
media="$(curl -s --max-time 10 "$MEDIA/healthz" || true)"
case "$media" in
*'"storage":"reachable"'*)
	hdrs="$(curl -s -D - -o /dev/null "$MEDIA/f/smokeprobe")"
	case "$hdrs" in *" 404"*) ;; *) fail "$MEDIA/f/<bad token> is not 404" ;; esac
	case "$hdrs" in *[Nn]osniff*) ;; *) fail "$MEDIA/f/ lacks X-Content-Type-Options: nosniff" ;; esac
	case "$hdrs" in *[Ss]et-[Cc]ookie*) fail "$MEDIA sets a cookie" ;; esac
	code="$(curl -s -o /dev/null -w '%{http_code}' "$MEDIA/rpc/app.v1.UsersService/GetSelf")"
	[ "$code" = 404 ] || fail "app route on the media host -> $code (want 404)"
	;;
*'"storage"'*) fail "media storage unreachable: $media" ;;
*) echo "smoke: media not configured or host not served; skipped ($MEDIA)" ;;
esac
echo "smoke: ok ($BASE)"
