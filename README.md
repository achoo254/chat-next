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
| [`packages/`](packages/) | Lõi client (đồng bộ, outbox, SQLite cục bộ, realtime) và lớp nền tảng; gói nội bộ, riêng `chat-client` đóng gói thành SDK |
| [`sdk/`](sdk/) | Bot SDK; bắt đầu viết bot ở [`docs/bot-api/README.md`](docs/bot-api/README.md) |
| [`server/`](server/) | Go module: một binary chạy theo role |
| [`spec/`](spec/) | Đặc tả và test vector dùng chung TS/Go |
| [`infra/chat/`](infra/chat/) | Script production: deploy, release, nginx, pm2, backup |

## Gói SDK

Hai gói công khai: `@achoo254/chat-client` ([`packages/chat-client/README.md`](packages/chat-client/README.md); không có backend mặc định, web phải cùng origin với server chat) và `@achoo254/chat-bot-sdk` ([`sdk/ts/README.md`](sdk/ts/README.md)). Hai gói không phát hành lên npm (chốt 27/10/2026): ai cần thì build từ repo này và cài file `.tgz` do `pnpm pack` tạo, cách làm ở README của từng gói.

## MCP cho công cụ AI

Thêm `https://chat.hoandat.com/mcp` vào công cụ AI (Claude Code, …) làm MCP server rồi duyệt quyền ở trang consent của IdP; cấu hình mẫu cho từng công cụ có ở Cài đặt › Kết nối AI (MCP) trong app. Tool làm việc với đúng quyền của tài khoản trong app; quản trị bot (`bots:admin`) cần scope riêng và xác nhận hai bước; tạo, xoay vòng URL hay xoá webhook đến cũng xác nhận hai bước. Quyết định: [ADR 0012](docs/adr/0012-mcp-endpoint.md); mã ở [`server/internal/chatmcp/`](server/internal/chatmcp/).

## AI Agent (điều khiển AI lập trình trên máy riêng)

Từ web/PWA (mục AI Agent cạnh các thư mục chat, đường dẫn `/ai`; `/machines/*` cũ tự chuyển sang), người dùng chat với Claude Code đang chạy trên máy của chính họ: cột trái là phiên của mọi máy nhóm theo máy rồi thư mục, bảng "Cần bạn" duyệt ngay được, trả lời dạng markdown, thẻ tool, diff và panel "Thay đổi" của phiên, duyệt quyền (phím 1/2/3/Esc, từ chối kèm lời nhắn), lưu trữ hay xoá phiên (xoá chuyển bản ghi và tệp đính kèm của phiên vào Thùng rác trên máy, từ `tunelo` 2.0.6), câu hỏi, dừng, lệnh `/` và skill của máy, ảnh và tệp đính kèm (dán, kéo thả, nút đính kèm; ảnh tới Claude dạng ảnh, tệp khác lưu vào `.tunelo-attachments/` trong thư mục của phiên; đi qua kênh mã hoá đầu cuối, từ `tunelo` 2.0.5), thanh trạng thái (thư mục, nhánh, model, effort, tài khoản Claude đang đăng nhập, ngữ cảnh, hạn mức 5 giờ / tuần, chế độ quyền). Máy chạy tiến trình nền `tunelo` (`apps/agent`; tên cũ `hda`, trước nữa `chat-agent`), cài bằng một lệnh lấy ở AI Agent › Máy › Thêm máy: đăng nhập tài khoản một lần cho tunnel, Chat và Localman, máy tự vào danh sách, không cần mã cài. `tunelo` cũng là CLI Tunelo (`tunelo http 3000`, …; gói npm 1.x đã nghỉ). Lệnh, cập nhật, gỡ: [`apps/agent/README.md`](apps/agent/README.md). `tunelo pair` ghép thêm thiết bị bằng mã 6 số, `tunelo status`, `tunelo logs -f` (xem log liên tục), `tunelo update`. `tunelo` tự chạy nền lúc đăng nhập; `tunelo start` / `tunelo stop` bật, tắt bản chạy nền (đóng terminal không làm tắt), còn `tunelo run` chỉ chạy trong terminal để gỡ lỗi và từ chối chạy khi đã có bản đang chạy (kể cả `hda` cũ). Trên macOS bản chạy nền là LaunchAgent trong phiên đăng nhập GUI: Mac không ai đăng nhập (máy headless tắt tự đăng nhập) không khởi động được nó, và Keychain cũng cần phiên đó. Nội dung mã hoá đầu cuối giữa thiết bị và máy qua relay Tunelo; server chỉ giữ danh bạ máy và gửi push không chứa nội dung. Phiên bắt đầu theo cấu hình Claude trên máy; từ thiết bị đổi được model, effort và chế độ quyền, riêng `bypassPermissions` chỉ chọn lại được khi máy tự bật sẵn. Một máy có nhiều tài khoản Claude (profile), thêm từ điện thoại bằng cách dán code đăng nhập; Localman gửi được request tới `localhost:<cổng>` của máy (chỉ chủ máy, trừ danh sách cổng chặn, tắt bằng `tunelo config local-forward off` hoặc công tắc trên trang máy). Thiết kế: [ADR 0013](docs/adr/0013-remote-machines.md), [ADR 0014](docs/adr/0014-tunelo-machine-agent.md); giao thức `proto/remote/v1`, mã hoá `packages/remote-protocol`, phát hành bằng tag `tunelo-v*` ([`agent-release.yml`](.github/workflows/agent-release.yml)) rồi `node apps/agent/scripts/pin-release.ts <version> SHA256SUMS` để script cài trỏ bản mới.

Phiên claude do `tunelo` mở có sẵn MCP `tunelo`, với các tool sau:
- tunnel;
- Chat: đọc và gửi tin;
- Localman: đọc collection và lịch sử, gửi request (kể cả tới `localhost` trên máy của chính người dùng).

Token do tiến trình nền gắn, claude không bao giờ thấy, và mọi chuỗi trả về đều được che token. Gửi tin hay gửi request luôn hiện thẻ duyệt trên thiết bị, ghi người nhận hoặc URL. Tiến trình nền chỉ chạy lệnh gửi sau khi chính thẻ đó được duyệt, nên Bash trong phiên cũng không gửi thay được. Client MCP ngoài phiên của tunelo (`claude mcp add tunelo -- tunelo mcp`) mặc định chỉ được đọc; chủ máy bật quyền ghi cho chúng bằng `tunelo config mcp-local-writes on`, lệnh chỉ chạy trong terminal và hỏi xác nhận. Ngoại lệ là khi máy tự đặt phiên ở `bypassPermissions`: khi đó nội dung độc trong tin nhắn hay response có thể dụ claude gửi đi mà không ai duyệt (prompt injection). Chi tiết, các đường còn hở và cách tắt: ADR 0013, mục "MCP của tunelo trong phiên claude".

Máy còn chạy `hda` 0.2.x chuyển sang `tunelo` bằng `hda update`: bản cầu nối `agent-v0.3.0` (không bao giờ xoá) chứa `tunelo` 2.0.0 dưới tên `hda-*`, và khi dịch vụ cũ khởi động lại nó tự chuyển ([`migrate-from-hda.ts`](apps/agent/src/migrate-from-hda.ts)): giữ máy, khoá máy, thiết bị đã ghép, subdomain, journal; thư mục và khoá Keychain/DPAPI cũ để nguyên. `hda` 0.2.x chỉ đọc 20 bản phát hành mới nhất, nên khi `agent-v0.3.0` trôi khỏi trang đầu thì chạy lại script cài, không cần mã cài: `curl -fsSL https://chat.hoandat.com/agent/install.sh | sh` (macOS) hoặc `& ([scriptblock]::Create((irm https://chat.hoandat.com/agent/install.ps1)))` (Windows); script thấy `hda` thì chạy `tunelo migrate-from-hda`, và nhắc gỡ gói npm `tunelo` 1.x nếu còn. Trang thêm máy cũng hiện lệnh này.

## Production

Deploy và vận hành: [`docs/deployment-guide.md`](docs/deployment-guide.md); hạ tầng đã triển khai: [`docs/infrastructure-inventory.md`](docs/infrastructure-inventory.md); skill vận hành cho agent: [`.claude/skills/chat-ops-prod/`](.claude/skills/chat-ops-prod/).
