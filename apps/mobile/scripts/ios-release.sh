#!/usr/bin/env bash
# Archive the iOS app (Release) and upload it to App Store Connect, where it
# shows up in TestFlight once processed. Run by hand on the build Mac, never
# in CI. Steps and prerequisites: docs/mobile-app.md, "Phát hành TestFlight".
#
#   ASC_KEY_ID=<Key ID> ASC_ISSUER_ID=<Issuer ID> \
#   ASC_KEY_PATH=<path to AuthKey_XXXX.p8> pnpm mobile:ios-release
#
# The embedded web build always talks to the production server, the web host
# of brand.config.json: VITE_API_ORIGIN is ignored here, so a store build
# never points at a test server.
# Optional: IOS_TEAM (default AM5C55N339), IOS_BUILD_NUMBER (default: UTC time
# YYYYMMDD.HHMM, always higher than the previous upload), IOS_RELEASE_DIR
# (keeps the archive; default: a temporary folder removed at exit),
# DEVELOPER_DIR. The .p8 key is a secret: keep it outside the repository, mode 600.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
	echo "ios-release: $*" >&2
	exit 1
}

export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
IOS_TEAM="${IOS_TEAM:-AM5C55N339}"
: "${ASC_KEY_ID:?Thiếu ASC_KEY_ID (App Store Connect → Users and Access → Integrations → Keys)}"
: "${ASC_ISSUER_ID:?Thiếu ASC_ISSUER_ID (cùng trang Keys, dòng Issuer ID)}"
: "${ASC_KEY_PATH:?Thiếu ASC_KEY_PATH (đường dẫn tệp AuthKey_<KEY_ID>.p8)}"

[[ "$IOS_TEAM" =~ ^[A-Z0-9]{10}$ ]] || fail "IOS_TEAM phải là 10 ký tự A-Z/0-9, nhận \"$IOS_TEAM\"."
[ -f "$ASC_KEY_PATH" ] || fail "Không thấy tệp key $ASC_KEY_PATH."
REPO_ROOT="$(realpath ../..)"
case "$(realpath "$ASC_KEY_PATH")" in
"$REPO_ROOT"/*) fail "Key $ASC_KEY_PATH nằm trong repo: chuyển ra ngoài (repo công khai)." ;;
esac
if [ -n "$(find "$ASC_KEY_PATH" -perm +044 2>/dev/null)" ]; then
	echo "ios-release: cảnh báo — $ASC_KEY_PATH đọc được bởi người khác; nên chmod 600." >&2
fi
# Vite also reads VITE_* from apps/web/.env* files: none may redirect the app.
if grep -qs '^VITE_API_ORIGIN=' "$REPO_ROOT"/apps/web/.env*; then
	fail "Một tệp apps/web/.env* đặt VITE_API_ORIGIN; bản phát hành phải gọi server prod."
fi
ORIGIN="https://$(jq -r '.hostTemplates.web | sub("\\{domain\\}"; input.primaryTenant.domain)' \
	"$REPO_ROOT/brand.config.json" "$REPO_ROOT/brand.config.json")"

PROJECT=ios/App/App.xcodeproj
VERSION=$(grep -m1 -E 'MARKETING_VERSION = ' "$PROJECT/project.pbxproj" | sed -E 's/.*= ([^;]+);/\1/')
BUILD_NUMBER="${IOS_BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M)}"
[[ "$BUILD_NUMBER" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || fail "IOS_BUILD_NUMBER phải là 1–3 số nguyên ngăn bằng dấu chấm, nhận \"$BUILD_NUMBER\"."

if [ -n "$(git status --porcelain)" ]; then
	echo "ios-release: cảnh báo — cây làm việc có thay đổi chưa commit; bản tải lên sẽ không khớp một commit." >&2
fi

if [ -n "${IOS_RELEASE_DIR:-}" ]; then
	WORK="$IOS_RELEASE_DIR"
	mkdir -p "$WORK"
else
	WORK=$(mktemp -d "${TMPDIR:-/tmp}/chat-release.XXXXXX")
	trap 'rm -rf "$WORK"' EXIT
fi
ARCHIVE="$WORK/App-$VERSION-$BUILD_NUMBER.xcarchive"
DERIVED="$WORK/DerivedData"
AUTH=(
	-allowProvisioningUpdates
	-authenticationKeyPath "$ASC_KEY_PATH"
	-authenticationKeyID "$ASC_KEY_ID"
	-authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

echo "→ iOS $VERSION ($BUILD_NUMBER), team $IOS_TEAM, server $ORIGIN"
env -u VITE_API_ORIGIN pnpm run build-web
pnpm exec cap sync ios

echo "→ Archive (Release)…"
xcodebuild -project "$PROJECT" -scheme App -configuration Release \
	-destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$DERIVED" \
	"${AUTH[@]}" \
	DEVELOPMENT_TEAM="$IOS_TEAM" CODE_SIGN_STYLE=Automatic \
	CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
	archive
[ -d "$ARCHIVE" ] || fail "xcodebuild không tạo ra $ARCHIVE — xem lỗi ở trên."

# `app-store-connect` + `destination: upload`: xcodebuild signs for distribution
# and uploads straight to App Store Connect (no .ipa on disk, no altool).
OPTIONS="$WORK/ExportOptions.plist"
cat >"$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>teamID</key>
	<string>$IOS_TEAM</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
PLIST

echo "→ Ký và tải lên App Store Connect…"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$OPTIONS" \
	-exportPath "$WORK/export" "${AUTH[@]}"

echo "→ Đã tải lên phiên bản $VERSION, build $BUILD_NUMBER."
echo "  App Store Connect xử lý vài phút tới vài chục phút, rồi build hiện ở TestFlight."
[ -n "${IOS_RELEASE_DIR:-}" ] && echo "  Archive: $ARCHIVE"
exit 0
