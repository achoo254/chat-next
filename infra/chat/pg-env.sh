#!/bin/bash
# Sourced by the other scripts: exports PGHOST/PGPORT/PGUSER/PGPASSWORD/
# PGDATABASE parsed from DATABASE_URL in /opt/chat/.env, so psql and pg_dump
# never receive the password in argv.
url="$(grep -m1 '^DATABASE_URL=' /opt/chat/.env | cut -d= -f2-)"
[ -n "$url" ] || { echo "pg-env: DATABASE_URL missing in /opt/chat/.env" >&2; exit 1; }
rest="${url#*://}"
creds="${rest%%@*}"
hostpart="${rest#*@}"
export PGUSER="${creds%%:*}"
export PGPASSWORD="${creds#*:}"
hostport="${hostpart%%/*}"
export PGHOST="${hostport%%:*}"
export PGPORT="${hostport##*:}"
db="${hostpart#*/}"
export PGDATABASE="${db%%\?*}"
unset url rest creds hostpart hostport db
