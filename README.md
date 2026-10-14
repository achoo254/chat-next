# chat-next

Ứng dụng chat của hệ sinh thái hoandat: web-first (React 19), đóng gói iOS/Android bằng Capacitor và desktop bằng Tauri v2, backend Go. Người dùng đăng nhập bằng tài khoản hoandat qua IdP [`hoandat-auth`](https://github.com/achoo254/hoandat-auth); mỗi domain (tenant) có `chat.<domain>` riêng. Tên sản phẩm cấu hình ở `brand.config.json`; "chat-next" chỉ là tên repo.

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
| `pnpm lint` | ESLint (`--max-warnings=0`) và `scripts/check-brand.mjs` (không có tên sản phẩm viết cứng) |
| `pnpm typecheck` / `pnpm test` | TypeScript và Vitest cho mọi package |
| `pnpm proto:lint` / `pnpm proto:gen` | `buf lint` / sinh code Go (`server/gen`) và TS (`packages/proto-ts/src/gen`) từ `proto/` |
| `pnpm proto:breaking` | So contract với nhánh `main` |
| `pnpm brand:gen` | Sinh manifest web, Capacitor, Tauri từ `brand.config.json` vào `packages/brand/generated/` |

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `proto/app/v1/` | Contract client ↔ server, mỗi domain một file |
| `packages/core` | Fold tiếng Việt, ID, entities (dùng chung cho mọi client) |
| `packages/brand` | Đọc và kiểm `brand.config.json`, host theo tenant, sinh manifest |
| `packages/proto-ts` | Code TS sinh từ proto |
| `server/` | Go module: `cmd/server` (một binary chạy theo `-role`), `internal/` |
| `spec/` | Đặc tả và test vector dùng chung TS/Go (`vi-fold`, `entities`) |
| `deploy/dev/` | Docker Compose cho dev: Postgres primary + standby đồng bộ, Redis, Meilisearch, MinIO, IdP local |

## Môi trường dev

```bash
cp deploy/dev/.env.example deploy/dev/.env        # điền secret ngẫu nhiên
cp deploy/dev/idp.env.example deploy/dev/idp.env  # secret của IdP local
docker compose -f deploy/dev/docker-compose.yml --env-file deploy/dev/.env up
```

IdP được build từ checkout `hoandat-auth` nằm cạnh repo này (`../hoandat-auth`); cần tạo khoá ký một lần ở đó bằng `pnpm generate-key`. Mọi cổng chỉ bind `127.0.0.1`. Không commit file `.env` hay `*.env`.
