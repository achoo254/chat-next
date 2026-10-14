#!/bin/bash
# Root-owned entry point for CI deploys, installed by setup-deploy-user.sh as
# /usr/local/sbin/chat-activate-incoming and allowed to the `chat-deploy`
# user through sudo (nothing else is). CI uploads a release to
# /opt/chat/incoming/<id>; this script takes it out of the deploy user's
# reach, checks it, moves it to /opt/chat/releases/<id>, replaces its nginx
# conf with the reviewed copy from the root-owned /opt/chat/infra/nginx (so an
# upload cannot change nginx), and runs /opt/chat/infra/activate-release.sh.
# Infra scripts themselves change only through a root deploy
# (infra/chat/deploy.sh).
set -euo pipefail
ROOT=/opt/chat
ID="${1:?usage: chat-activate-incoming <release-id>}"
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}$ ]] || { echo "bad release id" >&2; exit 2; }
SRC="$ROOT/incoming/$ID"
STAGE="$ROOT/staging"
DST="$ROOT/releases/$ID"
[ ! -e "$DST" ] || { echo "release $ID already exists" >&2; exit 2; }
[ -d "$SRC" ] && [ ! -L "$SRC" ] || { echo "incoming release $ID missing" >&2; exit 2; }

# Checks run only after the tree is root-owned in a root-only directory: the
# deploy user could otherwise swap a checked file for a symlink before the
# copy (and nginx would then serve whatever it points at).
install -d -m 700 -o root -g root "$STAGE"
rm -rf "${STAGE:?}/$ID"
mv "$SRC" "$STAGE/$ID"
chown -R root:root "$STAGE/$ID"
chmod -R go-w "$STAGE/$ID"
if [ -n "$(find "$STAGE/$ID" ! -type f ! -type d -print -quit)" ]; then
	rm -rf "${STAGE:?}/$ID"
	echo "incoming release $ID contains links or special files" >&2
	exit 2
fi
if [ ! -f "$STAGE/$ID/server" ] || [ ! -f "$STAGE/$ID/web/index.html" ]; then
	rm -rf "${STAGE:?}/$ID"
	echo "incoming release $ID incomplete" >&2
	exit 2
fi

rm -rf "$STAGE/$ID/nginx"
cp -R "$ROOT/infra/nginx" "$STAGE/$ID/nginx"
chmod -R a+rX "$STAGE/$ID"
chmod 755 "$STAGE/$ID/server"
mv "$STAGE/$ID" "$DST"

exec bash "$ROOT/infra/activate-release.sh" "$ID"
