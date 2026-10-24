#!/bin/bash
# Rotates SESSION_KEY of the chat app (/opt/chat/.env, pm2 chat-api) without
# signing anyone out (docs/operations/key-rotation.md).
#   bash rotate-session-key.sh start          # new key, old one kept as previous
#   bash rotate-session-key.sh finish [--now] # drop the previous key, 6 h after start
#   bash rotate-session-key.sh reseal         # reseal only (no key change)
#
# start: backs up the database and the env file (<env>.rotate-bak-<time>),
# moves SESSION_KEY to SESSION_KEY_PREVIOUS, writes a new SESSION_KEY,
# reloads the process and runs the server role reseal, which seals every
# stored value again under the new key. finish: refuses within 6 hours of
# start (outstanding media upload URLs are signed with the old key) unless
# --now (leaked key); reseals with the previous key still set and stops if
# anything is unreadable; then removes SESSION_KEY_PREVIOUS, reloads,
# reseals again and deletes the env backups of this rotation, the last
# copies of the old key. Run as root; never prints keys (the reseal role
# logs key ids only).
set -euo pipefail

USAGE="usage: rotate-session-key.sh start|finish|reseal [--now]"
STEP="${1:?$USAGE}"
shift
NOW=""
for a in "$@"; do
	case "$a" in
	--now) NOW=1 ;;
	*) echo "$USAGE" >&2; exit 2 ;;
	esac
done
WAIT_SECONDS=$((6 * 3600))
ROOT=/opt/chat
FILE="$ROOT/.env" PROC=chat-api

die() { echo "rotate-session-key: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[ -s "$FILE" ] || die "missing $FILE"
[ "$(grep -c '^SESSION_KEY=.' "$FILE")" -eq 1 ] || die "$FILE needs exactly one SESSION_KEY line"
[ "$(grep -c '^SESSION_KEY_PREVIOUS=' "$FILE")" -le 1 ] || die "$FILE has more than one SESSION_KEY_PREVIOUS line"
has_previous() { grep -q '^SESSION_KEY_PREVIOUS=' "$FILE"; }
MARK="$FILE.rotation-started"

backup_env() {
	local copy
	copy="$FILE.rotate-bak-$(date +%Y%m%d-%H%M%S)"
	cp -p "$FILE" "$copy"
	echo "rotate-session-key: env backup $copy"
}

TMP=""
trap 'rm -f "$TMP"' EXIT

# rewrite writes the env file through a temporary copy with the same owner
# and mode; awk reads the new key from the environment, not argv.
rewrite() {
	TMP="$(mktemp "$FILE.XXXXXX")"
	chown --reference="$FILE" "$TMP"
	chmod --reference="$FILE" "$TMP"
	awk "$1" "$FILE" >"$TMP"
	mv "$TMP" "$FILE"
	TMP=""
}

reseal() { sudo -u chat "$ROOT/current/server" -role reseal -env-file "$FILE"; }

reload() {
	pm2 startOrReload "$ROOT/infra/ecosystem.config.cjs" --only "$PROC" --update-env >/dev/null
	pm2 save >/dev/null
}

case "$STEP" in
start)
	has_previous && die "SESSION_KEY_PREVIOUS is set: a rotation is under way; run finish first"
	bash "$ROOT/infra/backup-chat-db.sh"
	backup_env
	# shellcheck disable=SC2016 # awk program, not shell
	NEW_KEY="$(openssl rand -base64 48 | tr -d '\n')" rewrite '
		/^SESSION_KEY=/ { print "SESSION_KEY_PREVIOUS=" substr($0, 13); print "SESSION_KEY=" ENVIRON["NEW_KEY"]; next }
		{ print }'
	date +%s >"$MARK"
	again="the new key is in place; fix the cause, then run: rotate-session-key.sh reseal"
	reload || die "reloading $PROC failed: $again"
	reseal || die "reseal failed: $again"
	echo "rotate-session-key: started; run finish in 6 hours or later"
	;;
finish)
	has_previous || die "no SESSION_KEY_PREVIOUS: nothing to finish"
	if [ -z "$NOW" ]; then
		started="$(cat "$MARK" 2>/dev/null || echo 0)"
		left=$((started + WAIT_SECONDS - $(date +%s)))
		[ "$left" -le 0 ] || die "started less than 6 hours ago ($((left / 60)) minutes left); --now only for a leaked key"
	fi
	reseal || die "values still need the previous key; SESSION_KEY_PREVIOUS stays (docs/operations/key-rotation.md)"
	backup_env
	rewrite '!/^SESSION_KEY_PREVIOUS=/'
	reload
	reseal
	rm -f "$FILE".rotate-bak-* "$MARK"
	echo "rotate-session-key: finished; the env backups of this rotation are deleted"
	;;
reseal)
	reseal
	;;
*)
	die "unknown step $STEP (start, finish or reseal)"
	;;
esac
