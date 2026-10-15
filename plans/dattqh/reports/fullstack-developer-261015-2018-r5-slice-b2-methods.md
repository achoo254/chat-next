# R5 lát B2: đủ method Bot API (Phase 8)

Trạng thái: xong, chưa commit (theo yêu cầu). Mọi gate pass trên cây hiện tại (có cả thay đổi của phiên debugger chạy song song; tôi không sửa file của phiên đó).

## API mới (spec `spec/bot-api/openapi.yaml` 1.1.0, redocly: valid, 0 cảnh báo)

Mọi method gọi đúng đường của người trong lõi chat với bot là người làm, trên context `chat.AsBot(ctx, bot_id)`: lõi bỏ bucket theo user cho đúng bot đó, Bot API áp rate limit theo tầng; membership, quyền, consent, chặn giữ nguyên.

| Method | Ghi chú |
|---|---|
| `POST /messages:edit` | Chữ/caption + entities/parse_mode của tin của bot; `reply_markup` inline thay bàn phím, không gửi thì giữ. Không giới hạn thời gian sửa với bot (vẫn cần quyền gửi). Tính là send |
| `POST /messages:editMarkup` | Thay/gỡ bàn phím inline; không đặt `edit_date` |
| `POST /messages:delete` | 1–100 seq; tin của bot luôn, tin người khác khi admin (hoặc chat riêng); không xoá được tin nào thì 403 |
| `POST /messages:forward`, `:copy` | Nguồn phải là chat bot thấy; đích theo luật gửi; `random_ids`/`random_id` chống trùng |
| `POST /messages:react` | Một emoji, `""` để bỏ |
| `POST /messages:pin`, `:unpin` | Cần quyền ghim |
| `POST /messages:sendMedia`, `:sendAlbum` | multipart (≤ 50 MiB/request, ảnh ≤ 20 MiB) qua `media.UploadStream` mới (sniff loại, strip metadata, rendition, quota, dedupe theo hash) hoặc JSON `file_id` (ACL Phase 4). Kiểm quyền gửi trước khi lưu file. Không có gửi theo URL (tuỳ chọn, bỏ để không mở thêm đường fetch ra ngoài) |
| `GET /files/{file_id}` | File của tin bot thấy (`chat.FileAccess`), URL ký ngắn hạn như app (~1 giờ, gắn bot + tin) |
| `GET /chats/{id}/admins`, `GET /chats/{id}/members/{user_id}` | `ChatMember{user, status: owner/admin/member/left/banned, permissions}` |
| `POST /chats/{id}/members/{user_id}:ban/:unban/:restrict` | Như admin trong app |
| `PATCH /chats/{id}` | `title`, `about` |
| `POST /chats/{id}:leave` | Rời nhóm/kênh |
| `POST /chats/{id}/actions` | typing/upload_*/record_voice/cancel → frame typing realtime của bot (`gateway.Hub.BotTyping`); >1/giây mỗi chat thì gộp. Web chưa hiển thị typing (đã ghi trong spec và docs) |
| `GET /updates?allowed_updates=` | Bot poll cũng lưu được `allowed_updates` |

Update mới: `member_changed` (thành viên của chính bot: thêm, cả lúc nhóm được tạo cùng bot; rời/bị mời ra; lên/xuống admin; giới hạn; mặc định nhận; không bị xoá khi bot rời chat) và `reaction` (người thả/đổi/bỏ reaction trên tin của bot; opt-in, rỗng `allowed_updates` = mọi loại trừ `reaction`). `Media.file_id`, `Message.grouped_id` thêm vào wire.

Menu lệnh trong nhóm: RPC mới `BotsService.GetChatBotCommands` (proto additive, buf breaking pass) trả menu theo vai trò + `bot_count`; web composer của nhóm hiện nút menu khi có bot có lệnh, dòng có tên bot, chọn lệnh điền `/lệnh@username` khi nhóm có từ 2 bot, `/lệnh` khi một bot (mock `bots.html#commands` cập nhật trước). Lazy: startup JS vẫn 146.5 KB. Console thêm chip `member_changed`, `reaction` (mock `console.html` cập nhật).

Contract test: `server/internal/botapi/contract_test.go` kiểm mọi response (thành công và lỗi) qua harness theo schema OpenAPI của đúng operation + status (thư viện `santhosh-tekuri/jsonschema/v6` v6.0.3, thêm vào go.mod cùng `go.yaml.in/yaml/v3` từ indirect lên direct); status không có trong spec là lỗi. Chạy đủ gói đòi mọi operation của `paths` (28) đã trả 2xx và đủ 6 loại update. Nằm trong `go test ./...` nên CI có sẵn (thay cho `conformance/contract` + `pnpm conformance:contract` trong plan).

## Deploy notes

- Migration `0017_bot_update_kinds.sql` (expand-only: nới check `bot_updates.kind`; bản cũ đọc được mọi dòng). Chạy `-role migrate` trước khi đổi binary.
- Env: không có biến mới. Media phải bật thì upload/`GET /files` mới chạy (không bật: `400 bad_request` `media_disabled`).
- nginx: `/bot/` vẫn 1 MiB; thêm `location ^~ /bot/v1/messages:send` (sendMedia/sendAlbum) `client_max_body_size 51m`, `client_body_timeout 120s`, `proxy_send_timeout 120s` trong `infra/chat/nginx/chat.hoandat.com.conf`, ghi vào `docs/infrastructure-inventory.md`. **Đổi conf nginx nên cần deploy bằng root** (copy conf + `nginx -t` + reload). Chưa chạy `nginx -t` được vì máy này không có nginx. Không deploy conf thì upload > 1 MiB bị nginx trả 413 (HTML, không phải envelope); mọi method khác chạy bình thường.

## Gates

- `gofmt -l`: trống; `go vet ./...`: sạch; `golangci-lint run ./...`: 0 issues.
- `go test -race -count=1 -p 2 ./...`: mọi gói ok (gồm contract coverage của botapi).
- `pnpm lint`: 0; `pnpm typecheck`: sạch (lúc chạy giữa chừng có lỗi tạm ở `packages/core/src/sync/engine.ts` và `apps/web/test/service-worker.test.ts` của phiên debugger, lần chạy cuối sạch).
- vitest `--maxWorkers=2`: core 768/768, web 336/336.
- `pnpm perf`: startup JS 146.5 KB / 150, CSS 17.0 KB / 20, mọi budget đạt.
- `pnpm e2e`: 25/25 (bots.e2e.ts thêm kịch bản: bot sửa tin + bàn phím inline, upload ảnh multipart + `GET /files` tải được, menu lệnh nhóm và gửi `/ping`, kiểm không cuộn ngang ở 1333×780 và 390×844).
- Screenshot: `plans/dattqh/reports/fullstack-developer-261015-2018-r5-slice-b2-shots/group-command-menu-1333x780.png`, `group-command-menu-390x844.png` (`E2E_SHOTS_DIR=… pnpm e2e bots`).
- `redocly lint`: valid; `buf lint`/`buf breaking`: sạch; gitleaks trên mọi file đổi/mới và diff: no leaks.

## Files chính

Server: `internal/chat/{bot_actions.go,bot_events.go}` (mới), `chat/{service.go,bots.go,media.go}` (+ `allow(ctx,…)` ở các file core khác), `internal/media/stream.go(+_test)`, `internal/botapi/{messages.go,files.go,chats.go,contract_test.go,methods_test.go}` (mới), `botapi/{botapi.go,webhook.go,wire/wire.go,botapi_test.go}`, `internal/botupdates/{botupdates.go,webhook.go}` + test, `botadmin/botadmin.go`, `bottest/bottest.go` (tuỳ chọn Media), `gateway/hub.go`, `rpc/bots_service.go`, `api/api.go`, `migrations/0017_bot_update_kinds.sql`, `proto/app/v1/bots.proto` + gen. Web: `messaging/bots/{bot-chat.tsx,bot-chat.css,api.ts,client.ts,delivery.tsx,copy-*.ts}`, `messaging/ui/{composer.tsx,conversation.tsx}`, `test/{bots.test.tsx,support/fake-bots.ts,e2e/bots.e2e.ts}`. Docs: `docs/bot-api/README.md` (mục 4–8), `server/README.md`, phase-08 todo, mocks `bots.html`, `console.html`.

## Concerns

- Quota lưu trữ vượt khi bot upload trả `429 rate_limited` (lõi media dùng `resource_exhausted`); đúng envelope nhưng tên mã lệch nghĩa. Đổi sang mã riêng là thay contract nhỏ, chưa làm.
- `reaction.emoji` là trạng thái lúc cắt update: đổi nhanh có thể ra nhiều update cùng trạng thái cuối (ghi trong spec).
- Bot đã rời chat gọi `GET /chats/{id}/admins` nhận `403 forbidden` (theo lõi), chưa bao giờ là thành viên thì `404`.
- Bot mặc định giờ nhận thêm `member_changed`; bot cũ phải bỏ qua loại lạ (spec đã yêu cầu từ v1.0). Bot Trợ lý không bị ảnh hưởng (test assistant và e2e pass).

Status: DONE_WITH_CONCERNS
Summary: Bot API có đủ method Phase 8 ngoài inline mode và bulk (sửa, xoá, chuyển tiếp, sao chép, reaction, ghim, chat action, file upload/file_id/GET, quản trị nhóm), update `member_changed`/`reaction`, menu lệnh nhóm trên web và contract test theo OpenAPI; mọi gate pass.
Concerns: Deploy cần migration 0017 và root deploy cho conf nginx (upload > 1 MiB); quota upload trả 429; không có gửi theo URL.
