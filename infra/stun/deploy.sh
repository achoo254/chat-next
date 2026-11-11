#!/bin/bash
# Builds apps/stun on this machine for the server's CPU (static musl binary)
# and installs it on the shared server as the systemd service
# stun-responder, running as the system user `stun`, on UDP 3478.
#
#   SSH_TARGET=<user>@<SERVER_65_IP> SSH_OPTS="-i <key> -p <SSH_PORT> -o IdentitiesOnly=yes" bash infra/stun/deploy.sh
# or with any command that runs a remote command given as its last argument
# and forwards stdin, for example the lab helper:
#   REMOTE_SHELL="<path>/lab-ssh.sh 65" bash infra/stun/deploy.sh
#
# Optional: STUN_BIN=<prebuilt linux binary> skips the build.
# Needs cargo with the <arch>-unknown-linux-musl target and, on a non-Linux
# machine, cargo-zigbuild (zig as the linker). Never builds on the server.
# The script never changes firewall rules, nginx or DNS: it only reports the
# state of UDP 3478. Rollback is in infra/stun/README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -n "${REMOTE_SHELL:-}" ]; then
  # Word splitting is intended: REMOTE_SHELL is a command plus its arguments.
  # shellcheck disable=SC2206
  remote=($REMOTE_SHELL)
else
  : "${SSH_TARGET:?set SSH_TARGET (with SSH_OPTS) or REMOTE_SHELL}"
  # shellcheck disable=SC2206
  remote=(ssh ${SSH_OPTS:-} "$SSH_TARGET")
fi

# TMPDIR picks where the throwaway build lands (it is deleted on exit).
work="$(mktemp -d "${TMPDIR:-/tmp}/stun-deploy.XXXXXX")"
trap 'rm -rf "$work"' EXIT
bundle="$work/bundle"
mkdir -p "$bundle"

arch="$("${remote[@]}" 'uname -m' </dev/null)"
case "$arch" in
  x86_64 | aarch64) target="$arch-unknown-linux-musl" ;;
  *) echo "deploy: unsupported server architecture: $arch" >&2; exit 1 ;;
esac
echo "== server architecture $arch, target $target"

if [ -n "${STUN_BIN:-}" ]; then
  cp "$STUN_BIN" "$bundle/stun-responder"
else
  # A throwaway target dir keeps the build out of the repo and off the disk
  # once the script ends.
  export CARGO_TARGET_DIR="$work/target"
  build=(cargo build)
  if [ "$(uname -s)" != Linux ]; then build=(cargo zigbuild); fi
  echo "== build ${build[*]} --release --target $target"
  (cd apps/stun && "${build[@]}" --release --locked --target "$target")
  cp "$CARGO_TARGET_DIR/$target/release/stun-responder" "$bundle/stun-responder"
fi
chmod 755 "$bundle/stun-responder"
cp infra/stun/stun-responder.service infra/stun/install-on-server.sh "$bundle/"
ls -l "$bundle/stun-responder"

echo "== upload and install"
# One SSH session: the bundle travels on stdin, is unpacked into a private
# temporary directory, installed, and the directory is removed either way.
# The command is expanded on the server, hence the single quotes.
# shellcheck disable=SC2016
COPYFILE_DISABLE=1 tar --no-xattrs -C "$bundle" -czf - . | "${remote[@]}" \
  'd="$(mktemp -d)" && tar -xzf - -C "$d" && bash "$d/install-on-server.sh" "$d"; rc=$?; rm -rf "$d"; exit $rc'
echo "== done"
