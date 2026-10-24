# Tích hợp với IdP `auth-next`

App chat đăng nhập chỉ qua IdP của hệ sinh thái hoandat. Quyết định nằm ở [ADR 0006](../adr/0006-sign-in-and-chat-sessions.md) (đăng nhập và phiên) và [ADR 0010](../adr/0010-tenants-by-domain.md) (tenant; bị thay thế 24/10/2026 bởi [ADR 0013 Đơn tenant](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md) của `auth-next`: chỉ còn `hoandat.com`). Hợp đồng chi tiết phía IdP là `auth-next/docs/integration-guide.md`; trang này chỉ ghi phần riêng của app chat.

## Client ở IdP

| `client_id` | Loại | Redirect |
|---|---|---|
| `chat-web` | confidential, Code + PKCE, refresh gắn phiên IdP | `https://chat.<domain>/auth/callback`; back-channel logout `https://chat.<domain>/auth/backchannel-logout` |
| `chat-mobile` | public, native, Code + PKCE | `CHAT_MOBILE_REDIRECT_URI` của IdP, mặc định `com.hoandat.chat:/auth/callback`; phải trùng `urlScheme` trong `brand.config.json` |

Không có client desktop: trên máy tính, Chat chạy bản web cài dạng PWA và đăng nhập bằng `chat-web` (huỷ 20/10/2026: desktop = PWA; `chat-desktop` đã gỡ khỏi IdP).

Cả hai xin scope `openid profile email`, không có audience API: app chat tự cấp phiên của mình và chỉ đọc ID token và userinfo. Refresh token của `chat-mobile` không chết khi người dùng đăng xuất trong trình duyệt và không có trần 90 ngày; mỗi máy là một grant thu hồi được ở `/account` của IdP.

## Cấu hình phía app chat

- Issuer: `OIDC_ISSUER` của server (`https://auth.hoandat.com`), cùng giá trị với `primaryTenant.issuer` trong `brand.config.json` mà web app dùng. Domain trả cho client (`tenant_name` của `GetAuthConfig`) là `TENANT_DOMAIN`, mặc định `hoandat.com`.
- Secret của `chat-web`: `OIDC_CLIENT_SECRET`, cùng giá trị với `CHAT_WEB_CLIENT_SECRET` trong `.env` của IdP. App chat không gọi API nội bộ của IdP.

## Trạng thái thay đổi phía IdP

Plan: `auth-next/plans/dattqh/261014-1131-chat-app-integration/plan.md`.

- Đã làm và đang chạy ở production (`main` của `auth-next`, commit `0c0020d`, `4a9ca7d`; đo 15/10/2026): ba client chat (20/10/2026: gỡ `chat-desktop` trong code IdP, chờ deploy), refresh native không trần, `CHAT_MOBILE_REDIRECT_URI`. `.env` của IdP có `CHAT_WEB_URL`, `CHAT_WEB_CLIENT_SECRET`; env và cách kiểm client nằm ở `auth-next/docs/deployment-guide.md` mục "Client của app chat".
- App chat ở trang `/apps` của IdP (`auth.hoandat.com/apps`).
- Chưa làm: hiển thị máy chat ở `/account`.
