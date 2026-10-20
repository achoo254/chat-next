# ADR 0006: Đăng nhập qua auth-next và phiên chat

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14
- Huỷ 20/10/2026: desktop = PWA. Toàn hệ sinh thái không có app desktop native (Tauri); trên máy tính dùng bản web cài dạng PWA, đăng nhập bằng `chat-web`. Client `chat-desktop` đã gỡ khỏi IdP. Native chỉ còn mobile (`chat-mobile`); giá trị `CLIENT_PLATFORM_DESKTOP` trong proto giữ số nhưng server coi như web. Phần nói về desktop/Tauri bên dưới chỉ còn là lịch sử.

## Bối cảnh

App chat là một sản phẩm trong hệ sinh thái hoandat. Danh tính người dùng do IdP OpenID Connect `auth-next` quản lý; IdP chỉ cho đăng nhập bằng Google hoặc GitHub, không có mật khẩu và không gửi email. Refresh token của IdP dùng một lần và xoay vòng: đưa lại token cũ làm IdP thu hồi cả grant. Gửi tin cần độ trễ vài chục mili-giây, nên không thể gọi IdP ở mỗi request, nhưng đăng xuất hay gỡ quyền ở trang `/account` của IdP vẫn phải cắt được phiên chat. Phiên web đặt sai chỗ (token trong JavaScript, cookie không khoá site) là đường cho XSS, CSRF và chiếm WebSocket chéo site.

## Quyết định

### Danh tính

- App chat không có đăng ký, mật khẩu, OTP, 2FA hay gửi email. Nút "Tạo tài khoản" gửi `prompt=create` để IdP mở trang đăng ký. Mọi authorization request gửi `ui_locales` theo ngôn ngữ đang hiển thị của app.
- Danh tính chat là cặp `(tenant_id, idp_sub)`, duy nhất. `sub` (`acc_…`) không đổi khi người dùng đổi email hay username.
- Lần đầu thấy một cặp mới, server tạo user với `preferred_username` làm username (trùng thì thêm hậu tố và cho người dùng đổi), `name` và `picture` làm hồ sơ ban đầu.
- Email chỉ được lưu khi `email_verified=true`. Server đọc lại `email` và `email_verified` ở mỗi lần đăng nhập và mỗi lần refresh; email bị gỡ hoặc chưa xác minh thì xoá bản đã lưu.

### Luồng theo nền tảng

| Nền tảng | Client IdP | Luồng | Redirect |
|---|---|---|---|
| Web | `chat-web`, confidential, `client_secret_basic` | Server làm Code + PKCE S256, scope `openid profile email` | `https://chat.<d>/auth/callback`; back-channel logout ở `https://chat.<d>/auth/backchannel-logout` |
| iOS, Android | `chat-mobile`, public, native | ASWebAuthenticationSession hoặc Custom Tabs, Code + PKCE; app gửi `code` và `code_verifier` cho `auth.ExchangeNativeCode` | Private-use scheme `com.hoandat.chat:/auth/callback` |
| Desktop | `chat-desktop`, public, native | Trình duyệt mặc định của hệ thống, Code + PKCE, đổi code như mobile | Loopback `http://127.0.0.1:<cổng bất kỳ>/auth/callback` |

- Web đăng nhập qua các route HTTP `/auth/login`, `/auth/callback`, `/auth/logout`, `/auth/backchannel-logout`, không qua RPC. `state`, `nonce` và `code_verifier` lưu tạm phía server, dùng một lần, sống 10 phút.
- Native không bao giờ mở trang IdP trong WebView của app. Mobile chỉ nhận callback khi đang có một lần đăng nhập chờ với `state` khớp. Desktop mở listener loopback cho đúng một callback, kiểm `state`, đóng ngay khi nhận hoặc sau 10 phút.
- `ExchangeNativeCode` chỉ chấp nhận `redirect_uri` đúng mẫu của client tương ứng.
- Token của IdP chỉ nằm ở server, mã hoá cột, không bao giờ xuống client và không bao giờ vào log.

### Phiên chat

- Server cấp phiên chat riêng: token opaque 256 bit, chỉ lưu hash, so sánh constant-time. RPC và WebSocket chỉ kiểm phiên chat, không gọi IdP.
- Web: cookie `__Host-`, `HttpOnly`, `Secure`, `SameSite=Strict`. Mọi RPC thay đổi trạng thái và handshake WebSocket kiểm `Origin` theo allowlist của tenant. JavaScript của app không giữ token.
- Native: WebView giữ origin cục bộ của nó (`https://localhost` trên Android, `capacitor://localhost` trên iOS, origin `tauri://` hoặc `http://tauri.localhost` trên desktop), không dùng host của tenant. Server chỉ nhận các origin này cho request xác thực bằng token phiên trong header hoặc frame đầu của WebSocket, không bao giờ cho request dựa vào cookie. Vì vậy một bản app dùng được cho mọi tenant mà không chia sẻ cookie với web.
- Native: token phiên lưu trong Keychain/Keystore (Capacitor) hoặc OS keyring (Tauri), không lưu trong storage của WebView.
- Thời hạn:
  - Web theo grant IdP gắn với phiên trình duyệt: trượt 30 ngày, trần 90 ngày.
  - Native theo grant của từng thiết bị: trượt 30 ngày, không có trần. Refresh token cấp theo chính sách client của IdP, không cần `offline_access`, và không chết khi người dùng đăng xuất IdP trên trình duyệt. Mỗi lần đăng nhập trên máy, IdP hiện trang duyệt first-party.

### Phiên chết theo grant IdP

- Back-channel logout (chỉ web): server xác minh logout token bằng JWKS của tenant với `iss` của tenant, `aud` là `chat-web`, thuật toán ES256, `typ: logout+jwt`, tuổi tối đa 2 phút, có claim `events` của back-channel logout và không có `nonce`; bỏ token trùng theo `jti`. Hợp lệ thì thu hồi mọi phiên gắn `sid` đó (không có `sid` thì theo `sub`) và trả 200; token sai trả 400.
- Kiểm grant bằng refresh: server refresh token IdP khi client kết nối lại WebSocket mà lần kiểm trước đã quá 1 giờ (chạy nền, không chặn handshake), và bằng job nền mỗi 24 giờ.
- Refresh chạy dưới mutex theo phiên; token mới được lưu trước khi nhả khoá.
- IdP trả `invalid_grant` thì thu hồi phiên. Lỗi mạng hoặc 5xx từ IdP không thu hồi phiên, chỉ thử lại có backoff.
- Thu hồi phiên ghi `session_revoked` vào outbox ([ADR 0003](./0003-outbox.md)); gateway đóng socket của phiên đó trong ≤ 1 s, client xoá DB local, media cache và token rồi quay về màn hình đăng nhập.
- Khi backend chạy chung server với IdP, token endpoint được gọi thẳng qua loopback (`http://127.0.0.1:<cổng IdP>` với `Host: auth.<d>`) để dùng hạn mức riêng của IdP cho request loopback. Discovery và JWKS lấy qua API nội bộ, xem [ADR 0010](./0010-tenants-by-domain.md).

### Đăng xuất và thao tác nhạy cảm

- Đăng xuất xoá phiên chat và thu hồi refresh token ở `revocation_endpoint`. Web đăng xuất qua route HTTP `/auth/logout`: server trả 302 tới `end_session_endpoint` với `id_token_hint`, nên ID token không bao giờ tới JavaScript; RPC `SignOut` (dùng cho native) không trả URL nào.
- Cấp lại token bot, xoá tài khoản chat và thu hồi mọi phiên khác cần lần đăng nhập IdP trong 10 phút gần nhất: server gửi `prompt=login` và `max_age=600`, rồi kiểm `auth_time`.
- Đăng nhập lại trên cùng trình duyệt (như bước trên) thay phiên cũ của trình duyệt đó: `/auth/login` là điều hướng cùng site nên đọc được cookie phiên `SameSite=Strict` và ghi hash của nó vào cookie đăng nhập đã niêm phong. Với `auth.hoandat.com` và `chat.hoandat.com` (cùng site `hoandat.com`) cookie phiên cũng tới được callback, nhưng IdP ở site khác thì không, nên hash vẫn đi trong cookie đăng nhập. Callback tạo phiên mới, gửi cookie mới cùng trang chuyển tiếp (đã flush) rồi mới thu hồi phiên cũ với lý do `SESSION_REVOKE_REASON_REPLACED`, trên context không bị huỷ khi trình duyệt ngắt. Client nhận lý do này thì giữ DB local và kết nối lại (cookie đã là phiên mới); trong 10 giây sau đó, một lỗi 401 (yêu cầu đã đi bằng cookie cũ) chỉ dẫn tới một lần hỏi lại `GetSelf` sau 1,5 giây, và chỉ xoá dữ liệu khi lần hỏi lại cũng 401. Refresh token của phiên cũ bị xoá khỏi DB; chỉ thu hồi ở IdP khi hai phiên không thể chung grant (khác người dùng, hoặc cả hai `sid` đều biết và khác nhau), vì IdP mở rộng grant của phiên trình duyệt ở mỗi lần đăng nhập và thu hồi refresh token có thể chấm dứt cả grant của phiên mới. Thiếu `sid` được coi là chung grant: IdP đăng ký `chat-web` với `backchannel_logout_session_required` nên ID token luôn có `sid`, thiếu nghĩa là phiên lưu trước khi có `sid`; thu hồi khi đó có thể đăng xuất phiên mới, còn token cũ đã bị xoá khỏi server này và hết hạn cùng phiên IdP.

## Lý do

- Phiên riêng giữ IdP khỏi đường nóng: IdP chậm hay sập chỉ chặn đăng nhập mới, phiên đang có vẫn gửi và nhận tin.
- Gắn phiên với grant giữ đúng hứa hẹn của hệ sinh thái: gỡ quyền ở `/account` là cắt được phiên chat.
- Cookie `__Host-` `HttpOnly` chặn script đọc token; `SameSite=Strict` cùng kiểm `Origin` chặn CSRF và chiếm WebSocket chéo site.
- Universal Links và App Links không dùng được vì domain của tenant chưa biết lúc build, nên mobile dùng private-use scheme theo RFC 8252. Desktop dùng loopback cổng bất kỳ cũng theo RFC 8252; IdP bỏ qua cổng của redirect loopback với client native.
- Grant theo thiết bị không trần cho native theo cùng cách với `tunelo-cli`, để điện thoại không bắt đăng nhập lại mỗi 90 ngày.
- Refresh token xoay vòng nên hai refresh song song cùng token làm IdP thu hồi grant; mutex là bắt buộc.
- Gọi `/token` qua loopback tránh hạn mức chung 60 request/phút của IdP, vốn sẽ chặn job kiểm grant cho nhiều phiên.

## Hệ quả

- Web bị thu hồi gần như tức thì nhờ back-channel logout. Native chỉ biết khi kiểm grant: tối đa khoảng 1 giờ khi đang dùng, hoặc ở lần chạy kế tiếp của job 24 giờ.
- Đăng xuất IdP trên trình duyệt không đăng xuất app native; người dùng thu hồi từng thiết bị ở `/account`.
- Client của chat được khai ở repo `auth-next` (`src/oidc/chat-clients.ts`); mọi thay đổi redirect, scope hay chính sách refresh phải làm ở đó trước.
- Khi IdP sập, người dùng mới và thiết bị mới không đăng nhập được, kèm thông báo rõ.

## Cách thay đổi

- IdP đọc redirect của `chat-mobile` từ biến môi trường `CHAT_MOBILE_REDIRECT_URI` (mặc định `com.hoandat.chat:/auth/callback`). Đổi scheme mobile chỉ cần đổi cấu hình ở cả hai phía và phát hành bản app mới cùng lúc; bản app cũ sẽ không đăng nhập được nữa.
- Đổi thời hạn phiên web không vượt được trần của grant IdP; đổi thời hạn native cần đổi chính sách client ở IdP.
- Khi backend chuyển khỏi server dùng chung, loopback tới `/token` và API nội bộ không còn; cần kênh có xác thực (WireGuard hoặc mTLS) hoặc chuyển IdP cùng sang cụm. Đây là thay đổi ở cả hai repo.
- Đổi cookie phiên (tên, thuộc tính) làm mọi phiên web hiện có mất hiệu lực; người dùng đăng nhập lại qua IdP, không mất dữ liệu.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
