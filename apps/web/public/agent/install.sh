#!/bin/sh
# Installs tunelo, the background process of "My machines" (ADR 0013) and
# the Tunelo CLI, on macOS and Linux (x86_64, aarch64; glibc, systemd). "Add
# this machine" in Chat shows one fixed command, without arguments:
#
#   curl -fsSL https://<chat host>/agent/install.sh | sh
#
# It downloads the release archive for this system, checks it, puts tunelo
# and tunelo-term-host (the process that keeps the machine's terminals) into
# ~/.local/bin and runs `tunelo login`: you approve in the browser, and tunelo
# signs in, starts in the background and joins My machines by itself. The
# same command updates an installed tunelo. Messages follow the system
# language (LC_ALL, LC_MESSAGES, LANG).
#
# When `tunelo update` already put a terminal process into the config
# folder, the new one is also staged there; tunelo switches to it once no
# terminal is open.
#
# The release is pinned: version and SHA-256 of every archive are written
# into this script when the web app is built for a tunelo release, and the
# minisign signatures (of the archive and of each file in it) are checked
# with the embedded public key when minisign is installed. A script whose
# pins were not filled in refuses to run.
set -eu

TUNELO_VERSION="3.3.4"
SHA256_DARWIN_ARM64="6e4b007f9a7b2608438dc47db03152ed0ef27735e575111f35079fcf14726236"
SHA256_DARWIN_X64="88c8afa8937c9e2230e9d277813228070f702a41a53a4c90cf4396817445a320"
SHA256_LINUX_X64="fe132c3e9d3a642a33a855cb28a90ade94eefb815a2f521d08409fd7ce949df8"
SHA256_LINUX_ARM64="b189edfbcc00f922c7977af80755f15bf96be09304676f8b79b8080537a477cd"
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

# Sets asset (tunelo's file name in the release), sha (the pinned SHA-256 of
# its archive), archive and host_asset (the terminal process) for this
# system: pick_asset <uname -s> <uname -m>.
pick_asset() {
	case "${1}/${2}" in
	Darwin/arm64) asset="tunelo-darwin-arm64" sha="$SHA256_DARWIN_ARM64" ;;
	Darwin/x86_64) asset="tunelo-darwin-x64" sha="$SHA256_DARWIN_X64" ;;
	Linux/x86_64 | Linux/amd64) asset="tunelo-linux-x64" sha="$SHA256_LINUX_X64" ;;
	Linux/aarch64 | Linux/arm64) asset="tunelo-linux-arm64" sha="$SHA256_LINUX_ARM64" ;;
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
	archive="${asset}.tar.gz"
	host_asset="tunelo-term-host-${asset#tunelo-}"
}

# download <file>: a file of the pinned release into $tmp.
download() {
	url="${RELEASES}/tunelo-v${TUNELO_VERSION}/${1}"
	curl -fsSL --proto '=https' --tlsv1.2 -o "${tmp}/${1}" "$url" || die "không tải được ${url}" "could not download ${url}" "无法下载 ${url}"
}

# check_signature <file>: its minisign signature (<file>.minisig next to it).
check_signature() {
	minisign -Vq -P "$MINISIGN_PUBKEY" -m "$1" -x "${1}.minisig" ||
		die "chữ ký minisign không hợp lệ; đã huỷ cài đặt." "the minisign signature is invalid; nothing was installed." "minisign 签名无效；未安装任何内容。"
}

# Downloads the archive, checks it and unpacks tunelo, its terminal process
# and their signatures into $unpacked; nothing is installed before this ends.
fetch_release() {
	download "$archive"
	[ "$(sha256_of "${tmp}/${archive}")" = "$sha" ] || die "file tải về không khớp SHA-256 đã ghim; đã huỷ cài đặt." \
		"the download does not match the pinned SHA-256; nothing was installed." "下载的文件与固定的 SHA-256 不符；未安装任何内容。"
	unpacked="${tmp}/unpacked"
	mkdir "$unpacked"
	tar -xzf "${tmp}/${archive}" -C "$unpacked" "$asset" "${asset}.minisig" "$host_asset" "${host_asset}.minisig" ||
		die "không giải nén được ${archive}; đã huỷ cài đặt." "could not unpack ${archive}; nothing was installed." "无法解压 ${archive}；未安装任何内容。"
	if command -v minisign >/dev/null 2>&1; then
		download "${archive}.minisig"
		check_signature "${tmp}/${archive}"
		check_signature "${unpacked}/${asset}"
		check_signature "${unpacked}/${host_asset}"
	fi
}

# A terminal process `tunelo update` put into the config folder comes before
# the one next to tunelo: stage the new one there too (with its signature,
# which names its version); tunelo switches to it once no terminal is open.
stage_term_host() {
	host_bins="${config_dir}/term-host/bin"
	[ -d "${host_bins}/current" ] || return 0
	rm -rf "${host_bins}/next.partial"
	mkdir -p "${host_bins}/next.partial"
	cp "${unpacked}/${host_asset}" "${host_bins}/next.partial/tunelo-term-host"
	cp "${unpacked}/${host_asset}.minisig" "${host_bins}/next.partial/tunelo-term-host.minisig"
	chmod 0755 "${host_bins}/next.partial/tunelo-term-host"
	rm -rf "${host_bins}/next"
	mv "${host_bins}/next.partial" "${host_bins}/next"
}

# Linux needs glibc (the build is not for musl).
check_linux() {
	if ldd --version 2>&1 | grep -qi musl; then
		die "tunelo cần Linux dùng glibc (Ubuntu, Debian, Fedora…); bản musl như Alpine chưa được hỗ trợ." \
			"tunelo needs a glibc Linux (Ubuntu, Debian, Fedora…); musl systems such as Alpine are not supported." \
			"tunelo 需要使用 glibc 的 Linux（Ubuntu、Debian、Fedora…）；暂不支持 Alpine 等 musl 系统。"
	fi
}

# add_path_line <rc file> always|if-present: appends $line once.
add_path_line() {
	[ "$2" = "always" ] || [ -f "$1" ] || return 0
	grep -Fqs "$line" "$1" || printf '\n%s\n' "$line" >> "$1"
}

# The language of the system: the first of LC_ALL, LC_MESSAGES, LANG that is set.
pick_lang() {
	locale="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
	case "$locale" in
	vi*) lang="vi" ;;
	zh*) lang="zh-CN" ;;
	*) lang="en" ;;
	esac
}

main() {
	pick_lang

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
	fetch_release

	bin_dir="$HOME/.local/bin"
	bin="$bin_dir/tunelo"
	config_dir="${TUNELO_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/tunelo}"
	mkdir -p "$bin_dir"
	# tunelo first: if it cannot be put in place, no newer terminal process waits for it.
	chmod 0755 "${unpacked}/${asset}" "${unpacked}/${host_asset}"
	mv -f "${unpacked}/${asset}" "$bin.new"
	mv -f "$bin.new" "$bin"
	# What `tunelo update --rollback` would put back is not the release before this one any more.
	rm -f "$bin.old" "${config_dir}/update-rollback.json"
	# A running terminal process keeps the file it started from; open shells stay.
	cp "${unpacked}/${host_asset}" "${bin_dir}/tunelo-term-host.new"
	mv -f "${bin_dir}/tunelo-term-host.new" "${bin_dir}/tunelo-term-host"
	stage_term_host

	# Put tunelo on PATH for new terminals: zsh is the macOS default shell;
	# Linux login shells read ~/.profile, interactive bash ~/.bashrc.
	case ":$PATH:" in
	*":$bin_dir:"*) ;;
	*)
		# shellcheck disable=SC2016 # written as is into the shell's startup file
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

	# A running background service still runs the previous file: restart it
	# on the new one.
	if "$bin" status --json >/dev/null 2>&1; then
		say "Đang khởi động lại tunelo chạy nền với bản mới…" "Restarting the background tunelo on the new version…" "正在用新版本重启后台 tunelo…"
		"$bin" stop >/dev/null 2>&1 || true
		"$bin" start || say "Chưa khởi động lại được; chạy tunelo login." "Could not restart it; run tunelo login." "无法重启；请运行 tunelo login。"
	fi

	# One sign-in for the tunnel, Chat and Localman; it also starts tunelo in
	# the background and adds the machine. A failed or skipped sign-in leaves
	# tunelo installed. Sign-in needs no typing (device code), so without a
	# terminal (`curl … | sh` over a pipe, CI) it gets an empty stdin. The
	# script shows the last macOS and Linux steps itself, in the system's
	# language.
	say "Đăng nhập tài khoản cho tunelo (tunnel, Chat, Localman)…" \
		"Signing tunelo in with your account (tunnel, Chat, Localman)…" "正在用你的账号登录 tunelo（隧道、Chat、Localman）…"
	signed_in=0
	if (: </dev/tty) 2>/dev/null; then
		TUNELO_DISK_ACCESS_HINT=script "$bin" login </dev/tty || signed_in=$?
	else
		TUNELO_DISK_ACCESS_HINT=script "$bin" login </dev/null || signed_in=$?
	fi
	if [ "$signed_in" -ne 0 ]; then
		say "Chưa kết nối xong máy này; xem lý do ở trên, hoặc chạy tunelo status." \
			"This machine is not connected yet; see the reason above, or run tunelo status." "此机器尚未连接完成；原因见上方，或运行 tunelo status。"
		return 0
	fi
	linger_hint
	disk_access_hint
}

# Linux: the systemd user service runs while the owner is logged in. `tunelo
# login` turns on "linger" when it can without a password; otherwise only
# the owner can, once, with sudo, so the service also runs after logout and
# reboot. `tunelo login` leaves saying so to this script.
linger_hint() {
	[ "$os" = "Linux" ] || return 0
	command -v loginctl >/dev/null 2>&1 || return 0
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
# `tunelo login` leaves it to this script (TUNELO_DISK_ACCESS_HINT=script).
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
		"最后一步：给 tunelo「完全磁盘访问权限」（在桌面、文稿、下载、iCloud 云盘中工作时需要）。"
	say "  1. Kéo tunelo từ cửa sổ Finder vừa mở thả vào danh sách trong Cài đặt hệ thống." \
		"  1. Drag tunelo from the Finder window that just opened into the list in System Settings." \
		"  1. 将刚打开的访达窗口中的 tunelo 拖到系统设置的列表里。"
	say "  2. Bật công tắc cạnh tunelo. tunelo tự nhận ra, không cần khởi động lại." \
		"  2. Turn on the switch next to tunelo. tunelo notices by itself; nothing to restart." \
		"  2. 打开 tunelo 旁边的开关。tunelo 会自动发现，无需重启。"
}

# Arguments are ignored: commands copied from an older page still install.
main
