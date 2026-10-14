#!/bin/bash
# Activates an uploaded release on the server (run as root):
#   bash /opt/chat/infra/activate-release.sh <release-id>
# Steps: back up the database, run migrations with the new binary, install the
# release's nginx conf, switch /opt/chat/current, start or reload pm2
# `chat-api`, wait for /healthz. Any failure after the switch restores the
# previous release and nginx conf. Migrations are expand-only (backward
# compatible), so the previous binary keeps working on the migrated schema.
# Keeps the newest 5 releases.
set -euo pipefail

ROOT=/opt/chat
ID="${1:?usage: activate-release.sh <release-id>}"
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}(-dirty)?$ ]] || { echo "bad release id" >&2; exit 2; }
NEW="$ROOT/releases/$ID"
[ -x "$NEW/server" ] || { echo "release $ID not found or incomplete" >&2; exit 2; }
CONF=/etc/nginx/conf.d/chat.hoandat.com.conf
PREV="$(readlink "$ROOT/current" 2>/dev/null || true)"

chmod -R a+rX "$NEW"

echo "== backup database"
bash "$ROOT/infra/backup-chat-db.sh"

echo "== migrate"
sudo -u chat "$NEW/server" -role migrate -env-file "$ROOT/.env"

health() {
	for _ in $(seq 1 30); do
		if curl -fsS --max-time 2 http://127.0.0.1:4600/healthz | grep -q '"db":"connected"'; then return 0; fi
		sleep 1
	done
	return 1
}

rollback() {
	echo "!! activation failed, restoring ${PREV:-nothing}" >&2
	if [ -n "$PREV" ]; then
		ln -sfn "$PREV" "$ROOT/current"
		[ -f "$PREV/nginx/chat.hoandat.com.conf" ] && install -m 644 "$PREV/nginx/chat.hoandat.com.conf" "$CONF"
		nginx -t && systemctl reload nginx || true
		pm2 startOrReload "$ROOT/infra/ecosystem.config.cjs" --only chat-api --update-env || true
	fi
	exit 1
}

echo "== nginx"
cp -p "$CONF" "$CONF.prev" 2>/dev/null || true
install -m 644 "$NEW/nginx/chat.hoandat.com.conf" "$CONF"
if ! nginx -t; then
	if [ -f "$CONF.prev" ]; then mv "$CONF.prev" "$CONF"; else rm -f "$CONF"; fi
	echo "nginx -t failed; release not activated" >&2
	exit 1
fi

echo "== switch and start"
ln -sfn "$NEW" "$ROOT/current"
systemctl reload nginx
# Through the ecosystem file, so option changes (kill_timeout, memory cap)
# apply on every deploy.
pm2 startOrReload "$ROOT/infra/ecosystem.config.cjs" --only chat-api --update-env || rollback
pm2 save >/dev/null
health || rollback

echo "== prune"
ls -1dt "$ROOT"/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "activated $ID"
