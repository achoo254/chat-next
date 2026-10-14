#!/usr/bin/env bash
# Runs a command on server .65 (chat production, shared with other apps)
# as root, using the private key of entry SSH_SERVER_STAGING in
# $ALL_IN_ONE_STAGING_DEV. The key is written to a private temp dir that is
# removed on exit; no secret reaches argv or stdout.
#   prod-ssh.sh '<remote command>'        # stdin is forwarded: prod-ssh.sh 'bash -s' < local.sh
#   prod-ssh.sh                           # interactive shell
#   prod-ssh.sh --print-target            # host/port/user only (for deploy.sh, see SKILL.md)
# Read-only by default: anything that writes needs an explicit request from the user.
set -euo pipefail

ENTRY=SSH_SERVER_STAGING
FILE="${ALL_IN_ONE_STAGING_DEV:?set ALL_IN_ONE_STAGING_DEV to the staging/dev credential file}"

read -r HOST PORT LOGIN < <(jq -r --arg n "$ENTRY" \
	'.servers[] | select(.name == $n) | "\(.host) \(.port) \(.user)"' "$FILE")
[ -n "${HOST:-}" ] || { echo "entry $ENTRY not found in \$ALL_IN_ONE_STAGING_DEV" >&2; exit 2; }

if [ "${1:-}" = "--print-target" ]; then
	echo "$LOGIN@$HOST -p $PORT"
	exit 0
fi

KEY_DIR="$(mktemp -d)"
trap 'rm -rf "$KEY_DIR"' EXIT
umask 077
jq -r --arg n "$ENTRY" '.servers[] | select(.name == $n) | .private_key' "$FILE" >"$KEY_DIR/key"

ssh -i "$KEY_DIR/key" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 \
	-p "$PORT" "$LOGIN@$HOST" "$@"
