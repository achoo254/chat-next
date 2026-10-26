# ADR 0011: Phiên của app native, bearer token và CORS

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-23
- Bổ sung cho [ADR 0006](./0006-sign-in-and-chat-sessions.md) (đăng nhập và phiên chat). ADR 0006 đã chốt nguyên tắc: native dùng client `chat-mobile`, token phiên trong Keychain/Keystore, origin của WebView chỉ được nhận cho request xác thực bằng token chứ không bằng cookie. ADR này chốt cách hiện thực ở server và client.

## Bối cảnh

App iOS và Android là chính web app (`apps/web`) đóng trong Capacitor (`apps/mobile`). WebView tải bundle từ `capacitor://localhost` (iOS) hoặc `https://localhost` (Android), nên mọi request tới `https://chat.<d>` là cross-origin: không có cookie `__Host-` (và không được có), WebSocket trong trình duyệt không đặt được header, và `/rpc` cần CORS. Web vẫn chạy cùng origin với cookie `HttpOnly` và kiểm `Origin`, không được yếu đi.

## Quyết định

### Phiên native

- `AuthService.GetAuthConfig` với platform IOS/ANDROID trả `authorization_endpoint` của tenant, `client_id` `chat-mobile`, `redirect_uri` (`<APP_URL_SCHEME>:/auth/callback`, mặc định `com.hoandat.chat:/auth/callback`, phải khớp `CHAT_MOBILE_REDIRECT_URI` của IdP), scope và tên tenant.
- App tự làm PKCE S256 và `state` trong JS, mở URL bằng `@shared-next/capacitor-system-auth` (ASWebAuthenticationSession, Auth Tab/Custom Tabs), chỉ nhận callback đúng `redirect_uri` và `state`.
- `ExchangeNativeCode` kiểm `platform`, dạng `code_verifier` (RFC 7636) và `redirect_uri` đúng bằng của client, đổi code ở token endpoint như client public (`client_id` trong body, không secret), kiểm ID token như callback web (iss, aud `chat-mobile`, ES256, exp; userinfo cùng subject) và áp cùng hạn mức tạo tài khoản. Không có `nonce`: PKCE đã gắn code với app đã bắt đầu đăng nhập.
- Phiên ghi `idp_client_id = chat-mobile`, `platform` (2 iOS, 3 Android), `device_name`, `app_version` (migration `0030_native_sessions.sql`). `platform` là nguồn duy nhất cho "phiên native": trượt 30 ngày, không có trần 90 ngày; refresh, thu hồi và revoke ở IdP dùng client `chat-mobile`.
- Gửi `ExchangeNativeCode` kèm bearer của phiên native hiện tại cùng người dùng (đăng nhập lại để xác nhận thao tác nhạy cảm) thì phiên cũ bị thay (`SESSION_REVOKE_REASON_REPLACED`) như web.
- `NATIVE_SIGN_IN=off` tắt đăng nhập native của một deployment: `GetAuthConfig` (IOS/ANDROID) và `ExchangeNativeCode` trả `failed_precondition`; phiên native đang có vẫn chạy tới khi kết thúc theo mục dưới. nginx giới hạn `ExchangeNativeCode` bằng zone `chat_auth` (10 request/giây mỗi địa chỉ, burst 20) như các trang `/auth/`, chặt hơn zone `/rpc/` chung.
- Giả mạo client (RFC 8252 §8.6): client native không có secret, một app khác có thể dùng `client_id` `chat-mobile` và đăng ký cùng scheme. IdP luôn hiện trang duyệt cho client tĩnh có `application_type: native`, kể cả `chat-mobile`: `auth-next/src/interactions/consent-handler.ts` chỉ bỏ qua trang duyệt khi `isStaticClientId(clientId) && client.applicationType !== "native"`. Người dùng thấy tên client và quyền xin cấp trước khi có code. PKCE ngăn app khác lấy code giữa đường của lần đăng nhập do app này bắt đầu; ASWebAuthenticationSession và Auth Tab trả callback thẳng cho app đã mở phiên.

### Phiên native kết thúc thế nào

| Cách | Khi nào có hiệu lực |
|---|---|
| Đăng xuất trong app (`SignOut` bằng bearer) | Ngay; refresh token bị thu hồi ở IdP bằng client `chat-mobile` |
| Thu hồi từ phiên khác (`RevokeSession`, `RevokeOtherSessions`), xoá tài khoản, operator | Ngay; outbox `session_revoked` đóng socket của phiên trong ≤ 1 s |
| Gỡ thiết bị hoặc grant hết ở `/account` của IdP | Lần kiểm grant kế tiếp: refresh trả `invalid_grant` thì phiên bị thu hồi. Phiên đang dùng được kiểm mỗi giờ; phiên không dùng được kiểm ở request đầu tiên khi app mở lại (request đó vẫn chạy, việc kiểm chạy nền ngay sau). Job kiểm grant 24 giờ của ADR 0006 chưa có cho cả web lẫn native |
| Không dùng 30 ngày | Tự hết hạn; không có trần 90 ngày |
| Back-channel logout `aud` `chat-mobile` (theo `sid`, hoặc theo `sub` khi không có `sid`) | Ngay. IdP hiện **không** gửi: `nativeChatClient` trong `auth-next/src/oidc/chat-clients.ts` không khai `backchannel_logout_uri`. Server nhận sẵn để IdP bật mà không cần đổi chat; bật nghĩa là đăng xuất IdP trên trình duyệt cũng đăng xuất app, trái với mục "Native theo grant của từng thiết bị" của ADR 0006, nên cần quyết định riêng ở IdP |
| Back-channel logout `aud` `chat-web` có `sid` | Chỉ phiên web của `sid` đó; phiên native cùng `sid` (trình duyệt hệ thống dùng chung phiên IdP) **không** bị thu hồi, theo ADR 0006 |
| Back-channel logout `aud` `chat-web` không có `sid` (cả tài khoản ở IdP kết thúc) | Mọi phiên của `sub` đó, web và native. IdP khai `chat-web` với `backchannel_logout_session_required` nên thực tế luôn gửi `sid` |

### Bearer

- Phiên native xác thực bằng `Authorization: Bearer <token>` ở `/rpc` và bằng `ClientHelloFrame.session_token` ở `/ws`. Bearer chỉ nhận phiên native (`Sessions.AuthenticateBearer`); token của phiên web (cookie) không bao giờ hợp lệ làm bearer.
- Request từ origin native không bao giờ dùng cookie: không có bearer thì coi như chưa đăng nhập.
- `/ws` từ origin native được upgrade trước rồi mới xác thực bằng hello (trong `helloTimeout`); token sai nhận `ErrorFrame UNAUTHENTICATED` rồi bị đóng. Từ origin web vẫn kiểm cookie trước khi upgrade như cũ.
- Thu hồi, `SignOut`, kiểm grant theo giờ và job 24 giờ chạy chung cho phiên native; gateway đóng socket của phiên bị thu hồi theo id phiên, không phụ thuộc cách xác thực.

### Origin và CORS

- Allowlist `Origin` của web giữ nguyên. Thêm đúng hai origin `capacitor://localhost` và `https://localhost`, chỉ qua được kiểm origin; chúng không mở được phiên bằng cookie.
- CORS chỉ ở `/rpc` và chỉ cho hai origin đó: preflight trả 204 với `POST, GET`, header `Authorization`, `Content-Type` và header của Connect; không bao giờ `Access-Control-Allow-Credentials`. Origin khác không nhận header CORS nào.
- Media (`/f/`, `/u/` trên host media) đã dùng URL ký và CORS `*`, không cần cookie hay bearer: không đổi.

### Client

- Bundle native build với `VITE_NATIVE=true` (`pnpm mobile:build-web`); gốc API là `VITE_API_ORIGIN`, mặc định host web của tenant chính trong `brand.config.json`. Bản web không chứa mã native: import động chỉ nằm sau phép thử `import.meta.env.VITE_NATIVE` tại chỗ.
- Token phiên nằm trong `@aparajita/capacitor-secure-storage` (Keychain `whenUnlockedThisDeviceOnly`, Keystore), theo từng server. Link `/auth/login` và form `/auth/logout` của web được chặn ở document và chạy luồng native, nên các màn hình giữ nguyên.

## Lý do

- Bearer đi kèm request do chính app gắn; trang chéo site không đọc và không gắn được nó, nên origin native không cần cookie hay CSRF token. Không cho cookie đi từ origin native giữ nguyên bảo vệ của web.
- Token trong hello là cách duy nhất WebView gửi được bí mật khi mở WebSocket mà không đưa nó vào URL (log của proxy).
- Không có trần 90 ngày cho native theo ADR 0006: grant theo thiết bị, người dùng thu hồi ở `/account`.

## Hệ quả

- Đăng xuất IdP trên trình duyệt không đăng xuất app; thu hồi ở `/account` có hiệu lực ở lần kiểm grant kế tiếp (bảng trên), không tức thì.
- Một bản app phục vụ một server (`VITE_API_ORIGIN` lúc build). Không có chọn tenant khác trong app: hệ sinh thái chỉ còn một tenant ([ADR 0013 của `auth-next`](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md)).
- Socket native chưa xác thực tồn tại tối đa `helloTimeout`; nginx giới hạn tốc độ handshake ở `/ws`.
- iOS 15–16 không có OPFS sync access handle trong WebView: DB local chạy trong bộ nhớ cho lần chạy đó và đồng bộ lại khi mở app. SQLCipher native (ADR 0009) chưa làm.

## Cách thay đổi

- Đổi scheme: đổi `APP_URL_SCHEME` của server, `CHAT_MOBILE_REDIRECT_URI` của IdP, `urlScheme` trong brand, `CFBundleURLTypes` (iOS) và `systemAuthRedirectScheme` (Android), rồi phát hành app mới.
- Thêm origin native (ví dụ scheme Capacitor khác): sửa `auth.NativeOrigin*` và test `TestNativeCORS`, `TestNativeAuthConfig`.
- Chuyển WebSocket sang ticket một lần: thêm RPC cấp ticket ngắn hạn, giữ hello token cho bản app cũ tới khi hết hỗ trợ.

Nguồn: `server/internal/auth/native.go`, `server/internal/store/sessions.go` (`BackchannelLogout`), `server/internal/rpc/auth_service.go`, `server/internal/gateway/handler.go`, `apps/web/src/native/`, test `server/internal/api/native_test.go`.
