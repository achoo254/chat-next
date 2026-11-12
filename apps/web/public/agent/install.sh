#!/bin/sh
# Installs tunelo, the background process of "My machines" (ADR 0013) and
# the Tunelo CLI, on macOS and Linux (x86_64, aarch64; glibc, systemd). "Add
# this machine" in Chat shows:
#
#   curl -fsSL https://<chat host>/agent/install.sh | sh -s -- <device key> <pairing secret> [vi|en|zh-CN]
#
# which installs tunelo and runs `tunelo install`: you sign in with your
# account in the browser and the machine joins My machines by itself (no
# install code). The pairing secret is one-time and short-lived, so it rides
# in the one command the page shows. A command without it (an older page)
# asks for it in the terminal. A command of an older page, with an install
# code before the device key, still works: the code is ignored.
#
# With only a language (or nothing), the script installs or updates the
# binary and runs `tunelo login`; this is what `tunelo update` of the Tunelo
# CLI 1.x runs:
#
#   curl -fsSL https://<chat host>/agent/install.sh | sh -s -- [vi|en|zh-CN]
#
# Two files are installed next to each other: tunelo and tunelo-term-host,
# the process that keeps the machine's terminals (a release from before the
# terminal has only tunelo). When `tunelo update` already put a terminal
# process into the config folder, the new one is also staged there; tunelo
# switches to it once no terminal is open.
#
# The release is pinned: version and SHA-256 of every file are written into
# this script when the web app is built for a tunelo release, and the
# minisign signature is checked with the embedded public key when minisign
# is installed. A script whose pins were not filled in refuses to run.
set -eu

TUNELO_VERSION="2.6.0"
SHA256_DARWIN_ARM64="a7d233c8d14564ff5fab4496ad0f6107f38aac6c3bdc73696372980d83a9b403"
SHA256_DARWIN_X64="c2c7f2004d8027ac2d7c3928ae74e5d205e89b8f20710a936f97ef81b8fb6345"
SHA256_LINUX_X64="22a3246202156faf6a3e0d8a1fe9121cfd956717e87bdd47fc50807b267c19bd"
SHA256_LINUX_ARM64="18f3b3ed3ac7dd42a6ad30fb2dbc8cd1f99a6c90991ecf99db47919358055a35"
SHA256_TERM_HOST_DARWIN_ARM64="7341deb4a8f865f6648314a550d71539ec7dd73a38b085e735d0d7ba2c4d2813"
SHA256_TERM_HOST_DARWIN_X64="f8810c5d70c7b5117aeb7b39ebaa95faff9ac752d1ef2da7f920c05503f1e850"
SHA256_TERM_HOST_LINUX_X64="cffc29cecd60048cf9b4de2e914e2daead279007070df6aa1c3ddd62b19f63a4"
SHA256_TERM_HOST_LINUX_ARM64="7d4127ce0319ff9f3017b737276b8cc3ee48cd2f6c7deca3b230cefde4b03f58"
MINISIGN_PUBKEY="RWRFawlh5bQHAM2aPa3OjWqc80YoE0B31Rzcvz5QpG6J5R4vdgnJhf6D"
RELEASES="https://github.com/achoo254/chat-next/releases/download"

lang="en"

say() {
	# say <vi> <en> <zh-CN>
	case "$lang" in
	vi) printf '%s\n' "$1" ;;
	zh-CN) printf '%s\n' "$3" ;;
	*) printf '%s\n' "$2" ;;
	esac
}

die() {
	say "Lỗi: $1" "Error: $2" "错误：$3" >&2
	exit 1
}

sha256_of() {
	if command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	else
		sha256sum "$1" | cut -d ' ' -f 1
	fi
}

# Sets asset and sha for this system, and host_asset and host_sha for its
# terminal process (host_sha is empty for a release from before the
# terminal): pick_asset <uname -s> <uname -m>.
pick_asset() {
	case "${1}/${2}" in
	Darwin/arm64) asset="tunelo-darwin-arm64" sha="$SHA256_DARWIN_ARM64" host_sha="$SHA256_TERM_HOST_DARWIN_ARM64" ;;
	Darwin/x86_64) asset="tunelo-darwin-x64" sha="$SHA256_DARWIN_X64" host_sha="$SHA256_TERM_HOST_DARWIN_X64" ;;
	Linux/x86_64 | Linux/amd64) asset="tunelo-linux-x64" sha="$SHA256_LINUX_X64" host_sha="$SHA256_TERM_HOST_LINUX_X64" ;;
	Linux/aarch64 | Linux/arm64) asset="tunelo-linux-arm64" sha="$SHA256_LINUX_ARM64" host_sha="$SHA256_TERM_HOST_LINUX_ARM64" ;;
	Darwin/* | Linux/*)
		die "tunelo chưa có bản cho bộ xử lý ${2} (có: macOS arm64, x86_64; Linux x86_64, aarch64)." \
			"tunelo has no build for the ${2} processor (there are: macOS arm64, x86_64; Linux x86_64, aarch64)." \
			"tunelo 没有适用于 ${2} 处理器的版本（支持：macOS arm64、x86_64；Linux x86_64、aarch64）。"
		;;
	*)
		die "tunelo có cho macOS, Linux và Windows; máy này chạy ${1}." \
			"tunelo is available for macOS, Linux and Windows; this machine runs ${1}." \
			"tunelo 支持 macOS、Linux 和 Windows；此机器运行的是 ${1}。"
		;;
	esac
	[ -n "$sha" ] || die "bản tunelo ${TUNELO_VERSION} chưa có cho ${1}; thử lại khi có bản mới." \
		"tunelo ${TUNELO_VERSION} has no ${1} build yet; try again once a newer release is out." \
		"tunelo ${TUNELO_VERSION} 尚无 ${1} 版本；请在新版本发布后重试。"
	host_asset="tunelo-term-host-${asset#tunelo-}"
}

# fetch_verified <file> <sha256>: downloads a file of the pinned release into
# $tmp and checks its SHA-256, and its signature when minisign is installed.
fetch_verified() {
	url="${RELEASES}/tunelo-v${TUNELO_VERSION}/${1}"
	curl -fsSL --proto '=https' --tlsv1.2 -o "${tmp}/${1}" "$url" || die "không tải được ${url}" "could not download ${url}" "无法下载 ${url}"
	[ "$(sha256_of "${tmp}/${1}")" = "$2" ] || die "file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt." \
		"the download does not match the pinned SHA-256; nothing was installed." "下载的文件与固定的 SHA-256 不符；未安装任何内容。"
	if command -v minisign >/dev/null 2>&1; then
		fetch_signature "$1"
		minisign -Vq -P "$MINISIGN_PUBKEY" -m "${tmp}/${1}" -x "${tmp}/${1}.minisig" ||
			die "chữ ký minisign không hợp lệ; đã huỷ cài đặt." "the minisign signature is invalid; nothing was installed." "minisign 签名无效；未安装任何内容。"
	fi
}

# fetch_signature <file>: downloads the file's minisign signature into $tmp.
fetch_signature() {
	[ ! -f "${tmp}/${1}.minisig" ] || return 0
	curl -fsSL --proto '=https' --tlsv1.2 -o "${tmp}/${1}.minisig" "${RELEASES}/tunelo-v${TUNELO_VERSION}/${1}.minisig" ||
		die "không tải được chữ ký minisign." "could not download the minisign signature." "无法下载 minisign 签名。"
}

# A terminal process `tunelo update` put into the config folder comes before
# the one next to tunelo: stage the new one there too (with its signature,
# which names its version); tunelo switches to it once no terminal is open.
stage_term_host() {
	host_bins="${config_dir}/term-host/bin"
	[ -d "${host_bins}/current" ] || return 0
	rm -rf "${host_bins}/next.partial"
	mkdir -p "${host_bins}/next.partial"
	cp "${tmp}/${host_asset}" "${host_bins}/next.partial/tunelo-term-host"
	cp "${tmp}/${host_asset}.minisig" "${host_bins}/next.partial/tunelo-term-host.minisig"
	chmod 0755 "${host_bins}/next.partial/tunelo-term-host"
	rm -rf "${host_bins}/next"
	mv "${host_bins}/next.partial" "${host_bins}/next"
}

# Linux needs glibc (the build is not for musl) and, to run in the background, systemd.
check_linux() {
	if ldd --version 2>&1 | grep -qi musl; then
		die "tunelo cần Linux dùng glibc (Ubuntu, Debian, Fedora…); bản musl như Alpine chưa được hỗ trợ." \
			"tunelo needs a glibc Linux (Ubuntu, Debian, Fedora…); musl systems such as Alpine are not supported." \
			"tunelo 需要使用 glibc 的 Linux（Ubuntu、Debian、Fedora…）；暂不支持 Alpine 等 musl 系统。"
	fi
	[ -z "$device_key" ] || command -v systemctl >/dev/null 2>&1 ||
		die "tunelo cần systemd để chạy nền nhưng máy này không có systemctl (container, WSL chưa bật systemd?)." \
			"tunelo needs systemd to run in the background, and this machine has no systemctl (a container, or WSL without systemd?)." \
			"tunelo 需要 systemd 才能在后台运行，但此机器没有 systemctl（容器，或未启用 systemd 的 WSL？）。"
}

# add_path_line <rc file> always|if-present: appends $line once.
add_path_line() {
	[ "$2" = "always" ] || [ -f "$1" ] || return 0
	grep -Fqs "$line" "$1" || printf '\n%s\n' "$line" >> "$1"
}

is_key() {
	printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{43}$'
}

main() {
	device_key=""
	secret=""
	locale=""
	if [ $# -ge 1 ] && is_key "$1"; then
		device_key="$1"
		if [ $# -ge 2 ] && is_key "$2"; then
			secret="$2"
			locale="${3:-}"
		else
			locale="${2:-}"
		fi
	elif [ $# -ge 2 ] && printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_-]{22}$'; then
		# An older page: <install code> <device key> [language]; install codes are retired.
		device_key="$2"
		locale="${3:-}"
		is_key "$device_key" || die "khoá thiết bị không hợp lệ." "the device key is malformed." "设备密钥格式不正确。"
	else
		locale="${1:-}"
	fi
	locale="${locale:-${LANG:-en}}"
	case "$locale" in
	vi*) lang="vi" ;;
	zh*) lang="zh-CN" ;;
	*) lang="en" ;;
	esac

	case "$TUNELO_VERSION" in
	__*) die "chưa có bản phát hành tunelo." "no tunelo release is available yet." "tunelo 尚未发布。" ;;
	esac

	os="$(uname -s)"
	pick_asset "$os" "$(uname -m)"
	[ "$os" != "Linux" ] || check_linux

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	trap 'exit 130' INT TERM
	say "Đang tải tunelo ${TUNELO_VERSION}…" "Downloading tunelo ${TUNELO_VERSION}…" "正在下载 tunelo ${TUNELO_VERSION}…"
	# Both files are checked before either is installed.
	fetch_verified "$asset" "$sha"
	if [ -n "$host_sha" ]; then
		fetch_verified "$host_asset" "$host_sha"
		# Its signature names its version, which tunelo reads when it switches.
		fetch_signature "$host_asset"
	fi

	bin_dir="$HOME/.local/bin"
	bin="$bin_dir/tunelo"
	config_dir="${TUNELO_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/tunelo}"
	mkdir -p "$bin_dir"
	# tunelo first: if it cannot be put in place, no newer terminal process waits for it.
	chmod 0755 "$tmp/$asset"
	mv -f "$tmp/$asset" "$bin.new"
	mv -f "$bin.new" "$bin"
	# What `tunelo update --rollback` would put back is not the release before this one any more.
	rm -f "$bin.old" "${config_dir}/update-rollback.json"
	if [ -n "$host_sha" ]; then
		# A running terminal process keeps the file it started from; open shells stay.
		chmod 0755 "${tmp}/${host_asset}"
		cp "${tmp}/${host_asset}" "${bin_dir}/tunelo-term-host.new"
		mv -f "${bin_dir}/tunelo-term-host.new" "${bin_dir}/tunelo-term-host"
		stage_term_host
	fi

	# Put tunelo on PATH for new terminals: zsh is the macOS default shell;
	# Linux login shells read ~/.profile, interactive bash ~/.bashrc.
	case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*)
		line='export PATH="$HOME/.local/bin:$PATH"'
		if [ "$os" = "Darwin" ]; then
			add_path_line "$HOME/.zprofile" always
			add_path_line "$HOME/.bash_profile" if-present
		else
			add_path_line "$HOME/.profile" always
			add_path_line "$HOME/.bashrc" if-present
			case "${SHELL:-}" in */zsh) add_path_line "$HOME/.zshrc" always ;; esac
		fi
		say "Đã thêm $bin_dir vào PATH; mở terminal mới để gõ tunelo." "Added $bin_dir to your PATH; open a new terminal to use tunelo." "已将 $bin_dir 加入 PATH；打开新终端即可使用 tunelo。"
		;;
	esac

	# The old Tunelo CLI from npm (1.x) is also called tunelo and may come first on PATH.
	if command -v npm >/dev/null 2>&1 && npm ls -g tunelo --depth=0 >/dev/null 2>&1; then
		say "Lưu ý: gói npm tunelo 1.x cũ vẫn đang cài và có thể che lệnh tunelo mới. Gỡ nó bằng: npm uninstall -g tunelo" \
			"Note: the old tunelo 1.x npm package is still installed and may hide the new tunelo command. Remove it with: npm uninstall -g tunelo" \
			"注意：旧的 tunelo 1.x npm 包仍已安装，可能遮住新的 tunelo 命令。请运行 npm uninstall -g tunelo 卸载。"
	fi

	if [ -z "$device_key" ]; then
		# A running background service still runs the previous file: restart it
		# on the new one.
		if "$bin" status --json >/dev/null 2>&1; then
			say "Đang khởi động lại tunelo chạy nền với bản mới…" "Restarting the background tunelo on the new version…" "正在用新版本重启后台 tunelo…"
			"$bin" stop >/dev/null 2>&1 || true
			"$bin" start || say "Chưa khởi động lại được; chạy tunelo start." "Could not restart it; run tunelo start." "无法重启；请运行 tunelo start。"
		fi
		# Binary only: one sign-in for the tunnel, Chat and Localman. A failed or
		# skipped sign-in leaves tunelo installed.
		say "Đăng nhập tài khoản cho tunelo (tunnel, Chat, Localman)…" \
			"Signing tunelo in with your account (tunnel, Chat, Localman)…" "正在用你的账号登录 tunelo（隧道、Chat、Localman）…"
		"$bin" login || say "Chưa đăng nhập được; chạy lại tunelo login khi sẵn sàng." \
			"Not signed in yet; run tunelo login when you are ready." "尚未登录；准备好后请运行 tunelo login。"
		disk_access_hint
		return 0
	fi

	if [ -z "$secret" ]; then
		[ -r /dev/tty ] || die "cần chạy lệnh trong cửa sổ Terminal để dán mã ghép." \
			"run the command in a Terminal window to paste the pairing secret." "请在终端窗口中运行该命令以粘贴配对密钥。"
		say "Dán mã ghép đang hiện trên trang Chat rồi bấm Enter:" \
			"Paste the pairing secret shown on the Chat page and press Enter:" \
			"粘贴 Chat 页面上显示的配对密钥并按回车："
		IFS= read -r secret </dev/tty || true
		secret="$(printf '%s' "$secret" | tr -d '[:space:]')"
	fi
	printf '%s' "$secret" | grep -Eq '^[A-Za-z0-9_-]{43}$' || die "mã ghép không hợp lệ; chạy lại lệnh và dán đúng mã." \
		"the pairing secret is malformed; run the command again and paste it." "配对密钥格式不正确；请重新运行命令并粘贴。"

	# printf is a shell builtin: the secret reaches tunelo on stdin only.
	# The script shows the Full Disk Access step itself, in the page's language.
	printf '%s\n' "$secret" | TUNELO_DISK_ACCESS_HINT=script "$bin" install --trust "$device_key"
	linger_hint
	disk_access_hint
}

# Linux: the systemd user service runs while the owner is logged in. `tunelo
# install` turns on "linger" when it can without a password; otherwise only
# the owner can, once, with sudo, so the service also runs after logout and
# reboot. `tunelo install` leaves saying so to this script.
linger_hint() {
	[ "$os" = "Linux" ] || return 0
	user="$(id -un)"
	[ "$(loginctl show-user "$user" --property=Linger --value 2>/dev/null)" != "yes" ] || return 0
	say "Lưu ý: tunelo chạy khi bạn đang đăng nhập. Để nó chạy cả khi đã đăng xuất hoặc sau khi máy khởi động lại, chạy một lần:" \
		"Note: tunelo runs while you are logged in. To keep it running after you log out or the machine restarts, run once:" \
		"注意：tunelo 在你登录期间运行。若要在注销或重启后也保持运行，请运行一次："
	printf '  sudo loginctl enable-linger %s\n' "$user"
}

# The background service lacks Full Disk Access: its sessions cannot work in
# Desktop, Documents, Downloads or iCloud Drive, and may hang on a macOS prompt
# nobody answers. Only the owner can grant it: open the setting and a Finder
# window with tunelo selected, and say what to do; tunelo notices by itself.
# `tunelo install` leaves it to this script (TUNELO_DISK_ACCESS_HINT=script).
disk_access_hint() {
	[ "$os" = "Darwin" ] || return 0
	# The service may still be starting: give it a few seconds to answer.
	tries=0
	until status="$("$bin" status --json 2>/dev/null)"; do
		tries=$((tries + 1))
		[ "$tries" -lt 15 ] || return 0
		sleep 1
	done
	printf '%s' "$status" | grep -q '"fullDiskAccess": "needed"' || return 0
	open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" >/dev/null 2>&1 || true
	open -R "$bin" >/dev/null 2>&1 || true
	say "Việc cuối: cho tunelo quyền Truy cập toàn bộ ổ đĩa (cần khi làm trong Desktop, Documents, Downloads, iCloud Drive)." \
		"Last step: give tunelo Full Disk Access (needed to work in Desktop, Documents, Downloads, iCloud Drive)." \
		"最后一步：给 tunelo“完全磁盘访问权限”（在桌面、文稿、下载、iCloud 云盘中工作时需要）。"
	say "  1. Kéo tunelo từ cửa sổ Finder vừa mở thả vào danh sách trong Cài đặt hệ thống." \
		"  1. Drag tunelo from the Finder window that just opened into the list in System Settings." \
		"  1. 将刚打开的访达窗口中的 tunelo 拖到系统设置的列表里。"
	say "  2. Bật công tắc cạnh tunelo. tunelo tự nhận ra, không cần khởi động lại." \
		"  2. Turn on the switch next to tunelo. tunelo notices by itself; nothing to restart." \
		"  2. 打开 tunelo 旁边的开关。tunelo 会自动发现，无需重启。"
}

main "$@"
