# chat-next

Ứng dụng chat của hệ sinh thái hoandat: web-first (React 19), đóng gói iOS/Android bằng Capacitor, desktop dùng bản web cài dạng PWA (không có app desktop native), backend Go. Người dùng đăng nhập bằng tài khoản hoandat qua IdP [`auth-next`](https://github.com/achoo254/auth-next); app chạy ở `chat.<domain>`, domain cấu hình bằng `TENANT_DOMAIN` (mặc định `hoandat.com`). Tên sản phẩm cấu hình ở `brand.config.json`; "chat-next" chỉ là tên repo.

Plan và quyết định: [`plans/dattqh/261013-0448-chat-platform-v1/plan.md`](plans/dattqh/261013-0448-chat-platform-v1/plan.md). Kiến trúc: [`docs/README.md`](docs/README.md) và các ADR trong `docs/adr/`.

## Bắt đầu

Yêu cầu: Node ≥ 22.18 (chạy thẳng file `.ts`), pnpm 11 (qua corepack), Go 1.26.

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test
cd server && go vet ./... && go test -race ./...
```

| Lệnh | Việc |
|---|---|
| `pnpm lint` | ESLint (`--max-warnings=0`) và `pnpm check:brand` (CLI `check-brand` của `@shared-next/brand`: không có tên sản phẩm viết cứng, không có chuỗi `chat-inet`) |
| `pnpm typecheck` / `pnpm test` | TypeScript và Vitest cho mọi package |
| `pnpm proto:lint` / `pnpm proto:gen` | `buf lint` / sinh code Go (`server/gen`) và TS (`packages/proto-ts/src/gen`) từ `proto/` |
| `pnpm proto:breaking` | So contract với nhánh `main` |
| `pnpm --filter @app/web dev` | Web app ở `http://localhost:5173`, proxy `/rpc` và `/auth` tới server `127.0.0.1:4600` |
| `pnpm e2e [lọc]` | E2E nhiều người dùng trên máy dev (không cần Docker): `server/cmd/e2e-stack` dựng Postgres tạm, IdP giả cho chọn tài khoản An, Bình, Chi, Dũng và API thật; Vite ở 5173; Playwright mở mỗi người một trình duyệt và chạy `apps/web/test/e2e/*.e2e.ts`. DB mới mỗi lần chạy; bước lỗi lưu ảnh chụp mỗi người vào `$TMPDIR/chat-e2e-shots`. `POST http://127.0.0.1:4600/e2e/realtime?state=down` (hoặc `up`) cắt mọi WebSocket và từ chối kết nối mới (hoặc mở lại), để thử trạng thái mất kết nối |
| `pnpm e2e --serve` | Chỉ dựng môi trường đó và giữ chạy, để tự chat với chính mình bằng nhiều profile trình duyệt (Ctrl+C để dừng) |
| `pnpm store:screenshots` | Ảnh App Store (6.9", 6.5") và Google Play của web app thật trên stack e2e (dữ liệu giả, tài khoản thử) vào `docs/store/screenshots/`; script `apps/web/test/e2e/store-screenshots.ts`, hồ sơ store ở `docs/store/listing.md` |
| `pnpm brand:gen` | Kiểm `brand.config.json` theo schema của `@shared-next/brand`, sinh manifest web, Capacitor và icon PNG/ICO (favicon, Apple touch, manifest 192/512, maskable) từ `brand/icon.svg`, `brand/icon-maskable.svg` vào `brand/generated/` (dùng Chromium của Playwright), bản sao tên cho server Go (`server/internal/brand/brand.json`), icon và màn khởi động của app iOS/Android (`apps/mobile`) cùng feature graphic của Google Play (`docs/store/play/`). Script `apps/web/scripts/brand-gen.ts`; tùy chọn của chat ở `apps/web/brand-files.ts`. Chạy lại sau khi sửa brand hoặc logo |
| `pnpm build:packages` | Build `dist/` (JS và `.d.ts`) của hai gói npm: `@achoo254/chat-client` (build trước `dist/` của bốn gói nội bộ `proto-ts`, `platform`, `core`, `platform-web`, rồi `packages/chat-client/scripts/assemble-dist.ts` gộp vào một `dist/` và đổi import giữa chúng thành đường dẫn tương đối) và `@achoo254/chat-bot-sdk`. Phát hành: đẩy tag `chat-client-vX.Y.Z` hoặc `chat-bot-sdk-vX.Y.Z` khớp version, trên commit của `main`; [`sdk-publish.yml`](.github/workflows/sdk-publish.yml) publish qua trusted publishing |
| `pnpm mobile:build-web` / `pnpm mobile:sync` | Build web app ở chế độ native (`VITE_NATIVE=true`) vào `apps/mobile/www`, rồi `cap sync` cho iOS và Android ([`docs/mobile-app.md`](docs/mobile-app.md)) |

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `apps/web` | Web app React 19 + Vite, gọi server qua Connect RPC (`/rpc`) |
| `apps/mobile` | Vỏ Capacitor 8 cho iOS (SPM) và Android, bọc bản build native của `apps/web` ([`docs/mobile-app.md`](docs/mobile-app.md)) |
| `proto/app/v1/` | Contract client ↔ server, mỗi domain một file |
| `packages/core`, `packages/platform`, `packages/platform-web`, `packages/proto-ts` | Lõi client (đồng bộ, outbox, SQLite cục bộ, realtime), giao diện nền tảng, nền tảng trình duyệt (worker SQLite wasm trên OPFS) và mã TS sinh từ proto. Gói workspace nội bộ (`private`), `apps/web` và `apps/mobile` import thẳng `src/` |
| `packages/chat-client` | Gói npm công khai `@achoo254/chat-client`: gộp bốn gói trên vào một `dist/` (subpath `.` cho `createWebChat`, `./worker`, `./core`, `./platform`, `./proto/*`), chỉ phụ thuộc thư viện bên thứ ba. Không có backend mặc định: web phải cùng origin với server chat, xem [README](packages/chat-client/README.md) |
| `sdk/ts` | Bot SDK cho Node, phát hành là `@achoo254/chat-bot-sdk` (`baseUrl` bắt buộc). `sdk/go`, `sdk/python` không phát hành |
| `brand/generated` | File sinh từ brand (`pnpm brand:gen`), không sửa tay. Mã thương hiệu (schema, kiểm config, sinh manifest/icon, `check-brand`) nằm ở gói dùng chung [`@shared-next/brand`](https://github.com/achoo254/shared-next), cài từ tag git trong `package.json` |
| `server/` | Go module: `cmd/server` (một binary chạy theo `-role`), `internal/` |
| `spec/` | Đặc tả và test vector dùng chung TS/Go (`vi-fold`, `entities`) |
| `deploy/dev/` | Docker Compose cho dev: Postgres primary + standby đồng bộ, Redis, Meilisearch, MinIO, IdP local |
| `infra/chat/` | Script production: deploy, kích hoạt/rollback release, setup server, chứng chỉ, nginx, pm2, backup ([`docs/deployment-guide.md`](docs/deployment-guide.md)) |

## Môi trường dev

```bash
cp deploy/dev/.env.example deploy/dev/.env        # điền secret ngẫu nhiên
cp deploy/dev/idp.env.example deploy/dev/idp.env  # secret của IdP local
docker compose -f deploy/dev/docker-compose.yml --env-file deploy/dev/.env up
```

IdP được build từ checkout `auth-next` nằm cạnh repo này (`../auth-next`, khai trong `deploy/dev/docker-compose.yml`); cần tạo khoá ký một lần ở đó bằng `pnpm generate-key`. Mọi cổng chỉ bind `127.0.0.1`. Không commit file `.env` hay `*.env`.

## MCP cho công cụ AI

Thêm `https://chat.hoandat.com/mcp` vào công cụ AI (Claude Code, …) làm MCP server, rồi duyệt quyền ở trang cấp quyền của IdP. Tool đọc và gửi tin nhắn, quản lý bot và webhook với đúng quyền của tài khoản trong app; nhóm `bots:admin` (webhook, token, xoá bot) cần quyền riêng và xác nhận hai bước. Quyết định và danh sách tool: [ADR 0012](docs/adr/0012-mcp-endpoint.md); mã ở `server/internal/chatmcp/`.

## Production

`https://chat.hoandat.com` trên server dùng chung `<SERVER_65_IP>`. Deploy và vận hành theo [`docs/deployment-guide.md`](docs/deployment-guide.md); danh mục hạ tầng đã triển khai ở [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md) và skill `chat-ops-prod` (`.claude/skills/chat-ops-prod/`).
