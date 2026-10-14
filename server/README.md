# Backend Go

Một binary `server`, chạy theo `-role`. Quyết định: [ADR 0006](../docs/adr/0006-sign-in-and-chat-sessions.md) (đăng nhập, phiên), [ADR 0010](../docs/adr/0010-tenants-by-domain.md) (tenant), [ADR 0001](../docs/adr/0001-id-scheme.md) (id).

## Vai trò

| Lệnh | Việc |
|---|---|
| `server -role migrate [-env-file F]` | Áp các migration nhúng (`migrations/*.sql`, goose, có advisory lock) rồi thoát. Chỉ cần `DATABASE_URL`. |
| `server -role api [-env-file F]` | HTTP server: `/healthz`, `/auth/*`, Connect RPC dưới `/rpc/`. Dừng êm khi nhận SIGINT/SIGTERM. |
| `gateway`, `worker`, `botapi`, `webhook` | Chưa có, thoát mã 1. |

`-env-file` đọc dòng `KEY=VALUE` (bỏ dòng trống và dòng `#`, giá trị có thể nằm trong `'…'` hoặc `"…"`), không ghi đè biến đã có trong môi trường. Cấu hình thiếu hoặc sai thì thoát mã 1 và nêu tên biến, không in giá trị.

## Biến môi trường (`-role api`)

| Biến | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `CHAT_ENV` | có | | `production` hoặc `development` |
| `CHAT_LISTEN_ADDR` | | `127.0.0.1:4600` | `host:port` |
| `CHAT_PUBLIC_URL` | có | | Origin công khai, ví dụ `https://chat.hoandat.com`; production bắt buộc https. Redirect OIDC là `<CHAT_PUBLIC_URL>/auth/callback`, post-logout là `<CHAT_PUBLIC_URL>/`. |
| `DATABASE_URL` | có | | URL PostgreSQL 16 (pgx) |
| `OIDC_ISSUER` | có | | Ví dụ `https://auth.hoandat.com`; production bắt buộc https. Mọi endpoint lấy từ discovery. |
| `OIDC_CLIENT_ID` | có | | `chat-web` |
| `OIDC_CLIENT_SECRET` | có | | Secret `client_secret_basic` |
| `SESSION_KEY` | có | | Base64 (thường hoặc URL-safe), ≥ 32 byte. Khoá gốc AES-256-GCM cho refresh/ID token của IdP trong DB và cookie đăng nhập. Đổi khoá làm mọi phiên đang có bị thu hồi ở lần kiểm grant kế tiếp. |
| `TENANT_ID` | | `primary` | |
| `TENANT_DOMAIN` | | `hoandat.com` | Cũng là tên tenant trả trong `GetAuthConfig` |
| `DEV_ORIGINS` | | | Danh sách origin cách nhau bằng dấu phẩy, chỉ dùng khi `CHAT_ENV=development` |

Server nghe trên loopback sau nginx: `X-Real-IP` chỉ được tin khi peer là loopback, nên nginx cần `proxy_set_header X-Real-IP $remote_addr;`.

## Route HTTP

| Route | Việc |
|---|---|
| `GET /healthz` | `{"status":"ok","db":"connected"}`; 503 khi DB không trả lời |
| `GET /auth/login[?locale=en\|vi\|zh-CN][&prompt=create]` | Đặt cookie `__Host-chat_login` (SameSite=Lax, 10 phút, niêm phong state/nonce/PKCE verifier/locale) rồi 302 tới IdP |
| `GET /auth/callback` | Kiểm state, đổi code, xác minh ID token (iss, aud, ES256, nonce), tạo/cập nhật user, tạo phiên, đặt cookie `__Host-chat_session` (HttpOnly, Secure, SameSite=Strict, 90 ngày) và trả trang trung gian 200 `<meta http-equiv="refresh" content="0;url=/">`. Lỗi trả trang có link "Thử lại": 400 (state, nonce, code), 503 (IdP chưa sẵn sàng), 500 (lỗi nội bộ). |
| `POST /auth/logout` | Cần `Origin` trong allowlist (403 nếu không). Thu hồi phiên và refresh token ở IdP, xoá cookie, 303 tới `end_session_endpoint` với `id_token_hint`, `client_id`, `post_logout_redirect_uri`; không có phiên thì 303 về `/`. |
| `POST /auth/backchannel-logout` | Form `logout_token`; 200 khi đã xử lý, 400 khi token sai hoặc phát lại `jti`, 503 khi IdP chưa discovery |
| `/rpc/app.v1.<Service>/<Method>` | Connect: `AuthService`, `UsersService`, `ConfigService` |

Mọi RPC cần `Origin` trong allowlist (`CHAT_PUBLIC_URL`, cộng `DEV_ORIGINS` khi development), nếu không trả `permission_denied`. Trừ `GetAuthConfig`, `ExchangeNativeCode` và `GetAppConfig`, mọi RPC cần cookie phiên, nếu không trả `unauthenticated`. `ExchangeNativeCode` và các RPC chưa làm của `UsersService` trả `unimplemented`.

## Đăng xuất web

Web đăng xuất bằng một form `POST /auth/logout` (điều hướng cấp cao nhất, để trình duyệt theo redirect 303 tới IdP; `fetch` không theo được redirect khác origin). Nếu muốn gọi `AuthService.SignOut` trước (ví dụ để dọn dữ liệu local), `SignOut` chỉ thu hồi phiên và refresh token mà **không** xoá cookie; `/auth/logout` sau đó vẫn dùng cookie đó một lần để lấy ID token làm `id_token_hint`, rồi xoá cookie. ID token không bao giờ tới JavaScript.

## Phiên và kiểm grant

- Token phiên: 32 byte ngẫu nhiên, base64url trong cookie; DB chỉ lưu SHA-256. Phiên trượt 30 ngày, trần 90 ngày; `last_seen_at` ghi tối đa mỗi phút.
- Khi một phiên được dùng mà lần kiểm grant trước đã quá 1 giờ, server refresh token IdP ở nền (không chặn request), dưới khoá hàng `FOR UPDATE SKIP LOCKED`, nên hai request hay hai process không bao giờ gửi cùng một refresh token. `invalid_grant` thu hồi phiên; lỗi mạng hoặc 5xx giữ phiên và thử lại sau 5 phút. Refresh cập nhật email theo IdP.
- IdP sập lúc khởi động: server vẫn chạy và phục vụ phiên đang có; discovery thử lại với backoff tới 1 phút, trong lúc đó đăng nhập trả 503.

## Phát triển

```bash
go test -race ./...    # test DB dùng embedded-postgres (PG 16), không cần Docker
golangci-lint run ./...
```

Lần chạy đầu tải binary PostgreSQL vào `~/.embedded-postgres-go` và giải nén một lần; không tải được thì test cần DB tự skip kèm lý do.
