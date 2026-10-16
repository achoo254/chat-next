#!/bin/bash
# The nginx conf of the chat tenants other than the primary one, printed to
# stdout: one map from chat.<domain> to its process's port (from
# /opt/chat/tenants/*.env), and one server block built from the release's
# own chat.hoandat.com.conf, so every route, limit and header stays the
# same. The block matches chat.<tenant> by regex and takes the tenant's
# certificate from hoandat-auth's $tenant_cert map (00-tenants-http.conf),
# like the localman and tunelo tenant blocks; the provisioner skips such
# regex blocks when it checks names in use. A host with no tenant here
# answers 421.
#   bash render-tenants-nginx.sh <release-nginx-dir> [tenants-dir]
# Prints nothing when there is no tenant.
set -euo pipefail

SRC="${1:?usage: render-tenants-nginx.sh <release-nginx-dir> [tenants-dir]}/chat.hoandat.com.conf"
DIR="${2:-/opt/chat/tenants}"
[ -f "$SRC" ] || { echo "render-tenants-nginx: missing $SRC" >&2; exit 1; }

entries=""
for file in "$DIR"/*.env; do
	[ -f "$file" ] || continue
	domain="$(sed -n 's/^TENANT_DOMAIN=//p' "$file" | tail -n 1)"
	port="$(sed -n 's/^CHAT_LISTEN_ADDR=127\.0\.0\.1://p' "$file" | tail -n 1)"
	[[ "$domain" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { echo "render-tenants-nginx: bad TENANT_DOMAIN in $file" >&2; exit 1; }
	[[ "$port" =~ ^46[0-9]{2}$ ]] || { echo "render-tenants-nginx: bad CHAT_LISTEN_ADDR in $file" >&2; exit 1; }
	entries+="	chat.$domain $port;"$'\n'
done
[ -n "$entries" ] || exit 0

cat <<HEAD
# Chat tenants other than the primary one (render-tenants-nginx.sh, from
# chat.hoandat.com.conf of the release). Do not edit: activate-release.sh
# writes it on every release.
map \$host \$chat_tenant_port {
	default "";
$entries}

HEAD
# The HTTPS server block of the primary conf (its second server block),
# with the tenant's host, certificate, upstream and policy origins.
awk '/^server \{/ { n++ } n >= 2' "$SRC" | sed \
	-e 's|^\tserver_name chat\.hoandat\.com;|\tserver_name ~^chat\\.(?<tenant>.+)$;\n\n\tif ($chat_tenant_port = "") {\n\t\treturn 421;\n\t}\n\n\t# HTTP-01 challenges of the tenant certificate (hoandat-auth provisioner)\n\t# that reach 443: a proxied host under Full with Always Use HTTPS.\n\tlocation ^~ /.well-known/acme-challenge/ {\n\t\troot /var/lib/hoandat-tenant-acme;\n\t\tdefault_type text/plain;\n\t\ttry_files $uri =404;\n\t}|' \
	-e 's|/etc/letsencrypt/live/chat\.hoandat\.com/|/etc/letsencrypt-tenants/live/$tenant_cert/|' \
	-e 's|/var/log/nginx/chat\.hoandat\.com\.|/var/log/nginx/chat-tenants.|' \
	-e 's|http://127\.0\.0\.1:4600|http://127.0.0.1:$chat_tenant_port|g' \
	-e 's|wss://chat\.hoandat\.com|wss://$host|g' \
	-e 's|https://media-chat\.hoandat\.com|https://media-chat.$tenant|g' \
	-e 's|https://auth\.hoandat\.com|https://auth.$tenant|g'
