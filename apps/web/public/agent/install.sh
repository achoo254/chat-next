#!/bin/sh
# Installs tunelo, the background process of "My machines" (ADR 0013) and
# the Tunelo CLI, on macOS. "Add this machine" in Chat shows:
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
# A Mac that still runs hda (the earlier name of tunelo) is moved to tunelo
# first either way, keeping the machine, its paired devices and sessions.
#
# The release is pinned: version and SHA-256 of every file are written into
# this script when the web app is built for a tunelo release, and the
# minisign signature is checked with the embedded public key when minisign
# is installed. A script whose pins were not filled in refuses to run.
set -eu

TUNELO_VERSION="2.0.2"
SHA256_DARWIN_ARM64="9b9911393e1e72152681932e9c1ab221e39dd7a470080d3d22c559d9c9eed8ed"
SHA256_DARWIN_X64="27f63d8f41e9011d342f4c261251c4c5aa9b1e926f2c0baf1c9b04ca220b284e"
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

	[ "$(uname -s)" = "Darwin" ] || die "tunelo hiện chỉ có cho macOS và Windows." \
		"tunelo is only available for macOS and Windows." "tunelo 目前仅支持 macOS 和 Windows。"
	case "$(uname -m)" in
	arm64) asset="tunelo-darwin-arm64" sha="$SHA256_DARWIN_ARM64" ;;
	x86_64) asset="tunelo-darwin-x64" sha="$SHA256_DARWIN_X64" ;;
	*) die "kiến trúc máy không được hỗ trợ." "this processor is not supported." "不支持此处理器。" ;;
	esac

	# hda keeps its config here; the marker means it has already moved to tunelo.
	hda_dir="${CHAT_AGENT_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/chat-agent}"
	from_hda=""
	if [ -f "$hda_dir/config.json" ] && [ ! -f "$hda_dir/migrated-to-tunelo" ]; then
		from_hda="yes"
	fi
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	trap 'exit 130' INT TERM
	url="$RELEASES/tunelo-v$TUNELO_VERSION/$asset"
	say "Đang tải tunelo ${TUNELO_VERSION}…" "Downloading tunelo ${TUNELO_VERSION}…" "正在下载 tunelo ${TUNELO_VERSION}…"
	curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$url" || die "không tải được $url" "could not download $url" "无法下载 $url"
	[ "$(sha256_of "$tmp/$asset")" = "$sha" ] || die "file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt." \
		"the download does not match the pinned SHA-256; nothing was installed." "下载的文件与固定的 SHA-256 不符；未安装任何内容。"
	if command -v minisign >/dev/null 2>&1; then
		curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$asset.minisig" "$url.minisig" ||
			die "không tải được chữ ký minisign." "could not download the minisign signature." "无法下载 minisign 签名。"
		minisign -Vq -P "$MINISIGN_PUBKEY" -m "$tmp/$asset" -x "$tmp/$asset.minisig" ||
			die "chữ ký minisign không hợp lệ; đã huỷ cài đặt." "the minisign signature is invalid; nothing was installed." "minisign 签名无效；未安装任何内容。"
	fi

	bin_dir="$HOME/.local/bin"
	bin="$bin_dir/tunelo"
	mkdir -p "$bin_dir"
	chmod 0755 "$tmp/$asset"
	mv -f "$tmp/$asset" "$bin.new"
	mv -f "$bin.new" "$bin"

	# Put tunelo on PATH for new terminals (zsh is the macOS default shell).
	case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*)
		line='export PATH="$HOME/.local/bin:$PATH"'
		for rc in "$HOME/.zprofile" "$HOME/.bash_profile"; do
			case "$rc" in *bash_profile) [ -f "$rc" ] || continue ;; esac
			grep -Fqs "$line" "$rc" || printf '\n%s\n' "$line" >> "$rc"
		done
		say "Đã thêm $bin_dir vào PATH; mở terminal mới để gõ tunelo." "Added $bin_dir to your PATH; open a new terminal to use tunelo." "已将 $bin_dir 加入 PATH；打开新终端即可使用 tunelo。"
		;;
	esac

	# The old Tunelo CLI from npm (1.x) is also called tunelo and may come first on PATH.
	if command -v npm >/dev/null 2>&1 && npm ls -g tunelo --depth=0 >/dev/null 2>&1; then
		say "Lưu ý: gói npm tunelo 1.x cũ vẫn đang cài và có thể che lệnh tunelo mới. Gỡ nó bằng: npm uninstall -g tunelo" \
			"Note: the old tunelo 1.x npm package is still installed and may hide the new tunelo command. Remove it with: npm uninstall -g tunelo" \
			"注意：旧的 tunelo 1.x npm 包仍已安装，可能遮住新的 tunelo 命令。请运行 npm uninstall -g tunelo 卸载。"
	fi

	if [ -n "$from_hda" ]; then
		say "Tìm thấy hda trên máy; đang chuyển sang tunelo (giữ máy, thiết bị đã ghép và các phiên)…" \
			"Found hda on this Mac; moving it to tunelo (the machine, paired devices and sessions stay)…" \
			"在这台 Mac 上找到 hda；正在迁移到 tunelo（保留电脑、已配对设备和会话）…"
		"$bin" migrate-from-hda || die "chuyển hda sang tunelo không thành công; hda vẫn chạy như cũ." \
			"moving hda to tunelo failed; hda keeps running as before." "hda 迁移到 tunelo 失败；hda 仍照常运行。"
	fi

	if [ -z "$device_key" ]; then
		# A running background service still runs the previous file: restart it
		# on the new one (moving from hda already started tunelo).
		if [ -z "$from_hda" ] && "$bin" status --json >/dev/null 2>&1; then
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
	printf '%s\n' "$secret" | "$bin" install --trust "$device_key"
}

main "$@"
