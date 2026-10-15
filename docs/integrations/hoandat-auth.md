# Tích hợp với IdP `hoandat-auth`

App chat đăng nhập chỉ qua IdP của hệ sinh thái hoandat. Quyết định nằm ở [ADR 0006](../adr/0006-sign-in-and-chat-sessions.md) (đăng nhập và phiên) và [ADR 0010](../adr/0010-tenants-by-domain.md) (tenant). Hợp đồng chi tiết phía IdP là `hoandat-auth/docs/integration-guide.md`; trang này chỉ ghi phần riêng của app chat.

## Client ở IdP

| `client_id` | Loại | Redirect |
|---|---|---|
| `chat-web` | confidential, Code + PKCE, refresh gắn phiên IdP | `https://chat.<domain>/auth/callback`; back-channel logout `https://chat.<domain>/auth/backchannel-logout` |
| `chat-mobile` | public, native, Code + PKCE | `CHAT_MOBILE_REDIRECT_URI` của IdP, mặc định `com.hoandat.chat:/auth/callback`; phải trùng `urlScheme` trong `brand.config.json` |
| `chat-desktop` | public, native, Code + PKCE | `http://127.0.0.1:<cổng bất kỳ>/auth/callback` |

Cả ba xin scope `openid profile email`, không có audience API: app chat tự cấp phiên của mình và chỉ đọc ID token và userinfo. Refresh token của `chat-mobile` và `chat-desktop` không chết khi người dùng đăng xuất trong trình duyệt và không có trần 90 ngày; mỗi máy là một grant thu hồi được ở `/account` của IdP.

## Cấu hình phía app chat

- Issuer của tenant chính: `primaryTenant.issuer` trong `brand.config.json`. Tenant khác: `https://auth.<domain>`, lấy discovery và JWKS qua API nội bộ của IdP, không qua DNS công khai.
- Secret của `chat-web`: tenant chính đọc từ secret store; tenant khác tự tính `base64url(HMAC-SHA256(<khoá app chat-web>, tenantId))`. Khoá app sinh trên server IdP bằng `node --env-file=.env dist/app-client-key.mjs chat-web <file>` và chỉ chép sang secret store của app chat.
- Backend chat chạy chung server với IdP ở giai đoạn đầu: API nội bộ gọi qua `127.0.0.1:4501` bằng Basic credentials vai `chat`; token endpoint gọi thẳng qua loopback để dùng hạn mức riêng.

## Trạng thái thay đổi phía IdP

Plan: `hoandat-auth/plans/dattqh/261014-1131-chat-app-integration/plan.md`.

- Đã làm và đang chạy ở production (`main` của `hoandat-auth`, commit `0c0020d`, `4a9ca7d`; đo 15/10/2026): ba client chat, refresh native không trần, secret suy theo tenant, `CHAT_MOBILE_REDIRECT_URI`. `.env` của IdP có `CHAT_WEB_URL`, `CHAT_WEB_CLIENT_SECRET`; env và cách kiểm client nằm ở `hoandat-auth/docs/deployment-guide.md` mục "Client của app chat".
- App chat ở trang `/apps` của IdP: chỉ ở tenant chính (`auth.hoandat.com/apps`), vì tenant khác chưa có host `chat.<domain>`.
- Chưa làm: host `chat.<domain>` theo tenant và bật chat ở `/admin` (khi có thì `/apps` của tenant đó mới hiện Chat), vai `chat` của API nội bộ, hạn mức `/token` cho request loopback, hiển thị máy chat ở `/account`, script tạo tenant thử cho dev.
