# chat-next

Ứng dụng chat của hệ sinh thái hoandat, chạy ở `https://chat.hoandat.com`. Người dùng đăng nhập bằng tài khoản hoandat qua IdP [`auth-next`](https://github.com/achoo254/auth-next); app không có tài khoản hay mật khẩu riêng. "chat-next" chỉ là tên repo: tên sản phẩm, màu, scheme và domain lấy từ [`brand.config.json`](brand.config.json) (ADR 0008).

Mọi quyết định kiến trúc, đặc tả, quyền riêng tư và vận hành được chỉ đường ở [`docs/README.md`](docs/README.md). README này chỉ giữ phần định hướng.

## Định hướng sản phẩm

- **Web-first.** Web app React là bản chính; iOS/Android là vỏ Capacitor bọc bản build native của web ([`docs/mobile-app.md`](docs/mobile-app.md)); desktop dùng bản web cài dạng PWA, không có app desktop native. Một codebase client, không duy trì ba app.
- **Đăng nhập chỉ qua `auth-next`.** Chat tự cấp phiên của mình nhưng phiên chết theo grant ở IdP (ADR 0006); app native xác thực bằng bearer (ADR 0011).
- **Đơn tenant.** Chỉ phục vụ `hoandat.com`; cột `tenant_id` vẫn giữ, luôn `primary`. ADR tenant theo domain của repo (0010) đã bị thay bằng [ADR 0013 của `auth-next`](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md).
- **Contract client ↔ server viết bằng proto** ([`proto/`](proto/)), sinh mã cho cả Go và TS; thay đổi phá vỡ contract bị chặn bằng `pnpm proto:breaking`.
- **Không gửi email.** Hệ sinh thái không có kênh mail; thông báo đi qua push và trong app.

## Bắt đầu

Yêu cầu: Node và pnpm theo `engines`/`packageManager` trong [`package.json`](package.json), Go theo [`server/go.mod`](server/go.mod).

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
cd server && go vet ./... && go test -race ./...
```

Danh sách lệnh ở `scripts` của [`package.json`](package.json); mỗi lệnh trỏ tới script có chú thích ở đầu file. Hai lệnh hay dùng khi phát triển:

- `pnpm e2e` chạy E2E nhiều người dùng trên máy dev, không cần Docker; `pnpm e2e --serve` chỉ dựng môi trường đó và giữ chạy để tự chat bằng nhiều profile trình duyệt. Cách dùng ở đầu [`apps/web/test/e2e/run.ts`](apps/web/test/e2e/run.ts).
- `pnpm brand:gen` sinh manifest, icon và tài nguyên app native từ brand; chạy lại sau khi sửa brand hoặc logo. File trong `brand/generated/` không sửa tay.

Môi trường dev đầy đủ (Postgres, Redis, Meilisearch, MinIO và IdP local) ở [`deploy/dev/docker-compose.yml`](deploy/dev/docker-compose.yml), env mẫu ở [`deploy/dev/.env.example`](deploy/dev/.env.example) và [`deploy/dev/idp.env.example`](deploy/dev/idp.env.example). IdP được build từ checkout `auth-next` nằm cạnh repo này; tạo khoá ký một lần ở đó bằng `pnpm generate-key`. Không commit file `.env` hay `*.env`.

Cấu hình server Go (biến môi trường, role của binary): [`server/README.md`](server/README.md).

## Đi đâu trong code

| Chỗ | Vai trò |
|---|---|
| [`apps/web/`](apps/web/) | Web app, gọi server qua Connect RPC |
| [`apps/mobile/`](apps/mobile/) | Vỏ Capacitor cho iOS và Android |
| [`proto/`](proto/) | Contract client ↔ server |
| [`packages/`](packages/) | Lõi client (đồng bộ, outbox, SQLite cục bộ, realtime) và lớp nền tảng; gói nội bộ, riêng `chat-client` phát hành npm |
| [`sdk/`](sdk/) | Bot SDK; bắt đầu viết bot ở [`docs/bot-api/README.md`](docs/bot-api/README.md) |
| [`server/`](server/) | Go module: một binary chạy theo role |
| [`spec/`](spec/) | Đặc tả và test vector dùng chung TS/Go |
| [`infra/chat/`](infra/chat/) | Script production: deploy, release, nginx, pm2, backup |

## Gói npm

Hai gói công khai: `@achoo254/chat-client` ([`packages/chat-client/README.md`](packages/chat-client/README.md); không có backend mặc định, web phải cùng origin với server chat) và `@achoo254/chat-bot-sdk` ([`sdk/ts/README.md`](sdk/ts/README.md)). Phát hành bằng cách đẩy tag `chat-client-vX.Y.Z` hoặc `chat-bot-sdk-vX.Y.Z` khớp version, trên commit của `main`; [`sdk-publish.yml`](.github/workflows/sdk-publish.yml) publish qua trusted publishing. Chưa gói nào lên npm vì tài khoản npm đang bị tạm khoá; lần publish đầu của mỗi gói do chủ tài khoản tự làm trên máy mình.

## MCP cho công cụ AI

Thêm `https://chat.hoandat.com/mcp` vào công cụ AI (Claude Code, …) làm MCP server rồi duyệt quyền ở trang consent của IdP. Tool làm việc với đúng quyền của tài khoản trong app; quản trị bot (`bots:admin`) cần scope riêng và xác nhận hai bước. Quyết định: [ADR 0012](docs/adr/0012-mcp-endpoint.md); mã ở [`server/internal/chatmcp/`](server/internal/chatmcp/).

## Production

Deploy và vận hành: [`docs/deployment-guide.md`](docs/deployment-guide.md); hạ tầng đã triển khai: [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md); skill vận hành cho agent: [`.claude/skills/chat-ops-prod/`](.claude/skills/chat-ops-prod/).
