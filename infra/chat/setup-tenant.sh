#!/bin/bash
# A second (or later) tenant of the chat app on this server: one more
# chat-api process on the same database, served at chat.<domain>.
#   bash setup-tenant.sh <tenant-id> <domain> <port>
#   bash setup-tenant.sh inetdev inetdev.io.vn 4601
# Writes /opt/chat/tenants/<tenant-id>.env (root:chat, 640) once: the
# database, environment and outbound deny list come from /opt/chat/.env, a
# new SESSION_KEY is generated, media and Web Push stay off. The OIDC client
# secret of the tenant (chat-web of auth.<domain>, derived at the IdP) is
# written separately into OIDC_CLIENT_SECRET; until then the process starts
# but sign-in fails. The next activate-release.sh starts the process
# (ecosystem.config.cjs reads the tenants directory) and installs the nginx
# block (render-tenants-nginx.sh). Run as root; never prints secrets.
set -euo pipefail

ID="${1:?usage: setup-tenant.sh <tenant-id> <domain> <port>}"
DOMAIN="${2:?usage: setup-tenant.sh <tenant-id> <domain> <port>}"
PORT="${3:?usage: setup-tenant.sh <tenant-id> <domain> <port>}"
ROOT=/opt/chat
MAIN="$ROOT/.env"
DIR="$ROOT/tenants"
FILE="$DIR/$ID.env"

die() { echo "setup-tenant: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root"
[[ "$ID" =~ ^[a-z][a-z0-9]{1,30}$ ]] || die "tenant id: lowercase letters and digits"
[ "$ID" != primary ] || die "the primary tenant is /opt/chat/.env"
[[ "$DOMAIN" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || die "domain: a plain lowercase hostname"
[[ "$PORT" =~ ^46[0-9]{2}$ ]] && [ "$PORT" != 4600 ] || die "port: 4601 to 4699"
[ -s "$MAIN" ] || die "missing $MAIN"
[ -e "$FILE" ] && { echo "setup-tenant: $FILE already exists"; exit 0; }
if grep -qs "^CHAT_LISTEN_ADDR=127.0.0.1:$PORT$" "$DIR"/*.env; then die "port $PORT is taken by another tenant"; fi

value() { sed -n "s/^$1=//p" "$MAIN" | tail -n 1; }
install -d -m 750 -o root -g chat "$DIR"
umask 027
{
	echo "# Tenant $ID of the chat app (setup-tenant.sh). Same database as $MAIN."
	echo "CHAT_ENV=$(value CHAT_ENV)"
	echo "CHAT_LISTEN_ADDR=127.0.0.1:$PORT"
	echo "CHAT_PUBLIC_URL=https://chat.$DOMAIN"
	echo "DATABASE_URL=$(value DATABASE_URL)"
	echo "OIDC_ISSUER=https://auth.$DOMAIN"
	echo "OIDC_CLIENT_ID=chat-web"
	echo "# chat-web of auth.$DOMAIN, derived at the IdP from APP_CLIENT_SECRET_KEY."
	echo "OIDC_CLIENT_SECRET="
	echo "SESSION_KEY=$(openssl rand -base64 48 | tr -d '\n')"
	echo "TENANT_ID=$ID"
	echo "TENANT_DOMAIN=$DOMAIN"
	echo "OUTBOUND_DENY_CIDRS=$(value OUTBOUND_DENY_CIDRS)"
	echo "# Comma-separated user ids of this tenant allowed to moderate; empty = nobody."
	echo "CHAT_OPERATOR_USER_IDS="
} >"$FILE"
chown root:chat "$FILE"
chmod 640 "$FILE"
echo "setup-tenant: wrote $FILE (fill OIDC_CLIENT_SECRET, then activate a release)"
