#!/bin/sh
# Installs chat-agent, the background process of "My machines" (ADR 0013),
# on macOS. The web app shows the command:
#
#   curl -fsSL https://<chat host>/agent/install.sh | sh -s -- <install code> <device key> [vi|en|zh-CN]
#
# then asks you to paste the pairing secret it shows, which this script
# reads from the terminal with echo off: the secret is never in a command
# line (argv, shell history, ps). The install code (one-time, 10 minutes)
# and the device's public key are not secret.
#
# The release is pinned: version and SHA-256 of every file are written into
# this script when the web app is built for a chat-agent release, and the
# minisign signature is checked with the embedded public key when minisign
# is installed. A script whose pins were not filled in refuses to run.
set -eu

AGENT_VERSION="__AGENT_VERSION__"
SHA256_DARWIN_ARM64="__SHA256_DARWIN_ARM64__"
SHA256_DARWIN_X64="__SHA256_DARWIN_X64__"
MINISIGN_PUBKEY="__MINISIGN_PUBKEY__"
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

main() {
	case "${3:-${LANG:-en}}" in
	vi*) lang="vi" ;;
	zh*) lang="zh-CN" ;;
	*) lang="en" ;;
	esac
	[ $# -ge 2 ] || die "thiếu mã cài hoặc khoá thiết bị; hãy chép lại lệnh từ trang Chat." \
		"missing the install code or the device key; copy the command from the Chat page again." \
		"缺少安装码或设备密钥；请从 Chat 页面重新复制命令。"
	code="$1"
	device_key="$2"
	printf '%s' "$code" | grep -Eq '^[A-Za-z0-9_-]{22}$' || die "mã cài không hợp lệ." "the install code is malformed." "安装码格式不正确。"
	printf '%s' "$device_key" | grep -Eq '^[A-Za-z0-9_-]{43}$' || die "khoá thiết bị không hợp lệ." "the device key is malformed." "设备密钥格式不正确。"

	case "$AGENT_VERSION" in
	__*) die "chưa có bản phát hành chat-agent." "no chat-agent release is available yet." "chat-agent 尚未发布。" ;;
	esac

	[ "$(uname -s)" = "Darwin" ] || die "chat-agent hiện chỉ có cho macOS và Windows." \
		"chat-agent is only available for macOS and Windows." "chat-agent 目前仅支持 macOS 和 Windows。"
	case "$(uname -m)" in
	arm64) asset="chat-agent-darwin-arm64" sha="$SHA256_DARWIN_ARM64" ;;
	x86_64) asset="chat-agent-darwin-x64" sha="$SHA256_DARWIN_X64" ;;
	*) die "kiến trúc máy không được hỗ trợ." "this processor is not supported." "不支持此处理器。" ;;
	esac

	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT INT TERM
	url="$RELEASES/agent-v$AGENT_VERSION/$asset"
	say "Đang tải chat-agent $AGENT_VERSION…" "Downloading chat-agent $AGENT_VERSION…" "正在下载 chat-agent $AGENT_VERSION…"
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
	bin="$bin_dir/chat-agent"
	mkdir -p "$bin_dir"
	chmod 0755 "$tmp/$asset"
	mv -f "$tmp/$asset" "$bin.new"
	mv -f "$bin.new" "$bin"

	[ -r /dev/tty ] || die "cần chạy lệnh trong cửa sổ Terminal để dán mã ghép." \
		"run the command in a Terminal window to paste the pairing secret." "请在终端窗口中运行该命令以粘贴配对密钥。"
	say "Dán mã ghép đang hiện trên trang Chat rồi bấm Enter (chữ sẽ không hiện khi dán):" \
		"Paste the pairing secret shown on the Chat page and press Enter (it stays hidden):" \
		"粘贴 Chat 页面上显示的配对密钥并按回车（输入内容不会显示）："
	stty -echo </dev/tty 2>/dev/null || true
	secret=""
	IFS= read -r secret </dev/tty || true
	stty echo </dev/tty 2>/dev/null || true
	printf '\n'
	printf '%s' "$secret" | grep -Eq '^[A-Za-z0-9_-]{43}$' || die "mã ghép không hợp lệ; chạy lại lệnh và dán đúng mã." \
		"the pairing secret is malformed; run the command again and paste it." "配对密钥格式不正确；请重新运行命令并粘贴。"

	# printf is a shell builtin: the secret reaches chat-agent on stdin only.
	printf '%s\n' "$secret" | "$bin" install "$code" --trust "$device_key"

	case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*) say "Đã cài vào $bin (thư mục này chưa có trong PATH)." "Installed to $bin (that folder is not on your PATH)." "已安装到 $bin（该目录不在 PATH 中）。" ;;
	esac
}

main "$@"
