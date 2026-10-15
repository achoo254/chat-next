# R5 lát A — Bot API lõi (backend)

Ngày 2026-10-15. Chưa commit (controller commit). Không đụng production.

## Đã làm

- **Migration `0013_bots`** (expand-only): `users.is_bot`, `idp_sub` nullable + `CHECK (is_bot OR idp_sub IS NOT NULL)`, `user_sessions.auth_time`, bảng `bots` (owner, `token_hash`, mô tả, about, `privacy`, `verified`, `internal`, `commands` jsonb, `next_update_id`, `deleted_at`), `bot_user_consent` (nguồn `start|deep_link|button|message`), `bot_callbacks`, `bot_updates` (PK `(bot_id, update_id)`, unique `(bot_id, outbox_id, part)`, `expires_at`), cursor `bots` đặt ở đầu outbox hiện tại. Outbox kind `inline_button` đã có sẵn, không đổi CHECK. Down/up của migration mới nhất qua test `TestLatestMigrationRollsBack`.
- **Lõi (`internal/chat/bots.go`)**: consent invariant trong `postable` (đường chung của tin, media, chuyển tiếp): bot gửi chat riêng thiếu consent → `permission_denied` `no_consent`; người nhắn riêng cho bot ghi consent `message`. `StartBot`, `SendBotMessage` (bàn phím inline/reply/remove, kiểm URL ADR 0004), `PressInlineButton` (ghi `bot_callbacks` + dòng outbox `inline_button`), `BotUpdates` (cắt update cho bot từ outbox: message/message_edited/callback, privacy mode trong nhóm, bỏ tin của chính bot và bot khác). `SendMessage` tách thành `postText` dùng chung. `User.is_bot` điền ở mọi chỗ render user (`loadUsers`). Hook `SetCommitObserver` sau mỗi commit.
- **`internal/botupdates`**: consumer outbox cursor `bots` (khoá dòng cursor, theo dõi id chưa commit 30 s), cấp `update_id` dưới khoá dòng `bots` (một writer mỗi bot), idempotent khi đọc lại; long poll đánh thức trong process + kiểm DB mỗi 2 s, poll mới làm poll cũ trả `ErrConflict`; trả lời callback và `AwaitAnswer` (10 s); dọn mỗi 10 phút; `ReleasePolls` khi dừng server.
- **`internal/botadmin`**: tạo/sửa/liệt kê/cấp lại token/xoá bot, giới hạn 20 bot mỗi chủ, token `<bot_id>:<secret 40 ký tự>` chỉ lưu SHA-256, so sánh hằng thời gian, `Authenticate`, `SetCommands`, `Info` (menu theo vai trò).
- **`internal/botapi`** (+ `format`, `wire`): HTTP `/bot/v1/…` trong process `api`, chỉ trên host tenant, envelope thống nhất, tier rate limit, chặn IP xác thực sai, parser Markdown/HTML subset viết mới + fuzz.
- **Đăng nhập gần đây (ADR 0006)**: phiên chưa lưu `auth_time` nên thêm cơ chế tối thiểu: `/auth/login?reauth=1` gửi `prompt=login` + `max_age=600`, callback lưu `auth_time` của ID token vào `user_sessions.auth_time`; `ResetBotToken`/`DeleteBot` cần `auth_time` ≤ 10 phút, nếu không trả `failed_precondition` `reauth_required`.
- **RPC**: `BotAdminService` mới, `BotsService` (StartBot, GetBotInfo; InlineQuery/OpenMiniApp `unimplemented` có message rõ), `MessagesService.PressInlineButton`.
- **Spec**: `spec/bot-api/openapi.yaml` (3.1), `spec/bot-api/format.md`.
- **Hạ tầng/docs**: nginx `location ^~ /bot/` + zone `chat_bot`; bước kiểm `/bot/` trong `activate-release.sh` và `smoke.sh`; `docs/deployment-guide.md`, `docs/infrastructure-inventory.md`, `server/README.md` (mục Bot API); phase-08 (host, kiến trúc, rollback, todo) và phase-15 (base URL SDK).

## Hợp đồng Bot API (lát A)

Base `https://chat.<d>/bot/v1`, `Authorization: Bearer <bot_id>:<secret>`, JSON ≤ 1 MiB, trường lạ bị từ chối.

| Method | Ghi chú |
|---|---|
| `GET /me` | id, is_bot, name, username, privacy, tier, description, about |
| `POST /messages` | `chat_id`, `text`, `entities` hoặc `parse_mode` (`markdown`/`html`), `reply_to_seq`, `topic_id`, `reply_markup` (`inline_keyboard` callback_data ≤ 64 byte / url; `keyboard`; `remove_keyboard`), `random_id`, `disable_link_preview` → Message |
| `GET /updates?offset&limit&timeout` | limit 1–100, timeout 0–50 s, offset xác nhận; poll đồng thời → poll cũ `409 conflict` |
| `POST /callbacks/{id}:answer` | `text` ≤ 200, `show_alert`, `url`; một lần, trong 15 phút |
| `PUT /commands` | `scope` default/private/group/group_admin, `commands` |
| `GET /chats/{chat_id}` | chỉ chat bot đang là thành viên |

Envelope: `{"ok":true,"result":…}` / `{"ok":false,"error":{"code","description","retry_after"}}`. Mã: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `no_consent` 403, `not_found` 404, `method_not_allowed` 405, `conflict` 409, `payload_too_large` 413, `unsupported_media_type` 415, `rate_limited` 429 (+`retry_after`, `Retry-After`), `internal` 500. Tier mặc định: 30 call/s, 30 tin/s, 1 tin/s mỗi chat (burst 20); `verified`, `internal` cao hơn. 20 lần xác thực sai mỗi IP rồi chặn 60 s.

Update lát A: `message` (chat riêng + nhóm; privacy mode mặc định bật: chỉ `/lệnh` hoặc `/lệnh@bot` ở đầu tin, trả lời tin của bot, tin hệ thống), `message_edited` (sửa thật của người gửi), `callback`. Kênh chưa có (channel_post ở lát sau). Giữ 24 h, callback 15 phút.

## Proto cho agent web

- `proto/app/v1/bot_admin.proto` (mới): `BotAdminService` — `ListMyBots`, `CreateBot` (bot mới **không có token**), `UpdateBot` (trường `optional`; `commands: BotCommandSets` có mặt thì thay toàn bộ), `ResetBotToken` (trả `token` một lần), `DeleteBot`. Kiểu: `Bot` (user, description, about, privacy, commands, tier, has_token, created_at, token_issued_at), `BotTier`, `BotCommandScope`, `BotCommand`, `BotCommandSet`, `BotCommandSets`. Lỗi web cần xử lý: `failed_precondition` message bắt đầu `reauth_required` → chuyển trình duyệt tới `/auth/login?reauth=1&return_to=<đường dẫn hiện tại>` rồi gọi lại; `bots_limit`; `already_exists` `username_taken`.
- `bots.proto`: thêm `GetBotInfo(bot_id, chat_id)` → user, description, about, `commands` (menu đúng scope cho người gọi); chú thích luồng deep link `/b/<username>?start=` (ResolveUsername → GetBotInfo → xác nhận → StartBot).
- `messages.proto`: `PressInlineButtonResponse.timed_out` (bot không trả lời trong 10 s → hiện "bot không phản hồi").
- `User.is_bot` đã điền thật ở mọi RPC trả user.

## Deploy

- Cần **deploy bằng root một lần** (như R2): đổi conf nginx (`/bot/`, zone `chat_bot`), `activate-release.sh`, `smoke.sh`. Deploy tự động dùng conf trong `/opt/chat/infra` nên chưa có `/bot/`.
- Migration `0013_bots` chạy tự động ở bước migrate; không biến môi trường mới, không DNS/chứng chỉ mới, không process pm2 mới.
- Sau deploy: `smoke.sh` kiểm `GET /bot/v1/me` không token → 401 `unauthorized`; kiểm tay một lần "Cấp lại token" (cần IdP trả `auth_time` khi có `max_age`, oidc-provider làm vậy).
- Chưa chạy `nginx -t` (máy dev không có nginx); `activate-release.sh` chạy `nginx -t` trước khi đổi và tự trả lại khi lỗi.

## Bằng chứng kiểm thử

- `gofmt -l .` rỗng; `go vet ./...` sạch; `golangci-lint run ./...` (v2.12.2) `0 issues`.
- Gói mới (`-race -count=1`): `botapi` 11 test, `botupdates` 3, `botadmin` 4, `botapi/format` 4 + 2 fuzz; thêm `chat` 2 test (`TestBotConsentInCore`, `TestCommandOf`), `api` 1 test e2e (`TestBotPlatformEndToEnd`: CreateBot qua RPC, `reauth_required`, `/auth/login?reauth=1` gửi `prompt=login&max_age=600`, ResetBotToken, StartBot, long poll, PressInlineButton qua RPC ↔ answer qua HTTP).
- Fuzz: `FuzzMarkdown` 40 s ≈ 2,54 triệu lần chạy, `FuzzHTML` 30 s ≈ 629 nghìn lần, không lỗi (bất biến: UTF-8 hợp lệ, entity hợp lệ theo `entities.Validate`, link đúng allowlist).
- Phủ tiêu chí: 403 no_consent (HTTP + lõi, cả đường chuyển tiếp); consent qua StartBot/deep link rồi gửi được; long poll trả tin riêng của user (thức < 2 s); ack theo offset; 409 poll đồng thời; privacy mode trong nhóm (bật/tắt); callback press → update → answer (+ trả lời lần hai 400, id lạ 404, bot khác 404, timeout); token sai/thu hồi/bot xoá → 401; reset token vô hiệu token cũ; yêu cầu đăng nhập gần đây; `random_id` idempotent; `update_id` tăng ngặt khi gửi đồng thời và khi hai consumer chạy song song (đúng 1..n); consumer đọc lại từ cursor cũ không tạo update mới; cursor không vượt id outbox của transaction chưa commit; rate limit theo chat 429 + `retry_after`; chặn IP sau 20 lần xác thực sai.
- Toàn bộ: `go test -race -count=1 -p 2 ./...` — mọi gói `ok` (chat 31,5 s, api 25,2 s).
- `pnpm proto:lint`, `pnpm proto:breaking` qua; `pnpm proto:gen` chạy lại cho cùng checksum (không drift); `pnpm typecheck` 6/6 project `Done`.
- `npx @redocly/cli lint spec/bot-api/openapi.yaml`: "Your API description is valid", 0 cảnh báo.
- `gitleaks dir` trên các file mới: no leaks found.

## Vấn đề còn mở

1. ADR 0010 (bảng host) vẫn ghi `bot.chat.<d>` và `hook.chat.<d>`; thực tế cả hai là đường dẫn trên `chat.<d>`. `plan.md` (dòng câu hỏi mở về host Bot API) cũng cần ghi đã quyết. Controller cập nhật hoặc giao.
2. Chưa có test validate response/update theo OpenAPI (todo "Mapping + validate OpenAPI" để chưa tick) và contract test HTTP thô.
3. Bot bị kick khỏi nhóm chưa huỷ update đang chờ của nhóm đó (yêu cầu phase 8, ngoài lát A).
4. Privacy mode: `/lệnh` không kèm `@bot` tới mọi bot privacy trong nhóm (đơn giản hơn luật "bot gửi gần nhất" của Telegram); đã ghi trong spec.
5. Kênh: bot admin của kênh gửi được nhưng chưa nhận update (`channel_post` ở lát sau).
6. `ResetBotToken` phụ thuộc IdP trả `auth_time` khi có `max_age`; cần kiểm một lần trên prod sau deploy.

Status: DONE
Summary: Bot API lõi lát A hoàn tất: migration, lõi consent, consumer update_id một writer, long poll/409, callback, quản lý bot với yêu cầu đăng nhập gần đây, spec OpenAPI + format, nginx/smoke/docs. Toàn bộ test Go (-race), lint, proto và typecheck đều qua.
Concerns/Blockers: Cần một lần deploy bằng root (nginx + script); ADR 0010 và plan.md còn ghi host bot.chat cũ.

## Sửa theo review

Review: [`code-reviewer-261015-1350-r5-slice-a-backend.md`](code-reviewer-261015-1350-r5-slice-a-backend.md). Migration `0013_bots` chưa chạy trên production nên sửa thẳng trong file. Không đổi proto.

| Phát hiện | Sửa | Bằng chứng |
|---|---|---|
| H1 update đã ack bị giao lại sau restart/lùi cursor | `bot_updates.acked`: ack là `UPDATE … SET acked = true`, `read` lọc `NOT acked`, dọn vẫn theo `expires_at`; dòng đã ack còn làm tombstone nên `ON CONFLICT` của lần đọc lại vẫn thấy | `TestAcknowledgedUpdatesAreNotRedelivered` (poll, ack, lùi cursor về đầu, consumer mới CatchUp: id và `next_update_id` không đổi, poll với offset cũ và offset 0 đều rỗng) |
| H2 một dòng outbox hỏng chặn mọi bot | `updatesOf`: lô lỗi thì thử từng dòng; dòng lỗi được đếm trong bộ nhớ, dưới 3 lượt thì lượt rollback và thử lại (lỗi DB thoáng qua không làm mất update), đủ 3 lượt thì bỏ qua, log `Error` `bot update consumer skipped an outbox row` kèm `outbox_id`, `skipped_total`. Payload không mã hoá được: log và bỏ riêng update đó | `TestPoisonRowDoesNotStallOtherBots` (dòng outbox trỏ log `\xffffff`, xác nhận `BotUpdates` lỗi trên dòng đó; consumer qua được trong ≤ 3 lượt, cursor vượt dòng hỏng, tin sau đó tới bot) |
| M1 `message_edited` trùng do server ghi lại tin | Chỉ giao khi `edit_date` hiện tại của tin bằng `created_at` của dòng outbox (cùng `now()` của transaction sửa). Gắn xem trước link, media xử lý xong giữ `edit_date` cũ nên bị bỏ; lần sửa đã bị lần sau thay cũng bỏ (dòng sau giao nội dung hiện tại) | `TestServerRewriteIsNotAnEditForBots` (preview trước sửa, sửa, preview sau sửa → đúng `[message message_edited]`) |
| M2 truy vấn theo từng update | `botBatches`: mỗi lượt render toàn bộ tin của một bot bằng một `renderMessages`, chat theo từng (bot, chat) một lần, người bấm nút một `loadUsers`; callback nạp tin và chat một lần cho cả lô | Toàn bộ test bot (`chat`, `botupdates`, `botapi`, `api`) qua |
| M3 chặn IP chặn cả token đúng; nginx 50 r/s dưới tầng | Xác thực trước; chỉ lần sai được đếm và chỉ lần sai bị trả `429` khi địa chỉ bị chặn, token đúng luôn qua. nginx `chat_bot` 600 r/s burst 1200 (trên tầng `internal` 500/s burst 1000), lý do ghi trong conf, README, `docs/infrastructure-inventory.md`, `docs/deployment-guide.md` | `TestFailedAuthBlocksAddress` sửa: sau 20 lần sai, lần sai và không token → 429, token đúng cùng địa chỉ → 200 |
| L1 tạo/xoá bot không giới hạn | `CreateBot` thêm bucket theo chủ 20 lần liền rồi 1 lần mỗi 3 phút (`resource_exhausted`), kiểm sau `bots_limit` | `TestBotsPerOwnerLimit` (20 bot, xoá 1, tạo tiếp → `ResourceExhausted`) |
| L2 bot đã xoá vẫn như còn sống | Chọn trả username: `DeleteBot` đổi username thành `deleted_<id>` (thêm hậu tố ngẫu nhiên nếu có người giữ), `privacy_settings` về `nobody` (không tìm theo username/tên, không mở chat mới, không thêm vào nhóm); `checkPrivatePeer` từ chối gửi vào chat cũ với bot đã xoá (`failed_precondition` `bot_deleted`); `StartBot` vẫn `not_found` | `TestDeletedBotIsGone` (resolve 404, search rỗng, username đăng ký lại được, gửi vào chat cũ `bot_deleted`, `CreatePrivate` `permission_denied`, `StartBot` `not_found`) |
| L3 `&` trong HTML | Theo trình duyệt: `&` không thể đọc thành tham chiếu là chính nó (`AT&T`, `?a=1&b=2`); chuỗi có dạng tham chiếu mà không biết (`&nbsp;`, `&copy;`) vẫn `400`. `format.md` ghi rõ | `TestHTML`/`TestHTMLErrors` thêm ca; `FuzzHTML` 20 s ≈ 415 nghìn lần, không lỗi |
| L4 405 của nginx khác app | Bỏ `limit_except` ở `/bot/` (app trả `405 method_not_allowed` JSON); vượt zone nginx trả `429` cùng envelope JSON (`limit_req_status 429`, `@bot_rate_limited`) | Đọc conf; chưa `nginx -t` (máy dev không có nginx, `activate-release.sh` chạy `nginx -t` trước khi đổi) |
| L5 spec thiếu 503 | Thêm response `Unavailable` (503, `Retry-After`) cho mọi operation; mô tả 429 gồm chặn xác thực sai và giới hạn của nginx; `retry_after` cho cả `unavailable` | `redocly lint`: valid, 0 cảnh báo |
| L6 vòng lặp poll khi dừng | Sau `ReleasePolls`: poll đang chờ trả rỗng, poll mới `ErrUnavailable` → `503 unavailable`, `retry_after` 5 | `TestPollAfterShutdownIsRefused`, `TestUpdatesDuringShutdown` |
| L7 đánh số `part` | Bỏ `part`; khoá `UNIQUE (bot_id, outbox_id, kind, seq)` với `seq` là tin của update, không phụ thuộc tin khác của dòng còn hay đã xoá | `TestReplayIsIdempotent`, `TestConcurrentConsumersKeepOneWriterPerBot` qua |
| L8 khoá của migration | `SET LOCAL lock_timeout = '5s'` đầu phần Up (goose chạy trong transaction) | `TestLatestMigrationRollsBack` (gói `store`) qua |
| L9 consent của StartBot ngoài transaction | Consent ghi trong transaction của tin `/start` (`textPost.consent`), gửi bị từ chối thì không có consent | `TestStartBotConsentOnlyWithTheMessage` (bot chặn người dùng → StartBot `permission_denied`, không consent; bỏ chặn → consent `deep_link`) |
| L10 callback cho tin đã xoá | `PressInlineButton` trên tin đã xoá trả `not_found` (đã đúng qua `liveMessage`, nay có test); consumer bỏ press của tin bị xoá trước khi đọc | `TestDeletedMessageHasNoCallback` |
| Câu hỏi một instance | README mục Bot API: 409 và đánh thức trong process giả định một process `chat-api` (GĐ1 trên .65, quyết định Bot API ở process `api` tới khi sang cụm riêng); việc cần làm trước khi chạy nhiều instance | `server/README.md` |

Kiểm tra sau khi sửa:

- `gofmt -l .` rỗng; `go vet ./...` sạch; `golangci-lint run ./...` (v2.12.2, như CI) `0 issues.`
- Từng gói (`-race -count=1`, lần lượt): `chat` ok 34,3 s; `botupdates` ok; `botadmin` ok; `botapi` ok 8,8 s; `botapi/format` ok; `api` ok 26,5 s; `store` ok 8,3 s.
- Toàn bộ `go test -race -count=1 -p 2 ./...`: 25 gói `ok`, không gói nào lỗi (chat 33,5 s, api 27,3 s).
- `npx @redocly/cli lint spec/bot-api/openapi.yaml`: "Your API description is valid".
- `gitleaks dir` trên `server/internal/{botupdates,botadmin,botapi,chat}`, `server/migrations`, `server/README.md`, `spec/bot-api`, `infra/chat/nginx`: no leaks found. (Quét gộp nhiều đường dẫn làm gitleaks quét cả repo và báo 2 `generic-api-key` trong `apps/web/test/…`, ngoài phạm vi lát này.)

File đã sửa: `server/migrations/0013_bots.sql`, `server/internal/{botupdates,botadmin,botapi,botapi/format,bottest}/…`, `server/internal/chat/{bots.go,bots_test.go,messages.go}`, `server/internal/api/api.go`, `server/README.md`, `spec/bot-api/{openapi.yaml,format.md}`, `infra/chat/nginx/chat.hoandat.com.conf`, `docs/{infrastructure-inventory.md,deployment-guide.md}`.

Còn mở: deploy root một lần vẫn cần như trên (conf nginx đổi thêm); `nginx -t` chạy ở bước activate. API web (`BotAdminService.CreateBot`) giờ có thể trả `resource_exhausted`; web nên hiện như các lỗi giới hạn khác.

### Thêm: "Cloud của tôi" sau "Xoá toàn bộ tin nhắn" (yêu cầu bổ sung, đã được duyệt)

- Sửa: `DeleteChat` trên chat với chính mình gọi `clearSaved` (`server/internal/chat/dialogs.go`): ẩn lịch sử như chat riêng (`visible_from_seq = last_seq + 1`, `read_inbox_max_seq = last_seq`; tìm kiếm và media vốn lọc theo `visible_from_seq`) nhưng **giữ `pin_rank`**; `dialogListed` (`chats.go`) không còn loại chat với chính mình khi lịch sử trống. Phần chung tách thành `hideHistory`; chat riêng thường không đổi hành vi.
- Hợp đồng update, dùng các loại client đã xử lý, không đổi proto: trong nhật ký của mình, theo thứ tự `chat_deleted{chat_id}` (client `purgeChat`: xoá tin, dialog, read state cục bộ) → `chat_updated{chat}` (render theo người xem, `left = false`; `putChat` đặt lại `left_chat = 0` mà `purgeChat` vừa đặt) → nếu đang ghim, `pinned_dialogs{chat_ids}` (`ensureDialog` + `putPinnedOrder`: dialog và ghim trở lại).
- Test: `TestClearSavedChatKeepsDialogAndPin` (`server/internal/chat/saved_clear_test.go`): sau khi xoá, GetDialogs vẫn liệt kê và vẫn ghim, không chưa đọc, GetHistory rỗng, tìm kiếm không thấy tin cũ, nhật ký đúng thứ tự ba update, ghi chú mới gửi được và là tin duy nhất (tìm thấy); bỏ ghim rồi xoá lại vẫn được liệt kê.
- Việc cho agent web (một thay đổi nhỏ, không đổi proto): khi Cloud **không ghim**, client hiện tại xoá dialog cục bộ ở `chat_deleted` và không có gì dựng lại cho tới tin mới hay lần tải lại danh sách. Đề xuất trong `packages/core/src/sync/apply.ts`, nhánh `chat_updated`: sau `putChat`, nếu `!body.chat.left && body.chat.type === "private" && body.chat.peerUserId === selfId` thì `ensureDialog(w, body.chat.id)`. Trường hợp ghim (mặc định) đã đúng không cần sửa client.
- Kiểm tra lại sau thay đổi này: `gofmt -l .` rỗng, `go vet` sạch, `golangci-lint` `0 issues.`, `go test -race -count=1 -p 2 ./...` 25 gói `ok` (chat 33,6 s).
