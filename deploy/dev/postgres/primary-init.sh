#!/bin/bash
# Runs once when the primary's data directory is created: a replication role
# and a pg_hba rule for the standby on the compose network.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
	-v password="$REPLICATION_PASSWORD" <<'SQL'
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD :'password';
SQL

echo "host replication replicator all scram-sha-256" >>"$PGDATA/pg_hba.conf"
