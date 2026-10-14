# Nghiên cứu backend chat kiểu Telegram: sync, lưu trữ, realtime và tìm kiếm tiếng Việt

Ngày: 2026-10-13 (Asia/Saigon) · Phạm vi: greenfield, repo `chat-inet` đang trống · Người viết: researcher

## 0. Kết luận chính (đọc phần này trước)

1. **Sync:** dùng mô hình lai giống Telegram. Mỗi user có một **update log với `pts` tăng đơn điệu** cho DM và nhóm nhỏ (ghi fan-out cho từng thành viên). Nhóm lớn và channel có **`pts` riêng theo chat** (fan-out on read). Đường realtime chỉ là best-effort; tính đúng đắn nằm ở log + `getDifference`. Không chọn mô hình Matrix per-room `/sync` vì nó đẩy độ phức tạp "phòng nào thay đổi kể từ X" lên server, và chính Matrix đã phải làm lại thành Sliding Sync.
2. **ID:** dùng **Snowflake `message_uid`** làm khóa nội bộ, cộng với **`seq` tăng đơn điệu theo từng chat** làm khóa thứ tự và phân trang mà client nhìn thấy. Gửi idempotent bằng `random_id` do client sinh, có unique constraint `(sender_id, random_id)`.
3. **Gateway:** dùng **Go** (xếp hạng 1) với WebSocket nhị phân (protobuf). Elixir/Phoenix tốt nhất về kỹ thuật cho presence và pub/sub nhưng rủi ro tuyển người. Rust để dành cho data service nóng khi scale. Node uWS xếp cuối.
4. **Lưu trữ:** **PostgreSQL** cho v1. Bảng `messages` hash-partition theo `chat_id`, bảng `user_updates` range-partition theo thời gian để xóa theo retention. Mọi truy cập tin nhắn đi qua một "message store" interface để sau này chuyển phần nóng sang shard, hoặc sang ScyllaDB/Cassandra, mà không đụng nghiệp vụ. Media lưu S3-compatible, upload bằng presigned URL, phát qua CDN.
5. **Search:** dùng **transactional outbox → indexer → engine**. Engine là dữ liệu dẫn xuất, rebuild được từ Postgres.
   - **v1:** Meilisearch CE. Đã kiểm tra trong mã nguồn rằng nó bỏ dấu tiếng Việt (gồm cả `đ→d`), và có sẵn prefix và typo.
   - **Khi scale:** OpenSearch với `asciifolding(preserve_original)`, chia cell theo cách của Discord.
   - **ACL:** lọc lúc query theo `chat_id IN (các chat user là thành viên)`, sau đó **kiểm lại quyền trên Postgres** trước khi trả kết quả.
6. **Ngân sách độ trễ:**
   - Gửi rồi nhận ack: p50 ≤ 60 ms, p99 ≤ 250 ms.
   - Giao end-to-end khi người nhận online: p50 ≤ 150 ms, p99 ≤ 500 ms.
   - Mở chat lấy từ cache local: ≤ 100 ms, không cần mạng.
   - Search: p50 ≤ 100 ms, p99 ≤ 500 ms.
   - Đặt server tại VN (HN/HCM) là đòn bẩy độ trễ lớn nhất.

## 1. Teamgram server (tham chiếu mã nguồn)

- Repo `github.com/teamgram/teamgram-server`, commit **`708fb9536f60e15d9bf4f1c302aa4251bfefab19`** (2026-08-04), license **Apache-2.0**, khoảng 2.3k stars. Mã nguồn chỉ được đọc, không chạy.
- **Phân rã dịch vụ** (`specs/architecture.md`):
  - `gnetway`: gateway MTProto qua TCP và WebSocket.
  - `session`: trạng thái kết nối và auth.
  - `bff`: chuyển MTProto RPC thành gRPC.
  - `biz`: user, chat, dialog, message, updates.
  - `msg`: gồm `inbox`, lo lưu và phát tin.
  - `sync`: đồng bộ multi-device.
  - `dfs` / `media`: file và media.
  - `idgen`, `status` (online), `authsession`.
  - Service discovery qua etcd. Tổng cộng khoảng 12 process.
- **Hạ tầng:** MySQL 8, Redis, etcd, Kafka (topics `Inbox-T`, `Sync-T`, `Push-T`), MinIO. Elasticsearch chỉ dùng cho log.
- **Lưu trữ:**
  - Bảng `messages` là hộp thư **theo từng user** (`user_id`, `user_message_box_id`, `dialog_message_id`, `random_id`), shard bằng tên bảng `messages_<id % N>`. Đây là fan-out on write đúng như cách Telegram làm cho DM và basic group.
  - Bảng `user_pts_updates(user_id, pts, pts_count, update_type, update_data json)` là update log. Có hàm `CheckPtsContinuity` để phát hiện lỗ hổng pts.
  - `idgen` dùng Snowflake (`bwmarrin/snowflake`) cộng **Redis `INCRBY`** để cấp seq/pts.
  - `outbox.go` dedupe theo `SelectByRandomId`.
- **Điểm yếu cần tránh:**
  - Search chỉ là `message LIKE :q` trên MySQL (`messages.xml` dòng 338 và 356), nên không có FTS, không bỏ dấu, không dùng được làm tham chiếu search.
  - Bản OSS chưa có channel/megagroup (README ghi là roadmap).
  - Pts cấp bằng Redis nằm ngoài transaction DB, nên lỗi giữa chừng sẽ để lại lỗ pts.
- **Bài học:** sao chép **ngữ nghĩa sync** (pts, `getDifference`, `random_id`). **Không** sao chép kiểu chia 12 service cho v1. Một modular monolith bằng Go cộng gateway riêng là đủ, và tách dần theo đúng các ranh giới module này.

## 2. Mô hình sync

**Cơ chế của Telegram** (core.telegram.org/api/updates):
- Mỗi sự kiện có `pts` tăng dần. **DM và basic group dùng chung một sequence cho mỗi user. Mỗi channel/supergroup có box và `pts` riêng.**
- Client so `local_pts + pts_count` với `pts`:
  - bằng nhau thì áp dụng;
  - lớn hơn thì là bản trùng, bỏ qua;
  - nhỏ hơn thì có lỗ: **chờ tối đa 0,5 s**, rồi gọi `updates.getDifference` (hoặc `getChannelDifference` cho channel).
- Kết quả có thể trả theo lát (`differenceSlice`, hoặc `final=false`). Nếu quá cũ thì trả `differenceTooLong`, và client tải lại trạng thái box.
- Basic group tối đa 200 thành viên, supergroup tối đa 200.000, channel không giới hạn (core.telegram.org/api/channel).

**Cơ chế của Matrix** (spec `/sync`):
- Long-poll với `since`/`next_batch`.
- Khi có quá nhiều sự kiện, server trả timeline "limited", tạo **gap** mà client phải tự lấp bằng `/rooms/{id}/messages`, và phải dedupe theo `event_id`.
- Sliding Sync (MSC4186) được SCT chấp nhận vào tháng 7/2026, nhưng các extension chưa được chấp nhận. Đây là dấu hiệu `/sync` gốc không đủ nhanh cho client di động (Element X).

| Tiêu chí | Per-user pts log (Telegram) | Per-room stream (Matrix) | **Lai: per-user cho DM/nhóm nhỏ + per-chat cho nhóm lớn** |
|---|---|---|---|
| Phát hiện gap | O(1) mỗi update | Phải theo dõi theo phòng, gap ngầm qua `limited` | O(1), cộng một pts cho mỗi chat lớn đang mở |
| Bắt kịp khi offline | 1 query: `WHERE user_id=? AND pts>? ORDER BY pts LIMIT n` | Server phải tính phòng nào đổi | 1 query cho log user, cộng hint "chat X có tin mới đến seq S" |
| Chi phí ghi | ×số thành viên (tệ với nhóm 100k) | ×1 | ×thành viên chỉ khi ≤ ngưỡng (200), ×1 khi lớn hơn |
| Multi-device | Mỗi device giữ `local_pts` riêng trên cùng một log | Mỗi device giữ token riêng | Như Telegram |
| Độ phức tạp | Thấp | Cao (state resolution, federation) | Trung bình (hai chế độ, có migrate khi vượt ngưỡng) |
| **Xếp hạng** | 2 | 3 | **1** |

**Thiết kế khuyến nghị:**
- `user_state(user_id, pts, date)`. Cấp pts **trong cùng transaction** với insert update: `UPDATE user_state SET pts=pts+$n ... RETURNING pts`. Khóa dòng theo từng user là đủ ở tốc độ chat và không tạo lỗ, khác với Redis INCR.
- `user_updates(user_id, pts, pts_count, type, payload, created_at)`, PK `(user_id, pts)`, partition theo ngày hoặc tuần. Retention 14–30 ngày: xóa partition cũ, sau mốc đó trả `differenceTooLong`.
- Những gì vào log: tin mới, sửa, xóa, đã đọc (`read_inbox_max_seq`), thay đổi dialog (pin, mute, folder). Vì đã đọc nằm trong log, **trạng thái đọc tự đồng bộ giữa các thiết bị**.
- Những gì **không** vào log: typing, presence. Đây là sự kiện tạm thời, gửi qua pub/sub và mất cũng không sao.
- Đường realtime: gateway đẩy update kèm `pts`/`pts_count` tới **mọi session đang online** của user. Mất gói không sao, vì client sẽ phát hiện gap và gọi `getDifference`.
- Khi kết nối lại, client **luôn** gọi `getDifference(pts)` trước, rồi mới nhận realtime.
- Nhóm lớn hoặc channel: có `chat_pts` riêng. Log user chỉ nhận một entry gộp kiểu "chat X tới seq S" để cập nhật danh sách dialog. Client chỉ gọi `getChannelDifference` khi mở chat đó hoặc khi chat đó nằm trong danh sách dialog đang hiển thị.

## 3. Message ID, thứ tự và gửi idempotent

| Tiêu chí | Per-user box id (Telegram DM) | Per-chat `seq` | Snowflake toàn cục (Discord) | **Snowflake uid + per-chat seq** |
|---|---|---|---|---|
| Phân trang `offset_id/min_id/max_id` | Tốt | Tốt, liền mạch | Được nhưng có lỗ | Tốt |
| Phát hiện thiếu tin trong lịch sử | Có | Có (seq liên tục) | Không | Có |
| Đếm unread | Phải đếm | `last_seq - read_seq` (trừ tin của mình) | Phải đếm | Như seq |
| Chi phí | Sao chép tin cho mỗi thành viên | Một dòng nóng `chats.last_seq` mỗi chat | Không cần phối hợp | Như seq |
| Khóa partition và search doc | Kém | Ổn | Tốt | Tốt |
| **Xếp hạng** | 4 | 2 | 3 | **1** |

- `messages` có PK `(chat_id, seq)` và cột `uid` (Snowflake, unique) dùng làm id tài liệu search, khóa tham chiếu và khóa media.
- Cấp `seq`: `UPDATE chats SET last_seq=last_seq+1 RETURNING last_seq` trong transaction gửi tin. Một nhóm cỡ vài trăm tin/giây vẫn ổn trên Postgres. Khi scale, dùng tiến trình "chat owner" theo consistent hash (xem mục 4) để cấp seq trong bộ nhớ và ghi theo batch.
- **Idempotent:**
  - Client sinh `random_id` (int64 hoặc UUIDv7). Có `UNIQUE(sender_id, random_id)`.
  - Khi trùng thì **trả lại tin cũ** (cùng `seq`/`uid`), không báo lỗi.
  - Client hiện tin "pending" theo `random_id`. Ack server gửi về cặp `random_id → (seq, uid)`, tương tự `updateMessageID` của Telegram.
  - Retry sau khi reconnect luôn dùng lại cùng `random_id`. Teamgram cũng dedupe theo `random_id`.

## 4. Realtime gateway và fan-out

| Tiêu chí | **Go** | Elixir/Phoenix | Rust (tokio) | Node + uWebSockets.js |
|---|---|---|---|---|
| Kết nối/node (bằng chứng) | Centrifugo khuyên 50–100k client/node; 1M kết nối trên 20 pod, p99 khoảng 200 ms ở 500k msg/s (2020) | Phoenix đạt 2M kết nối WebSocket (2015); Discord khoảng 5M CCU (2017); WhatsApp (Erlang) hơn 2M TCP/máy (2012) | Cao nhất về RAM và CPU | I/O rất nhanh, nhưng logic JS đơn luồng, GC |
| Presence/pub-sub có sẵn | Thư viện (centrifuge), tự làm | **Phoenix Presence/PubSub có sẵn** | Tự làm | Tự làm |
| Tuyển người tại VN | **Dễ** | Khó | Khó | Dễ |
| Tốc độ phát triển | Cao | Cao (khi team biết Elixir) | Thấp | Cao |
| Rủi ro vận hành | Thấp | Thấp (BEAM) nhưng ít người vận hành | Thấp | Trung bình (event loop bị block) |
| **Xếp hạng** | **1** | 2 | 3 (cho data service khi scale) | 4 |

**Kiến trúc gateway:**
- Gateway chỉ giữ kết nối và đăng ký nhận sự kiện, không chứa nghiệp vụ.
- Lưu `user_id → [gateway_id, session_id]` trong Redis.
- Định tuyến nội bộ: v1 dùng **Redis (sharded) Pub/Sub**, vì Redis vốn đã có sẵn cho presence và rate limit. At-most-once là chấp nhận được, vì đã có log và `getDifference`. Khi số gateway lớn thì chuyển sang **NATS** (subject `u.<user_id>`, `c.<chat_id>`).
- Sự kiện bền (index, push, analytics) đi qua outbox, sau này là Kafka hoặc Redpanda.

**Presence và typing:**
- Typing: client gửi tối đa mỗi 3–5 s, server có TTL khoảng 6 s.
- Chỉ fan-out tới **những session đang xem chat đó** (interest-based), không gửi cho cả nhóm.
- Presence: lưu `last_seen` trong Redis có TTL, chỉ đẩy tới contact và các chat đang mở.
- Nhóm lớn không fan-out presence. Số người online được tính định kỳ.

**Fan-out cho nhóm lớn:**
- Nhóm ≤ 200 người: fan-out on write vào log từng user, và push từng người.
- Nhóm trên 200 người hoặc channel: **fan-out on read**. Lưu một bản tin và một log theo chat. Đẩy realtime qua subject `c.<chat_id>` chỉ tới các session đang "quan tâm".
- Bằng chứng: Discord gặp đúng nút thắt này ở guild khoảng 30k người online. Gửi một sự kiện mất 900 ms–2,1 s, nên họ viết Manifold để chia việc gửi theo node và giữ thứ tự.
- Khi scale: tiến trình **chat owner** theo consistent hash `chat_id`. Đây là mô hình Channel Server của Slack (tiến trình stateful theo `channel_id`, giao tin toàn cầu khoảng 500 ms) và data service có request coalescing của Discord.

## 5. Lưu trữ

| Tiêu chí | **PostgreSQL (partitioned) → shard theo chat_id** | ScyllaDB | Cassandra 5 |
|---|---|---|---|
| Độ trễ đọc lịch sử | Tốt khi index `(chat_id, seq DESC)` nằm trong RAM | Discord: p99 khoảng 15 ms đọc, khoảng 5 ms ghi (72 node) | Discord (cũ): p99 đọc 40–125 ms |
| Transaction (seq, pts, outbox cùng lúc) | **Có** | Không (LWT đắt) | Không |
| Join/ACL/search fallback | Có | Không | Không |
| Vận hành với team nhỏ | Quen thuộc (Patroni, pgBackRest) | Chuyên biệt | Chuyên biệt, JVM, tombstone |
| License/rủi ro | PostgreSQL License | **Source-available từ 2025.1**; miễn phí ≤ 50 vCPU và 10 TB, bản AGPL dừng ở 6.2 | Apache-2.0 |
| **Xếp hạng v1 / khi scale** | **1 / 1** (shard) | — / 2 (nếu vượt ngưỡng) | — / 3 |

**Lộ trình theo giai đoạn:**
1. **v1:** một Postgres primary, một replica đồng bộ (Patroni). `messages` hash-partition theo `chat_id` (64 partition) với index `(chat_id, seq DESC)`.
   - Không partition theo thời gian cho `messages`, vì chat ít hoạt động có tin mới nhất nằm ở partition cũ.
   - Discord cần bucket thời gian chỉ vì partition của Cassandra phải có giới hạn kích thước. B-tree của Postgres không cần điều đó.
   - `user_updates` partition theo ngày (để drop theo retention). Thêm `dialogs`, `chat_members` và `outbox`.
2. **Tăng tải:** đọc lịch sử từ replica. Cache trang tin nóng (50 tin cuối của chat đang hoạt động) trong Redis, hoặc trong chat owner.
3. **Scale:** shard theo `chat_id`, dùng Citus hoặc shard map ở tầng ứng dụng. `user_updates` và `dialogs` shard theo `user_id`.
4. **Chỉ chuyển body tin nhắn sang ScyllaDB/Cassandra khi** dữ liệu tin vượt nhiều chục TB, hoặc tốc độ ghi duy trì ở mức hàng chục nghìn tin/giây mà shard Postgres đã khó vận hành.
   - Nhờ "message store" interface, việc chuyển chỉ xảy ra trong một module.
   - Cách migrate: dual-write, rồi backfill, rồi chuyển đường đọc. Discord migrate xong trong 9 ngày, lúc đỉnh 3,2M dòng/giây.

**Media:**
- Upload trực tiếp từ client lên S3-compatible (MinIO tự host, hoặc object storage tại VN) bằng **presigned multipart, có thể resume**.
- Khóa theo `sha256` để dedupe.
- Worker sinh thumbnail và transcode bất đồng bộ.
- Nhúng **thumbnail siêu nhỏ** (vài trăm byte, kiểu stripped thumb hoặc blurhash) ngay trong payload tin, để mở chat là hiện ảnh mờ ngay.
- Phát qua CDN bằng URL ký, TTL ngắn. Quyền truy cập được kiểm khi cấp URL, không kiểm ở CDN.

## 6. Search

### 6.1 Pipeline

- Gửi tin: trong cùng một transaction, insert `messages` và `outbox(event, uid, version)`.
- Relay worker lấy `outbox` bằng `FOR UPDATE SKIP LOCKED` (hoặc `LISTEN/NOTIFY`), đẩy sang indexer, rồi upsert hoặc delete vào engine theo `uid` + `version` để idempotent.
- Sửa hay xóa tin đều sinh event. Zulip cũng index **sau khi đã giao tin**, để không làm chậm đường gửi.
- Khi scale: thay relay bằng CDC (Debezium/logical decoding) đổ vào Kafka. Discord chuyển từ Redis queue sang PubSub có bảo đảm giao, và gom bulk theo index đích. Engine luôn **rebuild được từ Postgres**.
- SLO index lag: p99 ≤ 5 s.

### 6.2 ACL (user chỉ tìm được trong chat mình là thành viên)

| Chiến lược | Ưu | Nhược | Dùng khi |
|---|---|---|---|
| **A. Lọc lúc query: `chat_id IN (...)` cộng `seq >= visible_from_seq` theo chat** | Đổi thành viên không cần reindex | Danh sách IN dài với user ở hàng nghìn chat | **Mặc định** |
| B. Nhét danh sách thành viên vào document | Query đơn giản | Mỗi lần đổi thành viên phải reindex toàn bộ lịch sử chat, **không dùng được** | Không |
| C. Bản sao theo user cho DM và nhóm nhỏ (Discord: `user-dm-messages` shard theo `user_id`, gấp đôi dung lượng DM) | Search toàn bộ DM rất nhanh, routing theo một shard | Tốn dung lượng | Khi scale, cho DM |

- Áp dụng A. Thêm **bước kiểm lại**: lấy top-K `uid` từ engine, rồi kiểm với Postgres (vẫn là thành viên, chưa "xóa cho tôi", chưa "clear history"). Như vậy engine chỉ sinh ứng viên, Postgres mới là nguồn sự thật.
- Truy vấn search phải đi qua backend proxy. Không phát tenant token trực tiếp, vì thành viên có thể đổi bất cứ lúc nào.
- Search trong một chat chỉ cần `chat_id = X`, nên rẻ nhất.

### 6.3 Chuẩn hóa tiếng Việt (một spec dùng chung cho server, indexer và client)

1. Chuẩn hóa NFC. Dữ liệu từ các bộ gõ có thể ở dạng NFD, và vị trí dấu có thể khác nhau (`hoà`/`hòa`).
2. Lowercase.
3. Tách token theo khoảng trắng hoặc Unicode word boundary. Tiếng Việt cách nhau theo âm tiết, nên **không cần word segmentation** (coccoc-tokenizer, VnCoreNLP) để có recall. Truy vấn nhiều âm tiết dùng phrase hoặc proximity.
4. Mỗi tin có hai trường: `text_exact` (giữ dấu) và `text_folded` (NFD, bỏ dấu kết hợp, **`đ/Đ→d`**). Query trên cả hai, boost `text_exact` để "người" xếp trên "ngươi".
5. Prefix: coi token cuối của query là prefix (search-as-you-type).
6. Typo: âm tiết tiếng Việt ngắn (2–7 ký tự), nên fuzzy chỉ bật cho token đã bỏ dấu dài ≥ 5. "Lỗi" phổ biến nhất (thiếu dấu) đã được folding xử lý.
7. Có thể thêm: chuyển chuỗi Telex/VNI còn sót khi người dùng quên bật bộ gõ (`nguowif → người`).

**Đã kiểm chứng:**
- `unaccent.rules` của Postgres có `đ→d`, `ơ→o`, `ư→u`, `ạ/ố/ờ/ữ`.
- Lucene `ASCIIFoldingFilter` có `đ đ`, `ơ ơ`, `ư ư`. Tantivy (ParadeDB, Quickwit) có bộ lọc tương đương.
- Meilisearch (charabia): `nonspacing_mark` áp cho script Latin, và có `VietnameseNormalizer` đổi `Đ/đ/Ð/ð→d`.
- Typesense: locale mặc định `en` bỏ dấu, locale `vi` giữ dấu.

### 6.4 So sánh engine

| Engine | Tiếng Việt | Prefix/typo | ACL | Quy mô/giới hạn | Ops | License/rủi ro | Xếp hạng v1 / scale |
|---|---|---|---|---|---|---|---|
| **Meilisearch CE** | Bỏ dấu sẵn (đã đọc mã), nhưng không giữ được trường có dấu để boost | **Có sẵn tốt nhất** | Filter `chat_id IN` | Tối đa 4,29 tỷ doc/index, khuyên < 2 TiB/index; query chỉ lấy 10 từ đầu; CE chạy một node | **Thấp nhất** | MIT; **sharding chỉ có ở EE (BUSL, trả phí cho production)** | **1** / 3 |
| **OpenSearch** (ICU/asciifolding `preserve_original`, edge n-gram) | Tốt, cấu hình tay, giữ được cả hai dạng | Có (fuzzy, edge n-gram) | Terms filter hoặc terms lookup, routing theo `chat_id`/`user_id` | Discord: hàng nghìn tỷ tin, p50 dưới 100 ms, p99 dưới 500 ms | Cao (JVM heap, shard) | Apache-2.0 | 3 / **1** |
| Postgres FTS + `unaccent` + `pg_trgm` (+`btree_gin`) | Tốt (cần wrapper IMMUTABLE cho `unaccent`) | Prefix `:*`; typo qua trigram nhiễu và chậm | **Join SQL chuẩn xác** | Search toàn cục trên nhiều chat với từ phổ biến sẽ chậm, ranking yếu (không có BM25) | Không thêm thành phần | Không có rủi ro | 2 (phương án dự phòng, chạy trên replica) / 5 |
| ParadeDB `pg_search` (BM25/Tantivy trong PG) | Có `ascii_folding` | Có | Join SQL | Mới; tăng tải lên primary; managed PG thường không hỗ trợ | Trung bình | **AGPL-3.0**, độ chín trung bình | 4 / 4 (theo dõi) |
| Typesense | Phải tự làm hai trường | Tốt | Filter | **Toàn bộ index nằm trong RAM, 2–3× dung lượng trường search**, đắt với lịch sử chat | Thấp | GPL-3.0 | Loại |
| Quickwit/Tantivy | Có folding | Có | Filter | Thiết kế cho log append-only; sửa và xóa tin là điểm yếu | Thấp (lưu trên S3) | Apache-2.0 | Loại |

**Khuyến nghị:**
- **v1: Meilisearch CE.** Nó đáp ứng ngay ba yêu cầu: bỏ dấu, prefix, typo. Độ trễ thấp, ops gần như bằng không.
  - Đặt sau một `SearchPort` để đổi engine sau này mà không chạm vào API.
  - Chia nhiều index theo hash `chat_id` từ đầu, để tránh trần 4,29 tỷ doc mỗi index.
- **Ngưỡng chuyển sang OpenSearch** (rebuild từ Postgres qua cùng indexer), khi xảy ra một trong các điều sau:
  - Một node Meilisearch không theo kịp tốc độ ghi, tức index lag p99 vượt 5 s kéo dài.
  - Dung lượng tiến gần giới hạn của một máy.
  - Cần sharding mà không muốn mua bản EE.
- Nếu team không muốn thêm thành phần nào ở v1: dùng Postgres FTS trên replica, chấp nhận typo tolerance yếu.

### 6.5 Search local trên client

- Telegram tìm trong cache local trước, rồi trộn kết quả server. Nên làm giống vậy.
- Mobile và desktop: SQLite **FTS5** với `tokenize='unicode61 remove_diacritics 2'`. Tôi suy luận (chưa test) rằng `unicode61` không gập `đ` vì `đ` không phân rã được thành ký tự gốc cộng dấu. Vì vậy nên lưu thêm cột `text_folded` do app tự tính bằng **cùng spec chuẩn hóa với server**. Spec này cần có bộ test vector dùng chung, đó là cách giữ DRY.
- Web: IndexedDB cộng MiniSearch hoặc FlexSearch, dùng cùng hàm fold.
- Kết quả local hiện ngay, dưới 50 ms. Kết quả server bổ sung các tin cũ chưa được cache.

## 7. Push notification khi offline

1. **Ai cần push:** delivery worker đọc event tin mới, rồi hỏi Redis xem người nhận có session đang ở **foreground** không. Có thì không push. Nếu chỉ desktop đang mở thì gửi push im lặng hoặc hoãn vài giây, tùy policy.
2. **Hàng đợi push:** gồm user, device token và payload. Có collapse key theo `chat_id`, áp dụng mute/settings, và rate-limit cho channel lớn (gom theo batch).
3. **Gửi:**
   - Dùng **FCM HTTP v1**. API legacy đã bị deprecate từ 2023-06-20 và bắt đầu tắt từ 2024-07-22. Xác thực bằng OAuth2 service account.
   - Dùng **APNs HTTP/2** với token `.p8`.
   - Token trả về `UNREGISTERED` (FCM) hoặc `410` (APNs) thì xóa ngay.
4. **Payload:**
   - Theo cách Telegram: tối thiểu `loc_key`, `loc_args`, `custom{chat_id, seq}`. Có thể **mã hóa payload** bằng secret device đăng ký (Telegram dùng trường `p`).
   - iOS dùng `mutable-content` cộng Notification Service Extension để giải mã và cập nhật badge.
   - Android dùng data message high-priority, nhưng phải hiển thị notification, nếu không FCM sẽ hạ ưu tiên.
5. **Đồng bộ đã đọc:** đọc trên một thiết bị thì gửi push im lặng kiểu `READ_HISTORY` để xóa notification ở thiết bị khác. Client đăng ký lại token ít nhất mỗi 24 h hoặc khi khởi động lại (khuyến nghị của Telegram).
6. Push chỉ là tín hiệu. Khi mở app, client vẫn gọi `getDifference`, và dedupe theo `(chat_id, seq)`.

## 8. Ngân sách độ trễ "kiểu Telegram" và cách đo

Telegram không công bố SLO. Các con số dưới đây suy ra từ:
- ngưỡng cảm nhận "tức thì" khoảng 100 ms (NN/g);
- Discord: data service p99 khoảng 5–15 ms; search p50 dưới 100 ms, p99 dưới 500 ms;
- Slack: giao tin toàn cầu khoảng 500 ms.

Tất cả là mục tiêu **trong nước VN**, đo trên mạng 4G và cáp quang.

| Chỉ số | p50 | p99 | Ghi chú |
|---|---|---|---|
| Gửi → ack (đo ở client) | ≤ 60 ms | ≤ 250 ms | Xử lý phía server ≤ 15 / 60 ms |
| Giao end-to-end khi người nhận online | ≤ 150 ms | ≤ 500 ms | Từ người gửi qua gateway, bus, gateway, tới người nhận |
| Mở chat (cache local) | ≤ 50 ms | ≤ 100 ms | Không chờ mạng; delta đồng bộ sau |
| Trang lịch sử 50 tin (server) | ≤ 20 ms | ≤ 100 ms | Index trong RAM hoặc cache trang nóng |
| `getDifference` ≤ 1.000 update | ≤ 50 ms | ≤ 300 ms | Sau khi reconnect |
| Reconnect và bắt kịp sau khi đổi mạng | ≤ 1 s | ≤ 3 s | Resume session, không handshake lại toàn bộ |
| Search server | ≤ 100 ms | ≤ 500 ms | Index lag p99 ≤ 5 s |
| Enqueue push → FCM/APNs nhận | ≤ 300 ms | ≤ 1 s | Phần giao tới máy do nhà cung cấp quyết định |

**Cách đo:**
- **Bot canary** gửi tin giữa hai tài khoản trên **cùng một máy** (chung một đồng hồ) mỗi 10–30 s, đặt trên mạng Viettel, VNPT và FPT. Bot đo E2E thật.
- **RUM trên client:** đo send→ack, khoảng thời gian mở chat, độ dài reconnect.
- **Phía server:** histogram OpenTelemetry/Prometheus. Không lấy trung bình percentile giữa các node; phải gộp histogram.
- Trace ID xuyên suốt từ gateway qua service và bus tới gateway.
- Theo dõi hằng ngày: SLO dashboard và error budget, số lần `getDifference` mỗi phiên, tỷ lệ gap.
- **Hạ tầng tại VN** (RTT trong nước khoảng 10–30 ms, so với khoảng 40–60 ms nếu đi Singapore). Đây là số ước lượng, chưa đo.

## 9. Kiến trúc theo giai đoạn

**v1 (một region tại VN):**
```
Client (SQLite/FTS5 cache) ──WebSocket protobuf──▶ Gateway (Go, N node, stateless trừ kết nối)
                                                     │  Redis: route user→gateway, presence, typing, pub/sub
                                                     ▼
                         Core (Go modular monolith: auth · chats · messages · sync · media-meta)
                                                     │  1 transaction: messages + seq + user_updates/pts + outbox
                                                     ▼
                         PostgreSQL primary + sync replica (Patroni)
                                                     │ outbox relay (SKIP LOCKED)
                          ┌──────────────┬───────────┴────────────┐
                          ▼              ▼                        ▼
                     Indexer → Meilisearch   Push worker → FCM v1/APNs   Media worker ↔ S3-compatible + CDN
```

**Scale (tách theo đúng ranh giới module của v1):**
- Gateway đa region. Chuyển bus nội bộ sang NATS. Sự kiện bền đi qua Kafka hoặc Redpanda bằng CDC.
- Tách các service: `message-write`, `sync` (`getDifference`), `fanout`, `push`, `search-indexer`. Thêm **chat owner** theo consistent hash `chat_id` để cấp seq, coalesce và fan-out cho nhóm lớn.
- Postgres shard theo `chat_id` (messages) và theo `user_id` (updates, dialogs). Body tin chuyển sang ScyllaDB/Cassandra chỉ khi vượt ngưỡng ở mục 5.
- OpenSearch chia cell: tin trong chat route theo `chat_id`, DM nhân bản theo `user_id`, chat siêu lớn có index riêng.

## 10. Rủi ro áp dụng

| Lựa chọn | Độ chín / cộng đồng | Rủi ro |
|---|---|---|
| Postgres | Rất cao | Thấp. Cần kỷ luật index và partition từ đầu |
| Go + WebSocket | Rất cao | Thấp |
| Meilisearch CE | Cao (khoảng 59k stars, active) | Trung bình. Sharding bị khóa sau EE; giới hạn một node; đã đổi license năm 2025 |
| OpenSearch | Cao | Ops nặng. Cần người hiểu JVM và shard |
| ParadeDB | Trung bình (khoảng 9,4k stars, AGPL) | Mới, managed PG ít hỗ trợ |
| ScyllaDB | Cao về kỹ thuật | **License đã đổi sang source-available** (2024-12), giới hạn bản miễn phí |
| Mô hình lai pts | Đã kiểm chứng bởi Telegram | Phải xử lý chuyển nhóm nhỏ sang nhóm lớn (migrate, giống basic group lên supergroup) |

## 11. Giới hạn của nghiên cứu

- Không benchmark gì cả. Mọi con số hiệu năng đều lấy từ blog của bên thứ nhất (Discord, Slack, Centrifugo, Phoenix, WhatsApp), trên phần cứng khác và cách đây 2–10 năm. Cần một spike đo tải trên hạ tầng thật.
- Chưa test chất lượng xếp hạng tiếng Việt trên dữ liệu chat thật: Meilisearch có ưu tiên tin đúng dấu không, độ nhiễu của typo với âm tiết ngắn.
- Chưa test SQLite FTS5 với `đ`. Đó là suy luận từ cách phân rã Unicode.
- Không đánh giá E2E encryption (secret chat), cuộc gọi VoIP, bot API, federation hay chống spam. Các phần này sẽ đổi thiết kế push và search: tin E2E thì server không index được.
- Không đọc sâu Teamgram ngoài layout, schema SQL, `idgen`, `pts.go` và `outbox.go`. Không chạy Teamgram.
- Câu trong tài liệu Telegram về việc giao update tới "connection active gần nhất" chưa được đối chiếu thêm. Thiết kế ở đây chủ động đẩy tới mọi session online.

## 12. Câu hỏi chưa giải quyết (cần quyết trước khi lên plan)

1. **Quy mô mục tiêu 12–24 tháng** (MAU, CCU, tin/ngày, nhóm lớn nhất)? Nó quyết định ngưỡng 200, số partition, và thời điểm chuyển Meilisearch sang OpenSearch.
2. **Có cần E2E encryption không?** Nếu có, search server-side chỉ áp dụng cho chat không mã hóa; với chat mã hóa chỉ search local được.
3. **Hạ tầng:** tự host (DC của iNET?) hay cloud? Câu này ảnh hưởng tới lựa chọn Patroni hay managed PG, CDN, S3, và việc dùng được ParadeDB hay không.
4. **Kỹ năng team:** Go có phải ngôn ngữ chính không? Nếu team mạnh Elixir thì đổi thứ hạng gateway.
5. **Chính sách lịch sử:** thành viên mới có xem được lịch sử cũ không (ảnh hưởng `visible_from_seq`)? Retention update log là 14 hay 30 ngày?
6. **Có cần tương thích client Telegram (MTProto) không?** Nếu cần thì nên fork hoặc tham chiếu sát Teamgram. Nếu không thì dùng protobuf qua WebSocket, đơn giản hơn nhiều.

## Nguồn

- Telegram updates (pts/qts/seq, gap, getDifference): https://core.telegram.org/api/updates
- Telegram pagination: https://core.telegram.org/api/offsets · Channel/ID dùng chung, giới hạn nhóm: https://core.telegram.org/api/channel · Push: https://core.telegram.org/api/push-updates
- Teamgram: https://github.com/teamgram/teamgram-server (SHA 708fb95, Apache-2.0); đã đọc `specs/architecture.md`, `teamgramd/deploy/sql/1_teamgram.sql`, `app/messenger/msg/internal/dao/{pts,outbox}.go`, `app/service/idgen/internal/dao/dao.go`, `app/service/biz/message/internal/dal/tables/messages.xml`
- Matrix `/sync`: https://spec.matrix.org/v1.16/client-server-api/#syncing · MSC4186 được chấp nhận: https://matrix.org/blog/2026/07/03/this-week-in-matrix-2026-07-03/
- Discord lưu trữ: https://discord.com/blog/how-discord-stores-trillions-of-messages · Discord search: https://discord.com/blog/how-discord-indexes-trillions-of-messages · Discord Elixir: https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users
- Slack realtime: https://slack.engineering/real-time-messaging/
- WhatsApp: https://blog.whatsapp.com/1-million-is-so-2011 · https://www.erlang-factory.com/upload/presentations/558/efsf2012-whatsapp-scaling.pdf
- Phoenix 2M: https://phoenixframework.org/blog/the-road-to-2-million-websocket-connections · Centrifugo: https://centrifugal.dev/blog/2020/02/10/million-connections-with-centrifugo
- Zulip search: https://zulip.readthedocs.io/en/latest/subsystems/full-text-search.html
- Meilisearch: charabia `normalizer/{vietnamese,nonspacing_mark}.rs` tại https://github.com/meilisearch/charabia · giới hạn: https://www.meilisearch.com/docs/learn/resources/known_limitations · EE/BUSL: https://www.meilisearch.com/blog/enterprise-license · tenant token: https://www.meilisearch.com/docs/learn/security/multitenancy_tenant_tokens
- Typesense locale: https://typesense.org/docs/guide/locale.html · RAM: https://typesense.org/docs/guide/system-requirements.html
- Postgres `unaccent.rules`: https://github.com/postgres/postgres/blob/master/contrib/unaccent/unaccent.rules
- Lucene ASCIIFoldingFilter: https://github.com/apache/lucene/blob/main/lucene/analysis/common/src/java/org/apache/lucene/analysis/miscellaneous/ASCIIFoldingFilter.java
- ParadeDB ascii folding: https://www.paradedb.com/docs/documentation/token-filters/ascii-folding
- ScyllaDB license: https://www.scylladb.com/2024/12/18/license/ · https://www.scylladb.com/source-available-faq
- FCM v1: https://firebase.google.com/docs/cloud-messaging/migrate-v1
- Ngưỡng phản hồi: https://www.nngroup.com/articles/response-times-3-important-limits/
