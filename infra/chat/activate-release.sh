#!/bin/bash
# Activates an uploaded release on the server (run as root):
#   bash /opt/chat/infra/activate-release.sh <release-id>
# Steps: back up the database, run migrations with the new binary, install the
# release's nginx conf, switch /opt/chat/current, start or reload pm2
# `chat-api`, wait for /healthz, the realtime route /ws, the webhook route
# /hook/, the Bot API /bot/ and (when configured) the media host. Any failure after the switch restores the
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
# The media host conf goes in only once its certificate exists (nginx -t
# fails on a missing certificate file).
MEDIA_CONF=/etc/nginx/conf.d/media-chat.hoandat.com.conf
MEDIA_CERT=/etc/letsencrypt/live/media-chat.hoandat.com/fullchain.pem
# Chat tenants other than the primary one (setup-tenant.sh): their nginx
# block, built from the release's conf, needs hoandat-auth's $tenant_cert
# map.
TENANTS_DIR="$ROOT/tenants"
TENANTS_CONF=/etc/nginx/conf.d/chat-tenants.conf
TENANT_CERT_MAP=/etc/nginx/conf.d/00-tenants-http.conf
PREV="$(readlink "$ROOT/current" 2>/dev/null || true)"

chmod -R a+rX "$NEW"

echo "== backup database"
bash "$ROOT/infra/backup-chat-db.sh"

echo "== media directory"
# The app cannot create it under root-owned /opt/chat; files stay private
# to the chat user (0750 directories, 0640 files).
MEDIA_ROOT="$(sed -n 's/^MEDIA_ROOT=//p' "$ROOT/.env" | tail -n 1)"
MEDIA_ROOT="${MEDIA_ROOT:-$ROOT/media}"
install -d -m 750 -o chat -g chat "$MEDIA_ROOT"

echo "== migrate"
sudo -u chat "$NEW/server" -role migrate -env-file "$ROOT/.env"

health() {
	for _ in $(seq 1 30); do
		if curl -fsS --max-time 2 http://127.0.0.1:4600/healthz | grep -q '"db":"connected"'; then return 0; fi
		sleep 1
	done
	return 1
}

# The realtime gateway answers a plain GET without Origin with 403 (an
# unknown route would be 404), through the app and through nginx.
realtime() {
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1:4600/ws)" = 403 ] || return 1
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve chat.hoandat.com:443:127.0.0.1 https://chat.hoandat.com/ws)" = 403 ]
}

# The webhook endpoint answers an unknown hook with 404 and the code
# hook_not_found in its JSON body (nginx's own 404 has no such body),
# through the app and through nginx.
hooks() {
	local probe='/hook/hk_AAAAAAAAAAAA/smokeprobe0000000000'
	curl -s -X POST --max-time 2 -H 'Content-Type: application/json' --data '{}' "http://127.0.0.1:4600$probe" | grep -q '"hook_not_found"' || return 1
	curl -s -X POST --max-time 5 --resolve chat.hoandat.com:443:127.0.0.1 -H 'Content-Type: application/json' --data '{}' \
		"https://chat.hoandat.com$probe" | grep -q '"hook_not_found"'
}

# The Bot API answers a call without a token with 401 and the code
# unauthorized in its JSON envelope (nginx's own errors have no such body),
# through the app and through nginx.
bots() {
	curl -s --max-time 2 -H 'Host: chat.hoandat.com' http://127.0.0.1:4600/bot/v1/me | grep -q '"unauthorized"' || return 1
	curl -s --max-time 5 --resolve chat.hoandat.com:443:127.0.0.1 https://chat.hoandat.com/bot/v1/me | grep -q '"unauthorized"'
}

# With media configured (MEDIA_PUBLIC_URL in .env) the media host answers
# /healthz with the storage state, through the app and through nginx. A
# storage outage does not roll back a release: chat keeps working, media
# calls fail until the storage answers; it is reported as a warning.
media() {
	grep -q '^MEDIA_PUBLIC_URL=.' "$ROOT/.env" || { echo "media not configured; skipping media checks"; return 0; }
	local direct
	direct="$(curl -s --max-time 5 -H 'Host: media-chat.hoandat.com' http://127.0.0.1:4600/healthz)"
	case "$direct" in *'"storage"'*) ;; *) return 1 ;; esac
	case "$direct" in *'"reachable"'*) ;; *) echo "WARNING: media storage unreachable: $direct" >&2 ;; esac
	[ -f "$MEDIA_CONF" ] || { echo "WARNING: media host conf not installed (certificate missing)" >&2; return 0; }
	[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 --resolve media-chat.hoandat.com:443:127.0.0.1 \
		https://media-chat.hoandat.com/f/smokeprobe)" = 404 ]
}

# Each tenant's process answers /healthz with the database connected.
tenants_health() {
	local id port i
	for id in $(tenant_ids); do
		port="$(tenant_port "$id")"
		for i in $(seq 1 30); do
			curl -fsS --max-time 2 "http://127.0.0.1:$port/healthz" | grep -q '"db":"connected"' && continue 2
			sleep 1
		done
		echo "tenant $id did not become healthy on port $port" >&2
		return 1
	done
}

# Tenant ids, one per /opt/chat/tenants/<id>.env.
tenant_ids() {
	local file
	for file in "$TENANTS_DIR"/*.env; do
		[ -f "$file" ] && basename "$file" .env
	done
	return 0
}

tenant_port() { sed -n 's/^CHAT_LISTEN_ADDR=127\.0\.0\.1://p' "$TENANTS_DIR/$1.env" | tail -n 1; }

# Writes the tenants' nginx conf from the release nginx directory $1 (none
# when there is no tenant, or no $tenant_cert map yet).
install_tenants_conf() {
	local rendered
	rendered="$(bash "$ROOT/infra/render-tenants-nginx.sh" "$1" "$TENANTS_DIR")" || return 1
	if [ -z "$rendered" ]; then
		rm -f "$TENANTS_CONF"
	elif [ ! -f "$TENANT_CERT_MAP" ]; then
		echo "WARNING: $TENANT_CERT_MAP missing (hoandat-auth); chat tenants not served" >&2
		rm -f "$TENANTS_CONF"
	else
		printf '%s\n' "$rendered" >"$TENANTS_CONF"
		chmod 644 "$TENANTS_CONF"
	fi
}

# Starts or reloads chat-api and every tenant's process.
start_all() {
	local id
	pm2 startOrReload "$ROOT/infra/ecosystem.config.cjs" --only chat-api --update-env || return 1
	for id in $(tenant_ids); do
		pm2 startOrReload "$ROOT/infra/ecosystem.config.cjs" --only "chat-api-$id" --update-env || return 1
	done
}

rollback() {
	echo "!! activation failed, restoring ${PREV:-nothing}" >&2
	if [ -n "$PREV" ]; then
		ln -sfn "$PREV" "$ROOT/current"
		[ -f "$PREV/nginx/chat.hoandat.com.conf" ] && install -m 644 "$PREV/nginx/chat.hoandat.com.conf" "$CONF"
		if [ -f "$PREV/nginx/media-chat.hoandat.com.conf" ] && [ -f "$MEDIA_CERT" ]; then
			install -m 644 "$PREV/nginx/media-chat.hoandat.com.conf" "$MEDIA_CONF"
		else
			rm -f "$MEDIA_CONF"
		fi
		install_tenants_conf "$PREV/nginx" || rm -f "$TENANTS_CONF"
		nginx -t && systemctl reload nginx || true
		start_all || true
	fi
	exit 1
}

echo "== nginx"
cp -p "$CONF" "$CONF.prev" 2>/dev/null || true
cp -p "$MEDIA_CONF" "$MEDIA_CONF.prev" 2>/dev/null || rm -f "$MEDIA_CONF.prev"
cp -p "$TENANTS_CONF" "$TENANTS_CONF.prev" 2>/dev/null || rm -f "$TENANTS_CONF.prev"
install -m 644 "$NEW/nginx/chat.hoandat.com.conf" "$CONF"
if [ -f "$NEW/nginx/media-chat.hoandat.com.conf" ] && [ -f "$MEDIA_CERT" ]; then
	install -m 644 "$NEW/nginx/media-chat.hoandat.com.conf" "$MEDIA_CONF"
elif [ -f "$NEW/nginx/media-chat.hoandat.com.conf" ]; then
	echo "WARNING: $MEDIA_CERT missing; media host not served (see docs/deployment-guide.md)" >&2
fi
install_tenants_conf "$NEW/nginx" || { echo "rendering the tenants' nginx conf failed; release not activated" >&2; exit 1; }
if ! nginx -t; then
	if [ -f "$CONF.prev" ]; then mv "$CONF.prev" "$CONF"; else rm -f "$CONF"; fi
	if [ -f "$TENANTS_CONF.prev" ]; then mv "$TENANTS_CONF.prev" "$TENANTS_CONF"; else rm -f "$TENANTS_CONF"; fi
	if [ -f "$MEDIA_CONF.prev" ]; then mv "$MEDIA_CONF.prev" "$MEDIA_CONF"; else rm -f "$MEDIA_CONF"; fi
	echo "nginx -t failed; release not activated" >&2
	exit 1
fi

echo "== switch and start"
ln -sfn "$NEW" "$ROOT/current"
systemctl reload nginx
# Through the ecosystem file, so option changes (kill_timeout, memory cap)
# apply on every deploy.
start_all || rollback
pm2 save >/dev/null
health || rollback
realtime || rollback
hooks || rollback
bots || rollback
media || rollback
tenants_health || rollback

echo "== prune"
ls -1dt "$ROOT"/releases/*/ | tail -n +6 | xargs -r rm -rf
echo "activated $ID"
