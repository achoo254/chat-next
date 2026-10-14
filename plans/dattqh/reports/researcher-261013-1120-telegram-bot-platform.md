# Research: Bot platform kiểu Telegram và chiến lược Bot API tương thích

> **Ghi chú 2026-10-13:** khuyến nghị "tương thích wire-level với Telegram Bot API" trong báo cáo này đã bị thay thế. User xác nhận sản phẩm độc lập với Telegram; plan chỉ dùng phần kiến trúc, feature inventory và ngữ nghĩa giao update. Xem phase 8 của [chat-platform-v1](../261013-0448-chat-platform-v1/phase-08-bot-platform.md).


Ngày: 2026-10-13 (Asia/Saigon) · Phạm vi: greenfield chat app `chat-inet` · Tác giả: researcher

## Kết luận trước

Nên làm **một Bot API duy nhất, tương thích wire-level với Telegram Bot API cho một tập con được ghim phiên bản** (ghim theo Bot API 10.3), cộng một namespace mở rộng riêng cho tính năng đặc thù của mình. Đổi base URL là đủ để các thư viện lớn chạy được, vì tất cả đều hỗ trợ override (đã kiểm chứng trong source). Phần khó nằm ở **mô hình dữ liệu của core**, không nằm ở lớp HTTP. Core phải dùng ID số nguyên ≤ 52 bit, `message_id` int32 tăng dần theo chat, text + entities với offset tính theo UTF-16, privacy mode và rate limit enforce ngay tại core. Nếu chốt các ràng buộc này từ ngày đầu thì gateway sẽ mỏng. Nếu không, gateway sẽ thành một tầng mapping dễ vỡ. Parity đầy đủ là không khả thi: Telegram có 185 method, 400 type và ra khoảng 1 bản Bot API mỗi tháng trong năm 2026.

## 1. Source manifest

| # | Nguồn | Phiên bản / SHA | Độ tin cậy | Dùng cho |
|---|---|---|---|---|
| 1 | core.telegram.org/bots/api | Bot API 10.3 (2026-08-24); đếm được 185 method, ~400 type | Chính thức, cao | Contract, update, limit |
| 2 | core.telegram.org/bots/features, /bots/faq, /bots/inline, /bots/payments | tải 2026-10-13 | Chính thức, cao | Tier, privacy, rate limit |
| 3 | core.telegram.org/bots/webapps, /api/web-events | tải 2026-10-13 | Chính thức, cao | initData HMAC/Ed25519, host bridge |
| 4 | github.com/tdlib/telegram-bot-api | `e3e9dd8e5b3d7ab8537cd5a10dc31d5ffa8f82d1` (2026-08-25), **BSL-1.0**, 4.5k★ | Source chính thức, cao | Retry webhook, ordering, TTL, lỗi |
| 5 | github.com/tdlib/td (master): `td/telegram/MessageEntity.cpp` (parse_markdown_v2 L2092, parse_html L3363), `tdnet/td/net/HttpQuery.cpp` | BSL-1.0 | Source chính thức, cao | Parser formatting, Retry-After |
| 6 | Source thư viện: grammY v1.46.0, python-telegram-bot v22.8 (LGPLv3), aiogram v3.31.0, Telegraf v4.16.3, node-telegram-bot-api v2.2.0-rc2, go-telegram-bot-api, go-telegram/bot, Java TelegramBots | đọc trực tiếp raw source trên nhánh mặc định | Source, cao | Base-URL override, kiểu số, mapping lỗi |
| 7 | PaulSonOfLars/telegram-bot-api-spec (`api.json`) | 10.3, 185 method / 400 type, MIT | Cộng đồng, tự cập nhật hằng ngày; số liệu khớp với #1 | Sinh schema conformance |
| 8 | docs.bale.ai (Bale messenger) | tải 2026-10-13, qua bộ tóm tắt | Trung bình (tiếng Ba Tư, đọc gián tiếp) | Tiền lệ "API tương thích Telegram" |
| 9 | jehy/telegram-test-api | MIT, 108★, push gần nhất 2024-06 | Thấp, chỉ tham khảo | Mẫu fake server + user simulator |

Clone chỉ đọc nằm ở scratchpad `.../scratchpad/src/telegram-bot-api` (không clone submodule `td`).

## 2. Bảng tier tính năng

Quy ước cột "v1": **Có** = nên ship ở v1; **Tùy** = ship nếu core đã có tính năng tương ứng; **Không** = để sau.

| Tier | Tính năng | Bot API surface chính | Core cần có | v1 |
|---|---|---|---|---|
| 0 | Tạo bot + token (kiểu BotFather), xoay vòng token | UI/bot quản trị; `getMe`, `logOut`/`close` (no-op) | User principal `is_bot`, owner | Có |
| 0 | Gửi/sửa/xóa tin | `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `editMessageCaption`, `deleteMessage(s)`, `forwardMessage`, `copyMessage`, `sendChatAction` | Message CRUD, typing indicator | Có |
| 0 | Nhận update | `getUpdates` (long-poll), `setWebhook`/`deleteWebhook`/`getWebhookInfo`, gọi method trong response webhook | Event bus → per-bot queue | Có |
| 0 | Command + menu | `setMyCommands`/`getMyCommands`/`deleteMyCommands` + `BotCommandScope`, `setChatMenuButton` | Client hiện menu `/`, entity `bot_command` | Có |
| 0 | Reply keyboard, ForceReply, ReplyKeyboardRemove | `reply_markup` | Client render keyboard | Có |
| 0 | Inline keyboard + callback | `InlineKeyboardButton` (`callback_data` 1–64 byte, `url`), `answerCallbackQuery`, update `callback_query` | Client gửi callback, toast/alert | Có |
| 0 | Formatting | `parse_mode` HTML / MarkdownV2 / Markdown (legacy), `entities`, `caption_entities` | Text + entities UTF-16 | Có |
| 0 | Ảnh / tài liệu, upload/download | `sendPhoto`, `sendDocument`, `getFile` + `GET /file/bot<token>/<file_path>`, gửi lại bằng `file_id`, gửi bằng URL | Object storage, thumbnail | Có |
| 0 | Group privacy mode | Lọc tại core; `can_read_all_group_messages` trong `getMe` | Logic lọc tin cho bot | Có |
| 0 | Thành viên chat | `my_chat_member`, `chat_member`, `getChat`, `getChatMember`, `getChatAdministrators`, `getChatMemberCount`, `leaveChat` | Membership events | Có |
| 0 | Profile bot | `setMyName`, `setMyDescription`, `setMyShortDescription` | Profile fields | Có |
| 1 | Deep link `/start <param>` | `t.me/<bot>?start=` (≤64 ký tự `[A-Za-z0-9_-]`), `?startgroup=` | Link router trong client | Có (rẻ) |
| 1 | Web Apps / Mini Apps | `web_app` button, menu button, `answerWebAppQuery`, initData HMAC + Ed25519 | Webview host + bridge `postEvent` (79 event `web_app_*`) | Có (giá trị cao) |
| 1 | Media đầy đủ | `sendVideo`, `sendAudio`, `sendVoice`, `sendAnimation`, `sendMediaGroup`, `editMessageMedia` | Transcode, album | Tùy |
| 1 | Reactions | `setMessageReaction`, update `message_reaction(_count)` | Reactions trong core | Tùy |
| 1 | Moderation | `ban/unban/restrict/promoteChatMember`, `setChatPermissions`, invite link, `chat_join_request`, pin/unpin | Quyền admin chi tiết | Tùy |
| 1 | Forum topics | `message_thread_id`, `create/edit/close/deleteForumTopic` | Topics trong group | Tùy |
| 1 | Inline mode | `inline_query`, `answerInlineQuery`, `chosen_inline_result`, `via_bot` | UI `@bot query` trong composer | Không (v1.5) |
| 1 | Poll | `sendPoll`, `stopPoll`, `poll_answer` | Poll trong core | Tùy |
| 1 | Streaming draft cho AI bot | `sendMessageDraft`, update `stopped_message_generation` | Draft tạm thời phía client | Tùy (đáng làm nếu có AI agent) |
| 1 | Ephemeral message | `ephemeral_message_parameters`, `edit/deleteEphemeral*` | Tin chỉ một user thấy | Không |
| 1 | Bot-to-bot | Chế độ bật trong BotFather + yêu cầu chống vòng lặp | Ngoại lệ trong privacy filter | Không |
| 2 | Payments / Stars / subscription / paid media | `sendInvoice`, `pre_checkout_query`, `shipping_query`, `XTR` | Cổng thanh toán (ở VN: VNPay/MoMo, không phải Stripe/Stars) | Không |
| 2 | Games | `sendGame`, `setGameScore` | HTML5 game host | Không |
| 2 | Business, Managed bots, Guest mode | `business_*`, `getManagedBotToken`, `guest_message` | Quan hệ account ↔ bot | Không |
| 2 | Stories, gifts, boosts, verification, sticker set, checklist, live location, rich messages, Passport, suggested posts | ~90 method còn lại | Các tính năng sản phẩm tương ứng | Không |

Bot API là hình chiếu của tính năng sản phẩm. Method nào bot gọi được thì core phải có tính năng đó trước. Vì vậy, "bot platform ít nhất mạnh như Telegram" thực chất nghĩa là "app ít nhất mạnh như Telegram". Phạm vi bot nên bám theo roadmap của core, đừng bám theo danh sách method của Telegram.

## 3. Contract phân phối update (chuẩn để implement)

Các quy tắc dưới đây lấy từ docs (D) hoặc từ source server (S, SHA ở trên). Thư viện và bot ngoài thực tế đều dựa vào chúng.

1. **`update_id`** (D): định danh riêng cho từng bot, tăng tuần tự. Nếu không có update nào trong ≥1 tuần thì id kế tiếp được chọn ngẫu nhiên, nên client không được giả định id bắt đầu từ 1. Nên giữ `< 2^31`, vì Java TelegramBots khai báo `Integer updateId`.
2. **Xác nhận bằng offset** (D): một update được coi là đã xác nhận khi `getUpdates` được gọi với `offset > update_id`. `offset` âm nghĩa là lấy `-offset` update cuối và bỏ hết phần trước. `limit` 1–100, mặc định 100.
3. **Long-poll** (S): `timeout` bị clamp vào khoảng 0–50 s (`LONG_POLL_MAX_TIMEOUT = 50`). Khi có `getUpdates` thứ hai đồng thời, request cũ nhận 409 `Conflict: terminated by other getUpdates request...`. Khi webhook đang bật, `getUpdates` trả 409. Idle timeout của load balancer phải lớn hơn 50 s.
4. **Lưu giữ** (D+S): tối đa 24 giờ. Server tính TTL theo `date` của message + 86400. Riêng `callback_query`, `shipping_query`, `pre_checkout_query` chỉ sống 150 s, `inline_query` 30 s, `chosen_inline_result` 600 s.
5. **`allowed_updates`** (D+S): lưu theo bot. Danh sách rỗng nghĩa là nhận tất cả trừ `chat_member`, `message_reaction`, `message_reaction_count`. Bỏ qua tham số thì giữ cài đặt trước đó. Lọc diễn ra **lúc enqueue**, nên update đã nằm trong queue trước khi đổi cài đặt vẫn được giao.
6. **Webhook** (D+S):
   - Mỗi update là một POST JSON. Chỉ HTTP 2xx được tính là thành công.
   - Header `X-Telegram-Bot-Api-Secret-Token` chứa giá trị 1–256 ký tự `[A-Za-z0-9_-]`. Tên header phải giữ nguyên vì thư viện kiểm tra đúng tên này.
   - `max_connections` từ 1 đến 100, mặc định 40.
   - Retry: delay đầu 1 s, mỗi lần lỗi nhân đôi, trần ngẫu nhiên trong khoảng 60–120 s. Header `Retry-After` của response được tôn trọng, clamp 0–3600 s. Update bị drop khi quá hạn TTL.
   - Webhook trả HTTP 410 liên tục trong 23 giờ thì bị gỡ.
   - Body response 2xx có field `method` thì method đó được thực thi kiểu fire-and-forget (trừ `get*`, `setWebhook`, `deleteWebhook`, `close`, `logOut`). **Telegraf mặc định bật `webhookReply: true`**, nên đây là Tier 0.
7. **Ordering** (S): ở chế độ webhook, mỗi update có một `queue_id`. Message dùng `chat_id`. Callback, inline và chat-join dùng `user_id + (k << 33)`. Các update cùng queue được giao **tuần tự, tối đa 1 request in-flight**; các queue khác nhau chạy song song tới `max_connections`. Như vậy chỉ có FIFO theo chat, **không có thứ tự toàn cục**. Ở long-poll, update trả về theo thứ tự `update_id`.
8. **Một update chỉ có đúng một field payload** (D). Thư viện dispatch theo tên field, nên các tên `message`, `edited_message`, `callback_query`, ... phải giữ nguyên.
9. **Snapshot**: JSON được serialize lúc enqueue (S, `add_update_impl`). Nếu tin bị sửa sau đó thì phát thêm `edited_message`, không cập nhật update cũ.

## 4. Hàm ý kiến trúc

**Telegram làm thế nào** (S + README): `telegram-bot-api` là một **client MTProto**. Mỗi bot là một instance TDLib đăng nhập bằng token. Server MTProto coi bot là một user có cờ `bot` và enforce quyền, privacy và flood (FLOOD_WAIT được dịch thành 429). Gateway khoảng 20k dòng (`Client.cpp`), làm các việc sau: dịch `td_api` sang JSON, giữ cache state cho từng bot, lưu update trong `TQueue` (binlog), và chạy `WebhookActor`. Chính server này cũng tách `bot_id` từ phần trước dấu `:` của token.

**Áp dụng cho mình.** Mình sở hữu core nên không cần mô phỏng MTProto. Gateway có thể mỏng hơn vì gọi thẳng RPC nội bộ.

```
client app ──► Core chat service (users[is_bot], chats, members, messages, files)
                 │  enforce: quyền, privacy filter, rate limit, bot không thấy tin bot khác
                 ▼ domain events (message.created/edited, member.changed, callback.pressed…)
          Bot Delivery service: lọc theo membership + privacy + allowed_updates
                 → serialize JSON kiểu Bot API → per-bot queue (update_id seq, TTL 24h, queue_id)
                 ├─ long-poll endpoint (getUpdates)
                 └─ webhook workers (per-queue FIFO, backoff, secret header)
Bot API Gateway (HTTP /bot<token>/<method>, /file/bot<token>/<path>)
                 → auth token → map params → RPC core → map kết quả → {ok,result}
```

Các quyết định đi kèm:

- **Bot là user principal hạng nhất trong core.** Membership, quyền admin và message sender dùng chung bảng với user. Privacy filter và rate limit đặt ở core (đúng như Telegram đặt ở server MTProto), không đặt ở gateway, để sau này mọi client hay SDK native đều có cùng ngữ nghĩa.
- **Không tái dùng `tdlib/telegram-bot-api` làm runtime.** Muốn chạy nó, mình phải implement server MTProto, quá tốn kém. Nhưng license BSL-1.0 rất thoáng, nên được phép **port** các phần sau: thuật toán `WebhookActor`, semantics `TQueue`, và parser MarkdownV2/HTML trong `MessageEntity.cpp` của TDLib. Parser là chỗ dễ lệch hành vi nhất.
- **Queue theo bot cần bền** (Postgres partition theo ngày hoặc Redis Streams + TTL) và có sequence riêng mỗi bot để sinh `update_id`. Fan-out theo membership: một tin trong group có N bot thì sinh N update.
- **Một surface duy nhất.** Đừng làm cùng lúc "API riêng" và "API tương thích" vì đó là trùng lặp thật (DRY). Tính năng riêng của app đặt trong namespace mở rộng, ví dụ method có tiền tố `x` hoặc path `/ext/bot<token>/...`, và field mở rộng có tiền tố riêng để không đụng tên field Telegram sẽ thêm sau này.

## 5. Security

- **Token**: dạng `<bot_id>:<secret>`, ví dụ `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw` (D). Phần trái **phải là số và đúng bằng `getMe().id`**: aiogram `validate_token`/`extract_bot_id` tự tách id offline, server chính thức cũng làm vậy. Phần secret nên ≥ 35 ký tự `[A-Za-z0-9_-]` sinh bằng CSPRNG. Lưu hash và so sánh constant-time. Revoke token cũ thì trả 401 `Unauthorized`.
- **Khóa phái sinh**: Web App cần `secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)` (D). Nên **lưu sẵn `secret_key` phái sinh** cạnh hash token và tính lại khi xoay token, để không phải lưu token dạng rõ.
- **initData**: client app (vai trò "Telegram client") ký `data_check_string`, tức các cặp `key=value` sắp xếp alphabet, nối bằng `\n`, bỏ `hash`. Kết quả là `hash = hex(HMAC_SHA256(data_check_string, secret_key))`. initData được truyền qua fragment `#tgWebAppData=...&tgWebAppVersion=...&tgWebAppPlatform=...&tgWebAppThemeParams=...`. Bot backend nên kiểm tra thêm `auth_date`.
- **Ed25519 cho bên thứ ba** (D): `signature` = base64url(Ed25519) trên chuỗi `"<bot_id>:WebAppData\n" + các cặp đã sắp xếp (bỏ hash, signature)`. Mình phải tự sinh cặp khóa và công bố public key. **Cạm bẫy**: aiogram hardcode public key production của Telegram (`e7bf03a2…242d`) làm giá trị mặc định, nên bên thứ ba phải truyền key của mình một cách tường minh. Cần ghi rõ trong docs.
- **Rate limit** (FAQ, tức "soft", không có trong spec chính thức): 1 msg/s mỗi chat (cho burst ngắn), 20 msg/phút mỗi group, khoảng 30 msg/s broadcast toàn bot (Telegram cho tới 1000/s nếu trả phí). Khi vượt, trả HTTP 429, `description: "Too Many Requests: retry after N"` và `parameters.retry_after = N`. Các plugin auto-retry (grammY auto-retry, PTB `AIORateLimiter`, transport mới của node-telegram-bot-api) đọc đúng field này. Nên dùng token bucket ở core, key theo (bot), (bot, chat), (bot, group).
- **Privacy mode** (D, FAQ): mặc định bật. Bot chỉ nhận `/cmd@bot`; `/cmd` chung nếu bot là bot cuối cùng đã gửi tin; tin `via_bot`; reply tới tin của bot; mọi service message. Bot là admin hoặc đã tắt privacy thì thấy hết, **trừ tin của bot khác**. Nếu nhiều bot bật privacy thì mỗi tin chỉ đến một bot, và reply có ưu tiên cao nhất.
- **SSRF**: `setWebhook` và gửi file qua URL đều khiến server gọi ra URL do người dùng nhập. Telegram cloud chỉ cho port 443/80/88/8443 và IP public; bản local thì nới lỏng. Mình cần chặn dải IP private/link-local/metadata sau khi resolve DNS (chống DNS rebinding), giới hạn kích thước và timeout. Nếu là môi trường doanh nghiệp, có thể thêm allowlist nội bộ cho từng tenant.
- **Giới hạn file** (D): upload multipart tối đa 10 MB với ảnh và 50 MB với file khác; qua URL tối đa 5 MB và 20 MB; tải về tối đa 20 MB. Link `getFile` sống ≥1 giờ. Đây là con số của Telegram, mình tự chọn hạn mức nhưng phải trả lỗi cùng shape.
- **Flood khi tạo client**: server chính thức có flood control theo IP khi một token mới xuất hiện (S, `ClientManager.cpp`). Mình nên rate-limit request auth thất bại theo IP để chống dò token.

## 6. Các cạm bẫy tương thích (xếp từ khó nhất)

1. **Offset entity theo UTF-16 code unit** (D). Emoji ngoài BMP chiếm 2 unit, tiếng Việt dựng sẵn chiếm 1. Nếu core lưu rich text dạng HTML hoặc Markdown, hay tính offset theo code point/byte, thì mọi entity sẽ lệch ở lần chuyển đổi. **Khuyến nghị: core lưu `text + entities[]` với offset UTF-16 ngay từ đầu.** Telegram làm đúng như vậy, và thư viện client như grammY `fmt` hay PTB cũng tính theo UTF-16.
2. **Parser MarkdownV2/HTML**: quy tắc escape gồm 18 ký tự đặc biệt, escape riêng bên trong `pre`/`code`/link, nesting có điều kiện, `blockquote` không được lồng nhau. Thông báo lỗi kiểu `can't parse entities: ...` được bot ngoài thực tế bắt theo chuỗi. Nên port từ `MessageEntity.cpp` thay vì tự viết.
3. **Message object**: có khoảng 120 field optional. Chỉ `message_id`, `date`, `chat` là bắt buộc; `from` cũng optional. Thư viện dùng schema chặt (aiogram/pydantic) sẽ lỗi nếu thiếu field bắt buộc ở **type con**, ví dụ `User.id/is_bot/first_name` hay `Chat.id/type`. Khi không có dữ liệu, bỏ hẳn field optional thay vì trả `null`.
4. **Độ rộng ID**:
   - `User.id`/`Chat.id` cần ≤ 52 bit vì JS dùng `number`. Không dùng UUID; snowflake 64 bit cũng hỏng.
   - `message_id` và `update_id` cần ≤ 2^31−1 vì Java TelegramBots dùng `Integer`.
   - `message_id` là duy nhất **trong một chat** và tăng dần.
5. **Quy ước dấu `chat.id`** (S: `get_supergroup_chat_id = -1000000000000 - id`): user dương, basic group âm, supergroup/channel là `-100…`. Nhiều bot so prefix `-100`. **Khuyến nghị: không có type `group`**, mọi nhóm đều phát ra là `supergroup` với id `-(10^12 + gid)` và giữ `gid < 10^12`. Cách này tránh được luôn luồng migrate (`migrate_to_chat_id`/`ChatMigrated`).
6. **`file_id` / `file_unique_id`** (D): `file_id` là chuỗi opaque, **riêng cho từng bot**, một file có thể có nhiều `file_id`, và không đổi type khi gửi lại. `file_unique_id` ổn định qua thời gian và giữa các bot nhưng không dùng để tải được. Cách làm: `file_id` = token base64url có ký hoặc mã hóa, chứa (file_ref, bot_id, type); `file_unique_id` = hash ngắn của content id. Ảnh trả về dạng mảng `PhotoSize[]` nhiều kích thước, nên cần sinh thumbnail.
7. **Shape lỗi**: `{ok:false, error_code, description, parameters?}`. Thư viện ánh xạ lỗi theo HTTP code: 400 → BadRequest, 401/404 → InvalidToken/Unauthorized, 403 → Forbidden, 409 → Conflict, 429 → RetryAfter, 502 → server. Chuỗi `description` cũng là contract ngầm, ví dụ `Bad Request: chat not found`, `Forbidden: bot was blocked by the user`, `Bad Request: message is not modified`. Method lạ thì trả 404 `Not Found: method not found`.
8. **Định dạng request** (D): GET/POST; query string, form-urlencoded, JSON, multipart (`attach://<name>` cho media group); tên method không phân biệt hoa thường; tham số lạ phải **bị bỏ qua** để chịu được thư viện mới hơn spec của mình.
9. **Đếm độ dài** (4096 ký tự cho text, 1024 cho caption, "after entities parsing"): chưa rõ đơn vị đếm là code point hay UTF-16 unit, xem Unresolved.
10. **Tốc độ ra bản của upstream**: năm 2026 đã có 7 bản (9.4 đến 10.3). Thư viện bám theo nên luôn có field hoặc method mới mà server mình chưa có. Điều này không gây vỡ nếu mình bỏ qua tham số lạ và client bỏ qua field thiếu.

### Hỗ trợ đổi base URL (đã đọc source)

| Thư viện | Cách override | Ghi chú / rủi ro |
|---|---|---|
| grammY v1.46.0 | `new Bot(t, { client: { apiRoot, buildUrl?, environment } })` | Hoạt động tốt, phát hành 2026-08 |
| python-telegram-bot v22.8 | `base_url` (hỗ trợ `{token}`), `base_file_url`, `local_mode` | LGPLv3, rất phổ biến (29.5k★) |
| aiogram v3.31.0 | `AiohttpSession(api=TelegramAPIServer.from_base(url))` | Token phải dạng `<số>:<…>` |
| Telegraf v4.16.3 | `new Telegraf(t, { telegram: { apiRoot } })` | **Bản phát hành cuối 2024-02**, nguy cơ bị bỏ rơi; `webhookReply` mặc định bật |
| node-telegram-bot-api v2.2.0-rc2 | `apiRoot` (transport mới viết bằng TS) | Đang viết lại, API có thể còn đổi |
| go-telegram-bot-api | `NewBotAPIWithAPIEndpoint(t, "https://host/bot%s/%s")`, `FileEndpoint` | Push cuối 2024-08, ít bảo trì |
| go-telegram/bot | `bot.WithServerURL(url)` | Còn hoạt động |
| Java TelegramBots | Có `TelegramUrl` (chưa đọc chi tiết) | Dùng `Integer` cho message_id/update_id |

Tiền lệ: **Bale** (messenger Iran) công bố Bot API "dựa trên Telegram với thay đổi nhỏ" tại `tapi.bale.ai/bot<token>/METHOD`. Bale chỉ hỗ trợ một tập con (4 loại update, ít loại entity) và vẫn dùng được thư viện Telegram. Điều này cho thấy chiến lược tập con khả thi về mặt thương mại.

## 7. Kế hoạch conformance testing

Xếp theo tỉ lệ giá trị trên chi phí:

1. **Schema conformance (rẻ nhất, chạy CI mỗi PR)**: sinh JSON Schema từ `telegram-bot-api-spec/api.json`, ghim bản 10.3. Validate mọi response và update của server mình: field bắt buộc có mặt, kiểu đúng, không phát field ngoài spec trừ khi có tiền tố mở rộng. Duy trì danh sách method/type được hỗ trợ dưới dạng manifest để test sinh ra từ đó.
2. **Contract test viết tay cho update delivery**: offset/confirm, offset âm, 409 khi chạy song song, TTL, `allowed_updates`, webhook 2xx/5xx/410/`Retry-After`, FIFO theo chat, secret header, webhook reply. Đây là phần thư viện không test được giúp mình.
3. **Golden test cho parser**: chạy cùng bộ input MarkdownV2/HTML (có emoji, tiếng Việt, entity lồng nhau, chuỗi lỗi) qua parser của mình và qua `api.telegram.org` thật bằng một bot test. Ghi lại `entities` cùng thông báo lỗi làm golden file. Cách này cần một tài khoản bot Telegram và chỉ chạy offline khi cập nhật golden.
4. **Ma trận thư viện × kịch bản (E2E)**: với mỗi thư viện grammY, PTB, aiogram, Telegraf, node-telegram-bot-api, go-telegram/bot, viết cùng một "echo + keyboard + callback + file + command" bot từ example chính thức của thư viện, trỏ `apiRoot` vào server. Thêm một **user simulator** dùng API client của app (tham khảo cách jehy/telegram-test-api giả lập user) để gửi tin, bấm nút, upload file rồi assert phản hồi. Chạy cả hai chế độ long-poll và webhook.
5. **Chạy test suite online của PTB (tùy chọn, tốn công)**: `tests/auxil/pytest_classes.make_bot(**kwargs)` cho phép chèn `base_url`. Fixture bot đọc từ biến `BOTS` (base64 JSON gồm `token`, `chat_id`, `super_group_id`, `forum_group_id`, `channel_id`), nên có thể seed server mình bằng dữ liệu tương ứng. Nhiều test phụ thuộc sticker set, file và payment của Telegram, nên chỉ chọn các module Tier 0 bằng `-k`. Test của aiogram và grammY chủ yếu dùng mock session nên **không** dùng làm conformance được.

## 8. Khuyến nghị (đã xếp hạng)

| Hạng | Phương án | Hiệu năng | Độ phức tạp | Bảo trì | Hệ sinh thái | Rủi ro |
|---|---|---|---|---|---|---|
| **1** | **Tương thích Telegram, tập con ghim 10.3 + namespace mở rộng** | Tốt, gateway mỏng trên core | Trung bình, phần khó dồn vào data model core | Tự quyết khi nào nâng bản; bỏ qua tham số lạ | Dùng ngay ~8 thư viện, tutorial, kỹ năng có sẵn của dev | Lệch hành vi ngầm (parser, chuỗi lỗi); cần conformance suite |
| 2 | API riêng (REST/gRPC/WebSocket), làm adapter Telegram sau | Tốt | Thấp lúc đầu, cao về sau (2 surface) | Phải tự viết và bảo trì SDK nhiều ngôn ngữ | Bằng 0 lúc ra mắt | Adapter về sau đụng đúng những ràng buộc data model trên, nếu core không chuẩn bị thì phải refactor |
| 3 | Parity đầy đủ Bot API | — | Rất cao (185 method, 400 type, ~1 bản/tháng) | Đuổi theo upstream mãi | Tối đa | Không khả thi; buộc core sao chép toàn bộ sản phẩm Telegram |

Lý do chọn phương án 1: hệ sinh thái có sẵn mang lại giá trị lớn nhất cho bot platform. Chi phí thực sự là các ràng buộc data model ở mục 6, và phương án 2 cũng sẽ phải trả chi phí đó khi muốn tương thích. Phạm vi v1 đề xuất: toàn bộ Tier 0, cộng deep link và Web Apps của Tier 1. Các mục Tier 1 khác bật theo tính năng có trong core. Phương án 1 phù hợp với dự án vì repo đang trống, chưa có data model, nên chốt ràng buộc bây giờ gần như không tốn gì. Rủi ro áp dụng của Bot API thấp: spec có từ 2015 và phần lớn thay đổi chỉ thêm mới, nhưng thỉnh thoảng vẫn có thay đổi phá vỡ. Ví dụ, bản 10.3 thay `receiver_user_id`/`callback_query_id` bằng `ephemeral_message_parameters`. Vì vậy phải ghim phiên bản. Rủi ro nằm ở chọn thư viện mẫu: tránh lấy Telegraf và go-telegram-bot-api làm thư viện "khuyến nghị" trong docs vì cả hai ít bảo trì.

Hạng mục việc theo tier độ phức tạp: core data model ràng buộc (M), Bot Delivery + queue (L), Gateway Tier 0 (L), parser port (M), Web App host bridge ở client (M), conformance suite (M).

## 9. Giới hạn của research

- Chưa đọc `Client.cpp` từng method; mới đọc phần update, queue, lỗi và token. Mapping chi tiết từng method sang JSON sẽ làm lúc lập kế hoạch.
- Chưa benchmark. Các số rate limit lấy từ FAQ là "soft", Telegram có thể đổi mà không báo.
- Tài liệu Bale đọc qua bộ tóm tắt (tiếng Ba Tư), nên chỉ coi là tiền lệ, chưa kiểm chứng mức tương thích thực tế.
- Không đánh giá MTProto, client-side API hay E2E encryption, vì nằm ngoài phạm vi bot.
- Java TelegramBots: chưa đọc cơ chế override URL cụ thể.

## Unresolved questions

1. Giới hạn 4096/1024 "ký tự" của Telegram đếm theo code point hay UTF-16 unit? Cần xác minh bằng golden test với api.telegram.org hoặc đọc phần kiểm tra độ dài trong TDLib `MessagesManager`.
2. Có dùng được `telegram-web-app.js` (tải từ telegram.org, không ghi license) trong Mini App của bên thứ ba khi chạy trên app mình không? Hay phải khuyến nghị tma.js (MIT, 1.2k★), vốn implement cùng giao thức `postEvent`? Cần xem xét pháp lý.
3. Sản phẩm có cần phân biệt group thường và supergroup không? Khuyến nghị là không, mọi nhóm đều là `supergroup`; cần product xác nhận.
4. Bot có được hoạt động trong chat E2E-encrypted không (nếu app có tính năng này)? Telegram không cho bot vào secret chat.
5. Webhook tới địa chỉ nội bộ (on-prem/doanh nghiệp) có phải yêu cầu không? Câu trả lời quyết định chính sách SSRF allowlist.
6. Có cần UI tạo bot dạng "BotFather bot" (bot quản trị trong chat) để quen tay người dùng Telegram, hay chỉ cần trang developer console? Đây là quyết định sản phẩm.
7. Khu vực thanh toán (Tier 2) có nằm trong roadmap không? Nếu có, phải map `provider_token` sang VNPay/MoMo, và việc này nên nghiên cứu riêng.
