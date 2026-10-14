# Backend Go

Một binary `server`, chạy theo `-role`. Quyết định: [ADR 0006](../docs/adr/0006-sign-in-and-chat-sessions.md) (đăng nhập, phiên), [ADR 0010](../docs/adr/0010-tenants-by-domain.md) (tenant), [ADR 0001](../docs/adr/0001-id-scheme.md) (id).

## Vai trò

| Lệnh | Việc |
|---|---|
| `server -role migrate [-env-file F]` | Áp các migration nhúng (`migrations/*.sql`, goose, có advisory lock) rồi thoát. Chỉ cần `DATABASE_URL`. |
| `server -role api [-env-file F]` | HTTP server: `/healthz`, `/auth/*`, Connect RPC dưới `/rpc/`, WebSocket realtime `/ws`. Dừng êm khi nhận SIGINT/SIGTERM (xem [Dừng êm](#dừng-êm)). |
| `gateway`, `worker`, `botapi`, `webhook` | Chưa có, thoát mã 1. Giai đoạn 1 (một server) gateway chạy trong `api`, xem [Realtime](#realtime-ws). |

`-env-file` đọc dòng `KEY=VALUE` (bỏ dòng trống và dòng `#`, giá trị có thể nằm trong `'…'` hoặc `"…"`), không ghi đè biến đã có trong môi trường. Cấu hình thiếu hoặc sai thì thoát mã 1 và nêu tên biến, không in giá trị.

## Biến môi trường (`-role api`)

| Biến | Bắt buộc | Mặc định | Ghi chú |
|---|---|---|---|
| `CHAT_ENV` | có | | `production` hoặc `development` |
| `CHAT_LISTEN_ADDR` | | `127.0.0.1:4600` | `host:port` |
| `CHAT_PUBLIC_URL` | có | | Origin công khai, ví dụ `https://chat.hoandat.com`; production bắt buộc https. Redirect OIDC là `<CHAT_PUBLIC_URL>/auth/callback`, post-logout là `<CHAT_PUBLIC_URL>/`. |
| `DATABASE_URL` | có | | URL PostgreSQL 16 (pgx). Pool tối đa 10 kết nối, trừ khi URL tự đặt `pool_max_conns`. |
| `OIDC_ISSUER` | có | | Ví dụ `https://auth.hoandat.com`; production bắt buộc https. Mọi endpoint lấy từ discovery. |
| `OIDC_CLIENT_ID` | có | | `chat-web` |
| `OIDC_CLIENT_SECRET` | có | | Secret `client_secret_basic` |
| `SESSION_KEY` | có | | Base64 (thường hoặc URL-safe), ≥ 32 byte. Khoá gốc AES-256-GCM cho refresh/ID token của IdP trong DB và cookie đăng nhập. Đổi khoá làm mọi phiên đang có bị thu hồi ở lần kiểm grant kế tiếp. |
| `TENANT_ID` | | `primary` | |
| `TENANT_DOMAIN` | | `hoandat.com` | Cũng là tên tenant trả trong `GetAuthConfig` |
| `DEV_ORIGINS` | | | Danh sách origin cách nhau bằng dấu phẩy, chỉ dùng khi `CHAT_ENV=development` |
| `CHAT_OPERATOR_USER_IDS` | | (trống) | User id (cách nhau bằng dấu phẩy, tối đa 100) được dùng `ModerationService`; trống thì không ai. Cách cấp: [deployment guide](../docs/deployment-guide.md#tài-khoản-vận-hành-kiểm-duyệt) |
| `APP_URL_SCHEME` | | `com.hoandat.chat` | Scheme riêng của app được phép trong link của tin (ADR 0004), khớp `urlScheme` của `brand.config.json`; không được là `http`/`https` |

Server nghe trên loopback sau nginx: `X-Real-IP` chỉ được tin khi peer là loopback, nên nginx cần `proxy_set_header X-Real-IP $remote_addr;`.

## Route HTTP

| Route | Việc |
|---|---|
| `GET /healthz` | `{"status":"ok","db":"connected"}`; 503 khi DB không trả lời |
| `GET /auth/login[?locale=en\|vi\|zh-CN][&prompt=create][&return_to=/đường-dẫn]` | Đặt cookie `__Host-chat_login` (SameSite=Lax, 10 phút, niêm phong state/nonce/PKCE verifier/locale/`return_to`) rồi 302 tới IdP. `return_to` chỉ nhận đường dẫn cùng origin: bắt đầu bằng đúng một `/` (không `//`), không có `\`, khoảng trắng hay ký tự điều khiển, không có scheme/host, không trỏ vào `/auth/`, tối đa 512 byte; sai thì bỏ qua (về `/`) |
| `GET /auth/callback` | Kiểm state, đổi code, xác minh ID token (iss, aud, ES256, nonce), tạo/cập nhật user, tạo phiên, đặt cookie `__Host-chat_session` (HttpOnly, Secure, SameSite=Strict, 90 ngày) và trả trang trung gian 200 `<meta http-equiv="refresh" content="0;url=/">` (hoặc tới `return_to` đã lưu trong cookie đăng nhập; link "Thử lại" của trang lỗi giữ `return_to`). Lỗi trả trang có link "Thử lại": 400 (state, nonce, code), 503 (IdP chưa sẵn sàng), 500 (lỗi nội bộ). |
| `POST /auth/logout` | Cần `Origin` trong allowlist (403 nếu không). Thu hồi phiên và refresh token ở IdP, xoá cookie, 303 tới `end_session_endpoint` với `id_token_hint`, `client_id`, `post_logout_redirect_uri`; không có phiên thì 303 về `/`. |
| `POST /auth/backchannel-logout` | Form `logout_token`; 200 khi đã xử lý, 400 khi token sai hoặc phát lại `jti`, 503 khi IdP chưa discovery |
| `/rpc/app.v1.<Service>/<Method>` | Connect: `AuthService`, `UsersService`, `ConfigService`, `ChatsService`, `MessagesService`, `UpdatesService`, `ModerationService` |
| `GET /ws` | WebSocket realtime, xem [Realtime](#realtime-ws) |

Mọi RPC cần `Origin` trong allowlist (`CHAT_PUBLIC_URL`, cộng `DEV_ORIGINS` khi development), nếu không trả `permission_denied`. Trừ `GetAuthConfig`, `ExchangeNativeCode` và `GetAppConfig`, mọi RPC cần cookie phiên, nếu không trả `unauthenticated`. Còn `unimplemented`: `ExchangeNativeCode` (app native), `SendMedia`, `SendAlbum` (media, R3), `PressInlineButton` (bot, R5), ảnh hồ sơ và ảnh chat, cùng `MediaService`, `SearchService`, `BotsService`.

## Nhắn tin (package `internal/chat`)

- Mỗi thao tác ghi chạy trong một transaction: khoá dòng chat, cấp `seq`, ghi tin, ghi update vào nhật ký từng thành viên (chat `small`, `pts` cấp bằng một câu `INSERT … ON CONFLICT` theo thứ tự `user_id`) hoặc nhật ký riêng của chat (`large`, `chat_pts`), rồi ghi một dòng `outbox`. Thứ tự khoá luôn là dòng chat → `chat_members` (theo `user_id`) → `user_state` (theo `user_id`), nên các chat có thành viên chung không deadlock. Lỗi deadlock/serialization được thử lại tối đa 3 lần.
- Update trong nhật ký lưu tin dưới dạng địa chỉ `(chat_id, seq)`; tin được dựng lại từ bảng `messages` khi đọc (`GetDifference`, `GetChatDifference`) và khi giao realtime, theo đúng người xem (`random_id` chỉ cho người gửi, `chosen` của reaction theo người xem). Tin đã xoá cho mọi người hoặc đã ẩn với người xem để lại update rỗng giữ nguyên `pts`, nên nội dung đã xoá không bao giờ được phát lại.
- Nội dung chỉ tới người được thấy: tin có `seq` dưới `visible_from_seq` của người xem (lịch sử `since_join`) không bao giờ được dựng (kể cả sửa, reaction, xem trước link gắn sau); sửa và reaction chỉ ghi vào nhật ký của thành viên thấy được tin đó. Người đã rời (hoặc bị xoá) chỉ còn thấy tin tới `left_seq` (seq cuối lúc rời) và chưa đổi sau lúc rời (`messages.changed_at`), không nhận reaction nữa; người chưa từng là thành viên không nhận gì. Nhật ký riêng của chat `large` chỉ tới socket của thành viên hiện tại.
- `random_id` khác 0 chống gửi trùng (bảng `send_dedupe`, 7 ngày): gửi lại trả đúng tin và `SyncAck` lần đầu; dùng lại ở chat khác trả `invalid_argument`.
- Chat chuyển một chiều sang `large` khi số thành viên vượt 200 (ADR 0002): mọi thành viên nhận `chat_mode_changed` kèm `chat_pts` gốc trong cùng transaction.
- Đếm chưa đọc (dialog, topic, `read`) dừng ở 1000 (client hiện "999+"); `GetDialogs`/`GetPeerDialogs` lấy tin mới nhất và số chưa đọc của mọi chat trong một câu mỗi loại, và mọi lần tải tin/reaction/ẩn cho nhiều chat cũng một câu. `unread_mentions_count` đếm tin chưa đọc nhắc tới người xem (`@username`, mention theo id) hoặc trả lời tin của họ (bảng `message_mentions`, ghi khi gửi và khi sửa; chat riêng và tin chuyển tiếp không tính), cùng giới hạn 1000.
- Đã đọc: `ReadHistory` ghi `read` (inbox) cho người đọc kèm `unread_count` toàn chat, `top_seq` (seq mới nhất lúc đếm), `chat_pts` (chat `large`) và với topic: `topic_id`, `topic_unread_count`; số đếm lấy sau khi cấp `pts`, nên khớp với thứ tự nhật ký. Ở chat `small`, tác giả của các tin vừa được đọc nhận `read` (outbox). Người mới vào nhận `read` ở vị trí lúc vào, nên lịch sử trước đó không tính là chưa đọc.
- Topic (nhóm có `forum`): topic 1 là "General", tạo khi bật forum; tin gửi không kèm topic vào General; khi bật forum, tin cũ và vị trí đã đọc chuyển sang General; forum không tắt được. Thành viên có quyền `MANAGE_TOPICS` tạo topic (tối đa 1000 topic mỗi nhóm, 10 rồi 1 mỗi 6 giây mỗi người) và sửa topic của mình; admin ghim, đóng (chỉ admin gửi được vào topic đóng), ẩn topic (topic ẩn vẫn có trong `GetForumTopics` với `hidden`). Topic có `icon` (tên glyph trong bộ icon của client, `^[a-z][a-z0-9-]{0,31}$`) và `message_count` (tin chưa xoá). `GetForumTopics` phân trang (mặc định 100, tối đa 500, cursor theo thứ tự ghim, tin mới nhất, id). `ReadHistory` với topic 0 chỉ ghi vị trí cho các topic còn tin chưa đọc.
- Quyền riêng tư: "danh bạ" (`CONTACTS`) của một người là danh sách liên hệ **của chính người đó** (bảng `contacts`, `AddContact`/`DeleteContact`/`GetContacts`); có chung chat không còn tính. Mặc định: thêm vào nhóm = danh bạ, nhắn tin = mọi người, tìm theo email = không ai, tìm theo username = mọi người, last seen = danh bạ. `AddContact` theo id chỉ với người đã thấy được (luật `GetUsers`), theo `@username`/email chỉ khi `find_by_username`/`find_by_email` của người kia cho phép; ngược lại trả `not_found` như user không tồn tại. `ResolveUsername` cũng áp `find_by_username`. `send_messages` áp khi mở chat riêng mới; chat riêng đã có vẫn nhắn được trừ khi bị chặn. Người bị chặn không mở được chat riêng, không gửi hay thả reaction được trong chat riêng, không thêm được người chặn vào nhóm, không thấy last seen/online, presence và typing của người chặn (typing không đi theo chiều nào khi có chặn).
- `GetUsers` chỉ trả chính mình, người có chung một chat mình đang ở (người kia ở trạng thái nào cũng được, để tên tác giả tin cũ vẫn hiện), người trong danh bạ của mình và người có mình trong danh bạ; id khác bị bỏ qua như id không tồn tại, nên không dò được user của tenant bằng id.
- Thành viên: kênh chỉ admin xem được danh sách thành viên. Xoá thành viên (`RemoveMember`) mặc định kèm cấm (`ban` không đặt hoặc `true`): người đó không vào lại được bằng link mời nào, không được thành viên thường thêm lại (admin thêm lại thì gỡ cấm), link mời họ tạo trong chat bị thu hồi; `UnbanMember`, `GetBannedMembers` (admin). `ban = false` chỉ xoá. Chủ chat rời đi thì quyền chủ chuyển cho admin lâu năm nhất; còn thành viên khác mà không có admin thì `LeaveChat` trả `failed_precondition` (message bắt đầu bằng `owner_needs_admin`, mã duy nhất `LeaveChat` trả loại này), áp cho cả nhóm và kênh; chủ chat là người cuối cùng thì rời được.
- Link mời: 128 bit ngẫu nhiên, dạng `<CHAT_PUBLIC_URL>/join/<token>`, hạn và số lượt tuỳ chọn; thành viên dùng lại link (kể cả link hết lượt) chỉ nhận lại chat. Link chỉ dùng được khi người tạo còn là thành viên có quyền mời; người bị cấm nhận `permission_denied`. `CheckInvite` của nhóm kèm tối đa 5 thành viên (admin trước) và `history_visibility`.
- Người đọc (`GetMessageReaders`): chỉ với tin người hỏi thấy được (không trước `visible_from_seq`, không bị ẩn), kèm thời điểm đọc của từng người (bảng `read_receipts`, ghi khi vị trí đọc di chuyển trong nhóm đủ nhỏ, giữ 7 ngày; lần đọc trước khi có bảng lấy lúc vị trí đổi gần nhất).
- Báo cáo (`UsersService.Report`) ghi vào bảng `reports` của tenant kèm bản sao nội dung tin bị báo cáo.
- Kiểm duyệt (`ModerationService`): chỉ user id trong `CHAT_OPERATOR_USER_IDS` (mặc định không ai; người khác nhận `permission_denied`; `GetSelf` trả `is_operator`). `GetReports` lọc theo trạng thái (mặc định đang mở), lý do, loại đối tượng, mới nhất trước, cursor theo id. `GetReport` trả bản sao tin lúc báo cáo, tin bị báo cáo cùng tối đa 5 tin trước và sau như hiện tại (tin đã xoá không còn nội dung), 20 dòng nhật ký gần nhất về người bị báo cáo và các lần khoá đang hiệu lực. `ResolveReport` đóng báo cáo đang mở (đã đóng trả `failed_precondition` `report_closed`) với một hoặc nhiều hành động và ghi chú bắt buộc: bỏ qua (đứng riêng), xoá tin cho mọi người, xoá và cấm tác giả khỏi chat (không áp cho chủ chat; thành viên nhận `member_removed` với `actor_id` 0, không có tin hệ thống), khoá tài khoản chat (thời hạn tới 366 ngày hoặc tới khi gỡ): thu hồi mọi phiên (lý do `ADMIN`) và trong lúc khoá không gửi, sửa, thả reaction, tạo hay vào chat, thêm thành viên, tạo link mời, tạo topic được (`permission_denied`, message bắt đầu bằng `account_restricted`). `LiftRestriction` gỡ khoá. Mọi hành động ghi vào `moderation_log`, chỉ thêm (trigger chặn sửa, xoá).
- Thiết lập dialog của riêng mỗi người: tắt tiếng (`SetDialogMute`: số giây 1 tới 366 ngày, hoặc `forever` = `mute_until` 2147483647; 0 là bật lại; `Dialog.mute_until` về 0 khi hết hạn) và ghim (`SetDialogPinned`, tối đa 5, quá thì `failed_precondition` `pinned_dialogs_limit`; `ReorderPinnedDialogs` nhận đúng tập đang ghim). Các phiên khác của người đó nhận `dialog_mute` và `pinned_dialogs` (cả danh sách ghim theo thứ tự). `GetDialogs` trang đầu trả mọi chat ghim (thứ tự ghim, thêm vào ngoài `limit`) cùng `pinned_chat_ids`, rồi các chat khác theo hoạt động mới nhất; trang sau không có chat ghim. Rời chat thì bỏ ghim. Badge tổng số chưa đọc bỏ chat tắt tiếng là việc của client.
- Xoá chat (`DeleteChat`): nhóm và kênh chỉ chủ xoá được, cho mọi người: mọi thành viên hiện tại nhận `chat_deleted` (`for_everyone`) trong nhật ký riêng, mọi dòng thành viên (cả người đã rời) và link mời bị xoá ngay nên không còn đường nào đọc được chat; tin và các bảng theo tin được việc nền mỗi giờ xoá hẳn. Chat riêng: chỉ xoá phía mình (lịch sử ẩn bằng `visible_from_seq`, không còn chưa đọc, bỏ khỏi danh sách và bỏ ghim tới khi có tin mới), các phiên khác nhận `chat_deleted` không có `for_everyone`.
- `LeaveChat` của chủ có `new_owner_id` (phải là admin hiện tại, ngược lại `invalid_argument`); 0 thì chuyển cho admin lâu năm nhất như trước.
- `AddMembers` và `CreateGroup` trả `failures` kèm lý do từng người: `NOT_FOUND`, `PRIVACY_ADD_TO_GROUPS`, `BLOCKED` (người đó chặn người thêm), `BANNED` (người thêm không phải admin), `ALREADY_MEMBER`, `TOO_MANY` (chat đủ 200.000 thành viên; vào bằng link khi đầy trả `failed_precondition` `chat_full`). `failed_user_ids` giữ nghĩa cũ (không gồm `ALREADY_MEMBER`).
- `GetMessageReactions`: ai thả reaction một tin, mới nhất trước, lọc theo một emoji, phân trang (mặc định 50, tối đa 100); chỉ thành viên hiện tại thấy được tin (không trước `visible_from_seq`, không bị ẩn, không phải tin hệ thống); kênh chỉ admin. `UsersService.GetBlockedUsers`: người mình đã chặn, chặn gần nhất trước (mặc định 50, tối đa 200). `GetContacts` trả thêm `contacts` (ngày thêm). `ChatsService.GetCommonChats`: nhóm cả hai đang ở và kênh người kia đang ở mà mình là admin, kèm tổng `count`, cursor theo chat id.
- Rate limit theo user, token bucket trong bộ nhớ (giai đoạn 1 một process; khi scale ngang thay bằng Redis): gửi tin 5/giây (burst 30), các thao tác ghi khác 5/giây (burst 30), tạo chat/link mời 10/phút, tham gia bằng link 12/phút, báo cáo 10/giờ, xem trước link, tìm user, `ResolveUsername` và `AddContact` theo username/email 1/giây (burst 20), tạo topic 1 mỗi 6 giây (burst 10); vượt trả `resource_exhausted`.

### Xem trước link (chỉ chữ)

Server lấy link web đầu tiên của tin (entity `url`/`text_link`, hoặc URL trần trong text) trừ khi người gửi đặt `no_link_preview`. Có sẵn trong cache thì gắn ngay khi gửi; chưa có thì lấy sau khi tin đã lưu và gắn bằng một `message_edit` không đặt `edit_date`. `GetLinkPreview` cho ô soạn tin. Chống SSRF ([`internal/linkpreview`](internal/linkpreview/fetch.go)): chỉ `http`/`https` không kèm thông tin đăng nhập, dạng chuẩn hoá tối đa 2048 byte (khoá cache); địa chỉ được kiểm **sau khi phân giải tên, đúng địa chỉ được kết nối** (chặn DNS rebinding), từ chối private, loopback, link-local, multicast, CGNAT, dải dành riêng, IPv4-compatible `::/96`, NAT64/6to4/Teredo và cả `2001::/23`, site-local `fec0::/10`, discard `100::/64`, tài liệu `2001:db8::/32`/`3fff::/20`, SRv6 `5f00::/16`; chỉ cổng 80, 443, 8080, 8443; không proxy; tối đa 3 lần chuyển hướng (mỗi lần kiểm lại), 5 giây, 512 KB, chỉ `text/html`. Đọc `og:site_name`, `og:title`, `og:description` (dự phòng `twitter:*`, `description`, `<title>`). Cache theo URL: có preview giữ 24 giờ, lỗi giữ 1 giờ.

## Realtime (`/ws`)

Gateway chạy trong process `api` (giai đoạn 1, một server, pm2 một instance): sau khi commit, chat service dựng update cho từng người nhận và đẩy thẳng vào hub trong bộ nhớ, không qua message bus. Khi chạy nhiều process, vai trò `Sink` của hub chuyển sang pub/sub (Redis rồi NATS) mà chat service không đổi.

- Handshake `GET /ws`: `Origin` phải trong allowlist (403 nếu không), cookie phiên hợp lệ (401 nếu không), kiểm trước khi upgrade. Frame protobuf nhị phân (`realtime.proto`), mỗi message WebSocket một frame. Client gửi `ClientHelloFrame` trong 10 giây; server đăng ký socket rồi mới trả `HelloFrame` (`server_epoch`, `heartbeat_interval_ms` = 25000), nên mọi update commit sau `Hello` đều tới socket; phần trước đó client lấy bằng `GetDifference`.
- Socket im lặng quá 55 giây bị đóng; `PingFrame` → `PongFrame` cùng `request_id`.
- Chat `large`: update của nhật ký chat chỉ tới socket đang mở hoặc đang hiển thị chat đó (`OpenChatFrame`, kiểm thành viên); thành viên online khác nhận `chat_activity` gộp mỗi giây.
- `OpenChatFrame` với chat không phải thành viên trả `ErrorFrame` `FORBIDDEN`; tối đa 5 frame/giây mỗi phiên (burst 20), vượt trả `RATE_LIMITED`. Typing chỉ cho chat đang mở, chỉ khi người gõ được gửi tin ở đó (kênh: chỉ admin) và không có chặn giữa hai người của chat riêng (kiểm lúc `OpenChat`; ngược lại `FORBIDDEN`), 1 frame/giây (burst 3), chỉ tới người khác đang mở chat đó, `user_id` do server đặt.
- Tối đa 10 socket mỗi phiên và 30 mỗi user; socket vượt bị đóng ngay sau `ClientHelloFrame` với mã 1008 `too many connections` (client lùi theo backoff). Presence: mở chat riêng thì nhận trạng thái của người kia; trạng thái đổi (socket foreground đầu tiên/cuối cùng) được gửi tới người kia đang mở chat riêng, theo quyền riêng tư `last_seen`.
- Hàng đợi gửi mỗi socket 256 frame; đầy thì gửi `ResyncFrame(BACKPRESSURE)` rồi đóng. Epoch đổi: `ResyncFrame(EPOCH_CHANGED)` cho mọi socket. Dừng server: `ResyncFrame(SERVER_RESTART)`.
- Thu hồi phiên (đăng xuất, thu hồi từ phiên khác, back-channel logout, kiểm grant) ghi `revoke_reason` và một trigger ghi `session_revoked` vào `outbox`; consumer outbox của gateway (quét mỗi 150 ms) gửi `SessionRevokedFrame` và đóng socket trong dưới 1 giây. Ngay sau khi đăng ký socket, gateway kiểm lại phiên trong DB (thu hồi xảy ra giữa handshake và lúc đăng ký thì bị bỏ lỡ ở outbox), rồi mỗi phút kiểm lại một lần (lưới an toàn); phiên không còn hiệu lực thì gửi `SessionRevokedFrame` (lý do lấy từ `revoke_reason`, hết hạn là `EXPIRED`) và đóng. Socket còn đóng khi phiên tới trần 90 ngày, và đánh dấu phiên hoạt động mỗi 10 phút.
- Consumer outbox realtime chỉ là lưới an toàn (ADR 0003): giao lại việc mà dispatcher sau commit bỏ lỡ (hàng đợi đầy) và các dòng ghi ngoài package `chat`; cursor nằm trong bộ nhớ vì socket không sống qua lần khởi động lại. Dispatcher và consumer giành quyền giao từng dòng bằng một tập id chung (chỉ bên thêm id trước được giao; id được nhớ ít nhất 1 phút sau khi cursor đi qua), nên một event không bao giờ được giao hai lần.

## Đăng xuất web

Web đăng xuất bằng một form `POST /auth/logout` (điều hướng cấp cao nhất, để trình duyệt theo redirect 303 tới IdP; `fetch` không theo được redirect khác origin). Nếu muốn gọi `AuthService.SignOut` trước (ví dụ để dọn dữ liệu local), `SignOut` chỉ thu hồi phiên và refresh token mà **không** xoá cookie; `/auth/logout` sau đó vẫn dùng cookie đó một lần để lấy ID token làm `id_token_hint`, rồi xoá cookie. ID token không bao giờ tới JavaScript.

Chỉ phiên tự thu hồi chính nó (request mang cookie của chính phiên đó: `SignOut`, hoặc `RevokeSession` với id của mình) mới giữ ID token cho bước trên. Phiên bị thu hồi từ phiên khác (`RevokeSession`, `RevokeOtherSessions`), do back-channel logout hay do kiểm grant thì mất luôn ID token, nên cookie bị đánh cắp của phiên đó không lấy được ID token qua `/auth/logout` (chỉ được redirect về `/`).

## Phiên và kiểm grant

- Token phiên: 32 byte ngẫu nhiên, base64url trong cookie; DB chỉ lưu SHA-256. Phiên trượt 30 ngày, trần 90 ngày; `last_seen_at` ghi tối đa mỗi phút.
- Khi một phiên được dùng mà lần kiểm grant trước đã quá 1 giờ, server refresh token IdP ở nền (không chặn request). Lần kiểm nhận phiên bằng một câu `UPDATE` đặt lease `user_sessions.grant_lease_until` (2 phút), gọi IdP **ngoài** mọi transaction, rồi chỉ ghi kết quả khi lease vẫn là của nó và phiên chưa bị thu hồi. Vì vậy hai request hay hai process không bao giờ gửi cùng một refresh token, và thu hồi phiên, đăng xuất, back-channel logout không phải chờ IdP. Process chết giữa chừng thì phiên được kiểm lại khi lease hết hạn.
- Mỗi process chạy tối đa 4 lần kiểm grant cùng lúc; khi đủ 4, request kế tiếp của phiên sẽ lên lịch lại.
- IdP (hoandat-auth) xoay refresh token ở mỗi lần refresh và huỷ cả grant khi một token đã dùng bị gửi lại. Nên khi token endpoint đã trả token mới, token đó luôn được lưu: kể cả khi không xác minh được ID token hay userinfo (khi đó chỉ không cập nhật email), và việc ghi DB dùng context tách riêng (5 giây) nên không hỏng khi hạn 20 giây của lần kiểm đã qua. Nếu phiên bị thu hồi trong lúc chờ IdP, token mới không được lưu mà bị thu hồi ở IdP.
- `invalid_grant` thu hồi phiên; lỗi mạng, 5xx, 408, 429 giữ phiên và thử lại sau 5 phút (log `Warn`). Lỗi 4xx khác (`invalid_client`, `unauthorized_client`…) cũng giữ phiên và thử lại sau 5 phút, nhưng log mức `Error` với thông điệp `IdP rejected the refresh request; check the OIDC client registration and secret` (chỉ kèm status và mã lỗi OAuth, không kèm body hay token): đây là lỗi cấu hình client, cần người vận hành sửa. Refresh thành công cập nhật email theo IdP.
- User-Agent lưu cùng phiên được chuẩn hoá thành UTF-8 hợp lệ, bỏ byte NUL, và cắt tối đa 512 byte tại ranh giới ký tự.

## Việc nền của `-role api`

Thuê số worker Snowflake (gia hạn 15 giây, ngừng cấp id nếu 40 giây không gia hạn được), consumer outbox realtime (150 ms), gửi `chat_activity` gộp (1 giây), đọc lại `server_epoch` (30 giây), và mỗi giờ: tạo partition nhật ký và outbox (tạo trước 30 ngày, một transaction riêng, `chat_create_day_partitions`; log `Warn` khi còn dưới 7 ngày phía trước), rồi xoá partition quá 30 ngày bằng `ALTER TABLE … DETACH PARTITION … CONCURRENTLY` rồi `DROP TABLE`, mỗi câu một transaction riêng (lần detach dở dang được `FINALIZE`, bảng đã detach mà chưa xoá thì xoá), dọn `send_dedupe` (7 ngày), `read_receipts` (7 ngày), tin của chat đã bị xoá cho mọi người (cùng reaction, tin ẩn, mention, ghim, read receipt, topic; xoá theo lô 5.000 tin), cache xem trước link (7 ngày), `jti` logout hết hạn.

## Dừng êm

Khi nhận SIGINT/SIGTERM, `-role api` dừng nhận kết nối mới, chờ request đang chạy tối đa 20 giây, gửi `ResyncFrame(SERVER_RESTART)` và đóng mọi socket (tối đa 5 giây), dừng việc nền, chờ các lần lấy xem trước link đang chạy (tối đa khoảng 7 giây) và hàng đợi giao realtime, rồi chờ các việc nền với IdP (kiểm grant, thu hồi token ở IdP) xong hẳn, kể cả việc được tạo trong lúc chờ, trước khi đóng DB. Một lần kiểm grant bắt đầu muộn nhất ở cuối bước chờ request cần tối đa 20 giây chờ IdP, 5 giây ghi kết quả và 5 giây thu hồi token không lưu được, tức 30 giây (`auth.ShutdownBudget`).

**Tổng ngân sách dừng: tối đa 62 giây.** Đặt `kill_timeout` của pm2 lớn hơn, ví dụ `70000` (ms); nếu process bị kill giữa lúc IdP đã xoay token mà chưa ghi DB, phiên đó sẽ bị thu hồi ở lần kiểm grant sau.
- IdP sập lúc khởi động: server vẫn chạy và phục vụ phiên đang có; discovery thử lại với backoff tới 1 phút, trong lúc đó đăng nhập trả 503.

## Phát triển

```bash
go test -race ./...    # test DB dùng embedded-postgres (PG 16), không cần Docker
golangci-lint run ./...
```

Lần chạy đầu tải binary PostgreSQL vào `~/.embedded-postgres-go` và giải nén một lần; không tải được thì test cần DB tự skip kèm lý do.

Test end-to-end realtime ở [`internal/api/realtime_test.go`](internal/api/realtime_test.go): hai user đăng nhập qua IdP giả, tạo nhóm có topic, gửi/sửa/xoá/reaction/đọc qua RPC và nhận update qua WebSocket thật theo đúng thứ tự `pts`; thu hồi phiên đóng socket dưới 1 giây; xem trước link với một server cục bộ và từ chối IP private. Tính đúng của đồng bộ ở [`internal/chat/sync_test.go`](internal/chat/sync_test.go): 1.000 tin song song vào một chat, gửi lại 100 lần cùng `random_id`, 20 chat 150 thành viên chồng chéo không deadlock, chuyển `large` giữa luồng gửi, `too_long`/epoch, cách ly tenant, outbox sweeper.
