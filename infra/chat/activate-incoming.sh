#!/bin/bash
# Root-owned entry point for CI deploys, installed by setup-deploy-user.sh as
# /usr/local/sbin/chat-activate-incoming and allowed to the `chat-deploy`
# user through sudo (nothing else is). CI uploads a release to
# /opt/chat/incoming/<id>; this script copies it into the root-owned
# /opt/chat/releases/<id>, replaces its nginx conf with the reviewed copy from
# the root-owned /opt/chat/infra/nginx (so an upload cannot change nginx), and
# runs /opt/chat/infra/activate-release.sh. Infra scripts themselves change
# only through a root deploy (infra/chat/deploy.sh).
set -euo pipefail
ROOT=/opt/chat
ID="${1:?usage: chat-activate-incoming <release-id>}"
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}$ ]] || { echo "bad release id" >&2; exit 2; }
SRC="$ROOT/incoming/$ID"
DST="$ROOT/releases/$ID"
# The upload must be a plain directory tree owned by chat-deploy: a symlink
# could make this root script copy (and nginx then serve) files the deploy
# user cannot read.
[ -d "$SRC" ] && [ ! -L "$SRC" ] && [ "$(stat -c %U "$SRC")" = chat-deploy ] || { echo "incoming release $ID missing" >&2; exit 2; }
[ -z "$(find "$SRC" -type l -print -quit)" ] || { echo "incoming release $ID contains symlinks" >&2; exit 2; }
[ -f "$SRC/server" ] && [ -f "$SRC/web/index.html" ] || { echo "incoming release $ID incomplete" >&2; exit 2; }
[ ! -e "$DST" ] || { echo "release $ID already exists" >&2; exit 2; }

install -d -m 755 "$DST"
cp -R "$SRC/server" "$SRC/web" "$DST/"
[ -f "$SRC/RELEASE" ] && cp "$SRC/RELEASE" "$DST/RELEASE"
cp -R "$ROOT/infra/nginx" "$DST/nginx"
chown -R root:root "$DST"
chmod -R a+rX,go-w "$DST"
chmod 755 "$DST/server"
rm -rf "$SRC"

exec bash "$ROOT/infra/activate-release.sh" "$ID"
