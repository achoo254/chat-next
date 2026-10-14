#!/bin/bash
# psql on the chat database with the connection from /opt/chat/.env (used by
# .claude/skills/chat-ops-prod/scripts/prod-psql.sh). SQL comes from stdin.
set -euo pipefail
# shellcheck source=/dev/null
. /opt/chat/infra/pg-env.sh
exec psql -X -q -v ON_ERROR_STOP=1 "$@"
