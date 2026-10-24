#!/bin/bash
# First-time (and idempotent) setup of chat on the shared server .65. Run as
# root from /opt/chat/infra after deploy.sh has synced this directory:
#   bash /opt/chat/infra/setup-server.sh
# It creates the system user, directories, the Postgres role and database
# (on the shared PostgreSQL, with its own pg_hba lines), the .env values that
# are generated on the server, the backup cron and the nginx http-level conf.
# Existing values are never overwritten; secrets are never printed.
set -euo pipefail

APP=chat
ROOT=/opt/chat
ENV_FILE="$ROOT/.env"
LOG_DIR=/var/log/chat
DB=chat

die() { echo "setup-server: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"

echo "== user and directories"
id "$APP" >/dev/null 2>&1 || useradd --system --home-dir "$ROOT" --shell /sbin/nologin "$APP"
install -d -m 755 "$ROOT" "$ROOT/releases" "$ROOT/infra"
install -d -m 750 -o root -g "$APP" "$ROOT/backups"
# Media files (MEDIA_ROOT): private to the app user.
install -d -m 750 -o "$APP" -g "$APP" "$ROOT/media"
# Root-owned: the root pm2 daemon and the root backup cron append here, and
# an app-writable directory would let the app swap a log for a symlink.
install -d -m 755 -o root -g root "$LOG_DIR"
chown root:root "$LOG_DIR"
chmod 755 "$LOG_DIR"

echo "== .env (generated values only when missing)"
touch "$ENV_FILE"
chown root:"$APP" "$ENV_FILE"
chmod 640 "$ENV_FILE"
set_default() { grep -q "^$1=" "$ENV_FILE" || printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"; }
set_default CHAT_ENV production
set_default CHAT_LISTEN_ADDR 127.0.0.1:4600
set_default CHAT_PUBLIC_URL https://chat.hoandat.com
set_default OIDC_ISSUER https://auth.hoandat.com
set_default OIDC_CLIENT_ID chat-web
set_default TENANT_DOMAIN hoandat.com
grep -q '^OIDC_CLIENT_SECRET=' "$ENV_FILE" || die "OIDC_CLIENT_SECRET missing: copy CHAT_WEB_CLIENT_SECRET from the IdP .env (see docs/deployment-guide.md)"
grep -q '^SESSION_KEY=' "$ENV_FILE" || printf 'SESSION_KEY=%s\n' "$(openssl rand -base64 48 | tr -d '\n')" >>"$ENV_FILE"
# Web Push (PWA notifications): VAPID key, generated once and never replaced.
bash "$(dirname "$0")/generate-vapid-key.sh" "$ENV_FILE"

echo "== postgres role and database"
if ! grep -q '^DATABASE_URL=' "$ENV_FILE"; then
	pw="$(openssl rand -hex 32)"
	if sudo -u postgres psql -Atc "select 1 from pg_roles where rolname='$DB'" | grep -q 1; then
		sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v pw="$pw" <<'SQL'
ALTER ROLE chat WITH LOGIN PASSWORD :'pw';
SQL
	else
		sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v pw="$pw" <<'SQL'
CREATE ROLE chat WITH LOGIN PASSWORD :'pw';
SQL
	fi
	printf 'DATABASE_URL=postgres://%s:%s@127.0.0.1:5432/%s?sslmode=disable\n' "$DB" "$pw" "$DB" >>"$ENV_FILE"
	unset pw
fi
sudo -u postgres psql -Atc "select 1 from pg_database where datname='$DB'" | grep -q 1 ||
	sudo -u postgres createdb -O "$DB" "$DB"

HBA="$(sudo -u postgres psql -Atc 'show hba_file')"
if ! grep -qE "^host[[:space:]]+${DB}[[:space:]]+${DB}[[:space:]]+127\.0\.0\.1/32" "$HBA"; then
	cp -p "$HBA" "$HBA.bak-$(date -u +%Y%m%d-%H%M%S)"
	# Own lines before the generic `ident` lines, like the other apps on this server.
	awk -v db="$DB" '
		!done && /^host[[:space:]]+all[[:space:]]+all[[:space:]]+127\.0\.0\.1\/32/ {
			printf "host %s %s 127.0.0.1/32 scram-sha-256\nhost %s %s ::1/128 scram-sha-256\n", db, db, db, db
			done = 1
		}
		{ print }' "$HBA" >"$HBA.new"
	cat "$HBA.new" >"$HBA" && rm -f "$HBA.new"
	sudo -u postgres psql -Atc 'select pg_reload_conf()' >/dev/null
	echo "pg_hba: added $DB lines and reloaded"
fi

echo "== backup cron (02:50, after the IdP 02:30 and Localman 02:45)"
printf '50 2 * * * root bash %s/infra/backup-chat-db.sh >> %s/backup.log 2>&1\n' "$ROOT" "$LOG_DIR" >/etc/cron.d/chat-backup
chmod 644 /etc/cron.d/chat-backup

echo "== nginx http-level conf"
install -m 644 "$ROOT/infra/nginx/chat-http.conf" /etc/nginx/conf.d/chat-http.conf
nginx -t && systemctl reload nginx

echo "setup-server: done"
