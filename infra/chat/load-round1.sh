#!/usr/bin/env bash
# Load test round 1 on the shared production server, run from the dev
# machine (needs Go):
#   SSH_TARGET=root@103.72.98.65 SSH_OPTS="-i key -p 24700 -o IdentitiesOnly=yes" \
#     bash infra/chat/load-round1.sh 250,500,1000 [profile]
# It builds server/cmd/loadgen for linux, uploads it and runs, on the
# server, a throwaway tenant as user nobody under /tmp/chat-load (its own
# PostgreSQL on 127.0.0.1:4930, a fake IdP, the api on 127.0.0.1:4900; the
# shared PostgreSQL and pm2 chat-api are not touched), then the scenario
# step by step with a 30% free-memory guard. With "profile" it also takes a
# 20 s CPU profile of the api during the last step and copies it to
# ${TMPDIR:-/tmp}/load-cpu.prof. Everything on the server is removed at the end, also on
# failure.
set -euo pipefail
STEPS="${1:-250,500,1000}"
PROFILE="${2:-}"
: "${SSH_TARGET:?set SSH_TARGET}"
SSH_OPTS="${SSH_OPTS:-}"
read -r -a OPTS <<<"$SSH_OPTS"
SCP_OPTS=()
for ((i = 0; i < ${#OPTS[@]}; i++)); do
	if [ "${OPTS[$i]}" = "-p" ]; then SCP_OPTS+=(-P "${OPTS[$((i + 1))]}"); i=$((i + 1)); else SCP_OPTS+=("${OPTS[$i]}"); fi
done

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$(mktemp -d)"
trap 'rm -rf "$BIN"' EXIT
(cd "$ROOT/server" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$BIN/loadgen" ./cmd/loadgen)
ssh "${OPTS[@]}" "$SSH_TARGET" 'rm -rf /tmp/chat-load && mkdir -p /tmp/chat-load'
scp -q "${SCP_OPTS[@]}" "$BIN/loadgen" "$SSH_TARGET:/tmp/chat-load/loadgen"

ssh "${OPTS[@]}" "$SSH_TARGET" STEPS="$STEPS" PROFILE="$PROFILE" bash -s <<'REMOTE'
set -euo pipefail
D=/tmp/chat-load
cleanup() {
	[ -s "$D/stack.log" ] && { echo "== stack log"; grep -v 'level=WARN' "$D/stack.log" | tail -5; }
	pkill -TERM -f "$D/loadgen" 2>/dev/null || true
	sleep 5
	pkill -KILL -f "$D/" 2>/dev/null || true
	[ -s "$D/cpu.prof" ] && cp "$D/cpu.prof" /root/load-cpu.prof
	rm -rf "$D"
	echo "cleanup: load stack stopped, $D removed"
}
trap cleanup EXIT
chown -R nobody "$D"
chmod 700 "$D/loadgen"
echo "before: $(free -m | awk '/Mem:/ {print "available " $7 " MB of " $2}'), load $(cut -d' ' -f1-3 /proc/loadavg)"
ACCOUNTS="$(echo "$STEPS" | tr ',' '\n' | sort -n | tail -1)"
runuser -u nobody -- env HOME="$D" TMPDIR="$D" "$D/loadgen" stack -api 127.0.0.1:4900 -idp 127.0.0.1:4910 \
	-pg-port 4930 -pprof 127.0.0.1:4920 -accounts "$ACCOUNTS" >"$D/stack.log" 2>&1 &
for _ in $(seq 1 180); do grep -q 'ready' "$D/stack.log" 2>/dev/null && break; sleep 1; done
PID="$(grep -o 'server pid [0-9]*' "$D/stack.log" | awk '{print $3}')"
[ -n "$PID" ] || { echo "the load stack did not start"; exit 1; }
LAST="$(echo "$STEPS" | tr ',' '\n' | tail -1)"
"$D/loadgen" run -api http://127.0.0.1:4900 -steps "$STEPS" -duration 45s -warmup 10s -server-pid "$PID" \
	-parallel 20 -min-free-pct 30 2>"$D/run.err" &
RUN=$!
if [ -n "$PROFILE" ]; then
	until grep -q "^loadgen: $LAST people online" "$D/run.err" 2>/dev/null || ! kill -0 "$RUN" 2>/dev/null; do sleep 1; done
	sleep 15
	curl -s -o "$D/cpu.prof" "http://127.0.0.1:4920/debug/pprof/profile?seconds=20" || true
fi
wait "$RUN" || true
grep -v '^loadgen: .* people online' "$D/run.err" || true
echo "after: $(free -m | awk '/Mem:/ {print "available " $7 " MB of " $2}'), load $(cut -d' ' -f1-3 /proc/loadavg)"
REMOTE

if [ -n "$PROFILE" ]; then
	OUT="${TMPDIR:-/tmp}/load-cpu.prof"
	scp -q "${SCP_OPTS[@]}" "$SSH_TARGET:/root/load-cpu.prof" "$OUT" &&
		ssh "${OPTS[@]}" "$SSH_TARGET" 'rm -f /root/load-cpu.prof' &&
		echo "CPU profile: $OUT (go tool pprof -top $OUT)"
fi
