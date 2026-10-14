#!/bin/bash
# Switches /opt/chat/current to an existing release without migrating
# (rollback of code only; data stays as it is):
#   bash /opt/chat/infra/switch-release.sh <release-id>
set -euo pipefail
ROOT=/opt/chat
ID="${1:?usage: switch-release.sh <release-id>; see ls /opt/chat/releases}"
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}(-dirty)?$ ]] || { echo "bad release id" >&2; exit 2; }
[ -x "$ROOT/releases/$ID/server" ] || { echo "release $ID not found" >&2; exit 2; }
install -m 644 "$ROOT/releases/$ID/nginx/chat.hoandat.com.conf" /etc/nginx/conf.d/chat.hoandat.com.conf
nginx -t
ln -sfn "$ROOT/releases/$ID" "$ROOT/current"
systemctl reload nginx
pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env
for _ in $(seq 1 30); do
	curl -fsS --max-time 2 http://127.0.0.1:4600/healthz | grep -q '"db":"connected"' && { echo "switched to $ID"; exit 0; }
	sleep 1
done
echo "chat-api not healthy after switching to $ID" >&2
exit 1
