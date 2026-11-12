#!/bin/bash
# Installs a stun-responder bundle uploaded to /opt/chat/incoming/stun-<release-id> (by the stun-deploy workflow as
# `chat-deploy`, or by infra/stun/deploy.sh). Installed as root at /usr/local/sbin/stun-activate-incoming;
# `chat-deploy` may run it through sudo (infra/chat/setup-deploy-user.sh).
#   stun-activate-incoming <release-id>
# One install at a time (flock). The upload moves to a root-owned temporary directory, is rejected if it holds links
# or special files or misses a part, and infra/stun/install-on-server.sh from the bundle installs it (the binary must
# run here first; the service must come up; firewall, nginx and DNS are only reported, never changed).
set -euo pipefail
ID="${1:?usage: stun-activate-incoming <release-id>}"
[[ "$ID" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{12}$ ]] || { echo "bad release id" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

# One install at a time: a workflow run and a manual install from a dev machine may meet.
exec 9>/run/stun-activate.lock
flock -w 600 9 || { echo "another install still holds /run/stun-activate.lock" >&2; exit 1; }

SRC="/opt/chat/incoming/stun-$ID"
[ -d "$SRC" ] && [ ! -L "$SRC" ] || { echo "incoming stun bundle $ID missing" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mv "$SRC" "$work/bundle"
chown -R root:root "$work/bundle"
[ -z "$(find "$work/bundle" ! -type f ! -type d -print -quit)" ] || { echo "stun bundle $ID has links or special files" >&2; exit 2; }
for f in stun-responder stun-responder.service install-on-server.sh; do
	[ -s "$work/bundle/$f" ] || { echo "stun bundle $ID has no $f" >&2; exit 2; }
done
chmod 755 "$work/bundle/stun-responder"
# The service keeps running as its own user; nothing it starts needs the lock.
bash "$work/bundle/install-on-server.sh" "$work/bundle" 9>&-
echo "stun-responder now runs $ID"
