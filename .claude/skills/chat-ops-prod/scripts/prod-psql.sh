#!/usr/bin/env bash
# Runs SQL from stdin with psql on server .65 against the chat database.
# The server-side wrapper /opt/chat/infra/psql.sh reads the connection from
# /opt/chat/.env into PG* variables, so no secret reaches argv or stdout.
#   prod-psql.sh < query.sql
# Read-only by default: back up (infra/chat/backup-chat-db.sh) before writing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$HERE/prod-ssh.sh" 'bash /opt/chat/infra/psql.sh'
