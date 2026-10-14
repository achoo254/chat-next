#!/bin/bash
# Dumps the chat database to /opt/chat/backups/chat-<UTC time>.dump (custom
# format, restorable with pg_restore) and keeps the newest 14. Runs from cron
# at 02:50 and before every migration (activate-release.sh). The connection
# comes from /opt/chat/.env through PG* variables, never argv.
set -euo pipefail
DIR=/opt/chat/backups
KEEP=14
# shellcheck source=/dev/null
. /opt/chat/infra/pg-env.sh
name="chat-$(date -u +%Y%m%d-%H%M%S).dump"
pg_dump --format=custom --no-owner --file "$DIR/$name.tmp"
mv "$DIR/$name.tmp" "$DIR/$name"
chmod 640 "$DIR/$name"
ls -1t "$DIR"/chat-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$(date -Is) backup $name ok"
