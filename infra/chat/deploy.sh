#!/bin/bash
# Builds chat on this machine and deploys it to the shared server .65:
#   SSH_TARGET=root@<SERVER_65_IP> SSH_OPTS="-i <key> -p 24700 -o IdentitiesOnly=yes" bash infra/chat/deploy.sh
# (see .claude/skills/chat-ops-prod/SKILL.md for loading the key). Never
# builds on the server. The release id is <UTC time>-<commit 12 chars>, with
# -dirty when the working tree has uncommitted changes. The server activates
# it with infra/chat/activate-release.sh, which rolls back on failure.
set -euo pipefail
cd "$(dirname "$0")/../.."

SSH_TARGET="${SSH_TARGET:?set SSH_TARGET, e.g. root@<SERVER_65_IP>}"
SSH="ssh ${SSH_OPTS:-}"
ROOT=/opt/chat

commit="$(git rev-parse --short=12 HEAD)"
dirty=""
git diff --quiet HEAD -- || dirty="-dirty"
id="$(date -u +%Y%m%d-%H%M%S)-$commit$dirty"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
rel="$out/$id"
mkdir -p "$rel"

echo "== build web"
pnpm --filter @app/web build
cp -R apps/web/dist "$rel/web"

echo "== build server (linux/amd64, static)"
(cd server && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$rel/server" ./cmd/server)

cp -R infra/chat/nginx "$rel/nginx"
echo "$id" >"$rel/RELEASE"

echo "== upload release $id"
$SSH "$SSH_TARGET" "install -d -m 755 $ROOT/releases $ROOT/infra"
rsync -rltz -e "$SSH" "$rel/" "$SSH_TARGET:$ROOT/releases/$id/"
rsync -rltz --delete -e "$SSH" infra/chat/ "$SSH_TARGET:$ROOT/infra/"

echo "== activate"
$SSH "$SSH_TARGET" "bash $ROOT/infra/activate-release.sh '$id'"
