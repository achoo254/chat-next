#!/bin/bash
# Creates the restricted `chat-deploy` user used by GitHub Actions to deploy
# chat (run as root on the server; the public key comes on stdin):
#   bash /opt/chat/infra/setup-deploy-user.sh < chat-deploy.pub
# With empty stdin (`< /dev/null`) it keeps the installed key and only
# reinstalls the sudo command, e.g. after activate-incoming.sh changed.
# The user can only write /opt/chat/incoming and run one root-owned command
# through sudo: /usr/local/sbin/chat-activate-incoming <release-id>.
set -euo pipefail
USER_NAME=chat-deploy
ROOT=/opt/chat
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }

pub="$(cat)"
id "$USER_NAME" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$USER_NAME"
home="$(getent passwd "$USER_NAME" | cut -d: -f6)"
if [ -n "$pub" ]; then
	[[ "$pub" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "expected one ssh-ed25519 public key on stdin" >&2; exit 2; }
	install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$home/.ssh"
	# `restrict`: no port/agent/X11 forwarding and no pty.
	printf 'restrict %s\n' "$pub" >"$home/.ssh/authorized_keys"
	chown "$USER_NAME:$USER_NAME" "$home/.ssh/authorized_keys"
	chmod 600 "$home/.ssh/authorized_keys"
elif [ ! -s "$home/.ssh/authorized_keys" ]; then
	echo "no key installed yet; pass the public key on stdin" >&2
	exit 2
fi

install -d -m 750 -o "$USER_NAME" -g "$USER_NAME" "$ROOT/incoming"
install -m 755 -o root -g root "$ROOT/infra/activate-incoming.sh" /usr/local/sbin/chat-activate-incoming
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/chat-activate-incoming\n' "$USER_NAME" >/etc/sudoers.d/chat-deploy
chmod 440 /etc/sudoers.d/chat-deploy
visudo -cf /etc/sudoers.d/chat-deploy
echo "setup-deploy-user: done"
