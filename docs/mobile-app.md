# App iOS và Android

App mobile là chính web app (`apps/web`) đóng trong Capacitor 8 (`apps/mobile`): mọi màn hình và tính năng của web chạy trong WebView, đăng nhập qua trình duyệt hệ thống, token phiên nằm trong Keychain/Keystore. Quyết định: [ADR 0006](./adr/0006-sign-in-and-chat-sessions.md), [ADR 0011](./adr/0011-native-sessions-bearer-cors.md).

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `apps/mobile/capacitor.config.ts` | `appId`, `appName` đọc từ `brand/generated/capacitor.json` (sinh bằng `pnpm brand:gen`); `webDir` là `www/` |
| `apps/mobile/www/` | Bundle web build ở chế độ native; không commit (`.gitignore`) |
| `apps/mobile/ios/` | Project Xcode, Swift Package Manager (`CapApp-SPM`), iOS 15 trở lên |
| `apps/mobile/android/` | Project Gradle, minSdk 24, targetSdk 36 |
| `apps/web/src/native/` | Mã chỉ có trong bản native: đăng nhập PKCE, token trong secure storage, `fetch` gắn bearer |
| `apps/web/src/server-origin.ts` | `IS_NATIVE` và gốc server; web là origin của trang, native là `VITE_API_ORIGIN` |

Plugin: `@capacitor/app` (trạng thái foreground), `@aparajita/capacitor-secure-storage` (token), `@shared-next/capacitor-system-auth` (trình duyệt hệ thống, cài từ tag git của `shared-next`).

## Build và chạy

Yêu cầu như web, thêm Xcode cho iOS; Android build trên CI (máy dev không cần Android SDK).

```bash
pnpm install
pnpm mobile:build-web          # VITE_NATIVE=true, ra apps/mobile/www
pnpm mobile:sync               # build-web rồi `cap sync` (copy bundle, cập nhật plugin)
cd apps/mobile && pnpm exec cap open ios        # mở Xcode, chạy trên Simulator hoặc máy thật
```

- Server mặc định là host web của tenant chính trong `brand.config.json` (`https://chat.hoandat.com`). Trỏ sang server khác lúc build: `VITE_API_ORIGIN=https://chat.<domain> pnpm mobile:build-web`. Server đó phải có `APP_URL_SCHEME` khớp `urlScheme` của brand và IdP phải khai `chat-mobile` với cùng redirect.
- Tắt đăng nhập của app ở một server: `NATIVE_SIGN_IN=off` trong env của server ([`server/README.md`](../server/README.md)); phiên app đang có vẫn dùng được tới khi kết thúc.
- `VITE_APP_VERSION` lấy `version` của `apps/mobile/package.json`; hiện trong danh sách phiên.
- Build Simulator không ký, giống CI:

  ```bash
  cd apps/mobile/ios/App
  xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
  ```

- CI (`.github/workflows/mobile.yml`) chạy khi `apps/`, `packages/`, brand hoặc lockfile đổi: APK debug (artifact `android-debug-apk`, giữ 14 ngày, cài thử bằng `adb install`) và build iOS Simulator không ký.

## Đăng nhập

1. App gọi `AuthService.GetAuthConfig` (platform IOS/ANDROID) và nhận `authorization_endpoint`, `client_id` `chat-mobile`, `redirect_uri` `com.hoandat.chat:/auth/callback`, scope.
2. JS tạo `code_verifier`, `code_challenge` (S256) và `state`, mở URL đăng nhập bằng `SystemAuth.authenticate` (ASWebAuthenticationSession trên iOS, Auth Tab hoặc Custom Tab trên Android). Trang IdP không bao giờ mở trong WebView.
3. Callback chỉ được nhận khi đúng `redirect_uri` và `state`; người dùng đóng trình duyệt thì không có gì xảy ra.
4. App gửi `code`, `code_verifier`, `redirect_uri`, platform, tên thiết bị và phiên bản tới `ExchangeNativeCode`. Server đổi code ở IdP, kiểm ID token, tạo phiên native và trả token phiên opaque.
5. Token được lưu vào Keychain (`whenUnlockedThisDeviceOnly`) hoặc Keystore; từ đó mọi request `/rpc` gửi `Authorization: Bearer`, WebSocket gửi token trong `ClientHelloFrame`, media dùng URL ký như web.

Nút "Đăng nhập", "Tạo tài khoản" và các bước "đăng nhập lại để xác nhận" của web là link `/auth/login?...`; bản native chặn chúng ở document và chạy luồng trên (`prompt=create`, hoặc `prompt=login&max_age=600` khi xác nhận; phiên mới thay phiên cũ). Form đăng xuất `/auth/logout` gọi `SignOut` rồi xoá token. Phiên bị thu hồi (từ thiết bị khác, ở `/account` của IdP, hết hạn) thì app xoá DB local và token như web và quay về màn hình chào. Đăng xuất IdP trên trình duyệt không đăng xuất app; các cách phiên app kết thúc và độ trễ của từng cách: [ADR 0011](./adr/0011-native-sessions-bearer-cors.md#phiên-native-kết-thúc-thế-nào).

## Khác web

- Không có service worker và Web Push; mục "Thông báo khi đã đóng app" bị ẩn, mục "Cài ứng dụng" báo đã cài.
- DB local vẫn là SQLite WebAssembly của web. Khi WebView không có OPFS (iOS 15–16, WebView cũ) hoặc OPFS từ chối, DB chạy trong bộ nhớ: dùng được khi có mạng, mở app lần sau đồng bộ lại.
- Quyền máy: camera (chụp ảnh, quay video từ ô chọn file), micro (tin nhắn thoại), thư viện ảnh (iOS). Android tắt `allowBackup` để cache chat không đi theo bản sao lưu.

## Chưa làm

- Thông báo đẩy APNs/FCM (cần key APNs và project Firebase), notification service extension.
- Ký và phát hành: TestFlight cần app record `com.hoandat.chat` trên App Store Connect; AAB ký cần Play Console và keystore. Không có secret ký nào trong repo.
- SQLCipher native cho DB local (ADR 0009), OTA, Mini App trong in-app browser.
- Icon và splash từ brand cho iOS/Android (đang là icon mặc định của Capacitor).
- Chọn tenant khác trong app: một bản build trỏ tới một server (`VITE_API_ORIGIN`).
- Thông báo lỗi đăng nhập dùng hộp thoại hệ thống (`alert`), chưa theo giao diện app.
