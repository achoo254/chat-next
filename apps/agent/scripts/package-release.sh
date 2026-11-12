#!/bin/sh
# Packs the files of a tunelo release, one archive per platform, as the
# install scripts and `tunelo update` (apps/agent/src/update.ts) read them:
#
#   tunelo-darwin-arm64.tar.gz  tunelo-darwin-x64.tar.gz
#   tunelo-linux-x64.tar.gz     tunelo-linux-arm64.tar.gz   (ustar, executable bits kept)
#   tunelo-windows-x64.zip
#
# Each holds tunelo and tunelo-term-host of that platform under their release
# names (tunelo-darwin-arm64, tunelo-term-host-darwin-arm64, …) and, with
# --signed, the .minisig of each next to it. Then writes SHA256SUMS of the
# archives into the output folder.
#
#   package-release.sh <folder with the built files> <output folder> [--signed]
#
# A missing file stops it before anything is written.
set -eu

if [ $# -lt 2 ] || { [ $# -eq 3 ] && [ "$3" != "--signed" ]; } || [ $# -gt 3 ]; then
	echo "usage: package-release.sh <dist> <out> [--signed]" >&2
	exit 2
fi
dist="$1"
out="$2"
signed="${3:-}"
PLATFORMS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 windows-x64"

# files_of <platform>: the names packed for a platform.
files_of() {
	ext=""
	case "$1" in windows-*) ext=".exe" ;; esac
	names="tunelo-$1$ext tunelo-term-host-$1$ext"
	if [ "$signed" = "--signed" ]; then names="$names tunelo-$1$ext.minisig tunelo-term-host-$1$ext.minisig"; fi
	printf '%s\n' "$names"
}

archive_of() {
	case "$1" in
	windows-*) printf 'tunelo-%s.zip\n' "$1" ;;
	*) printf 'tunelo-%s.tar.gz\n' "$1" ;;
	esac
}

for platform in $PLATFORMS; do
	for f in $(files_of "$platform"); do
		[ -f "$dist/$f" ] || { echo "missing $dist/$f" >&2; exit 1; }
	done
done

mkdir -p "$out"
out="$(cd "$out" && pwd)"
archives=""
for platform in $PLATFORMS; do
	archive="$(archive_of "$platform")"
	rm -f "$out/$archive"
	# shellcheck disable=SC2046 # the file names have no spaces
	set -- $(files_of "$platform")
	chmod 0755 "$dist/$1" "$dist/$2"
	case "$platform" in
	windows-*) (cd "$dist" && zip -q -X "$out/$archive" "$@") ;;
	*) tar -C "$dist" --format=ustar -czf "$out/$archive" "$@" ;;
	esac
	archives="$archives $archive"
done

cd "$out"
# shellcheck disable=SC2086 # the archive names have no spaces
sha256sum $archives > SHA256SUMS
sha256sum -c SHA256SUMS
# shellcheck disable=SC2086
ls -l $archives
