#!/bin/bash
# Clones the primary on first start, then runs as a streaming standby named
# "standby1", the name the primary lists in synchronous_standby_names.
# The clone creates the physical replication slot "standby1", so the primary
# keeps the WAL this standby still needs even after a long stop.
set -euo pipefail

export PGPASSWORD="$REPLICATION_PASSWORD"
if [ ! -s "$PGDATA/PG_VERSION" ]; then
	mkdir -p "$PGDATA"
	chown postgres:postgres "$PGDATA"
	chmod 700 "$PGDATA"
	for attempt in $(seq 1 30); do
		if gosu postgres pg_basebackup --host=postgres-primary --username=replicator \
			--pgdata="$PGDATA" --wal-method=stream --write-recovery-conf \
			--create-slot --slot=standby1 --checkpoint=fast; then
			break
		fi
		echo "pg_basebackup attempt $attempt failed; retrying in 2s" >&2
		rm -rf "${PGDATA:?}"/*
		if [ "$attempt" -eq 30 ]; then exit 1; fi
		sleep 2
	done
	echo "primary_conninfo = 'host=postgres-primary user=replicator password=${REPLICATION_PASSWORD} application_name=standby1'" \
		>>"$PGDATA/postgresql.auto.conf"
fi
unset PGPASSWORD
exec gosu postgres postgres -D "$PGDATA" -c hot_standby=on
