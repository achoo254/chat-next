# ADR 0001: Sơ đồ định danh

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14

## Bối cảnh

Mọi định danh lộ ra ngoài đi qua client web, client native, Bot API dạng JSON, webhook và kết quả tìm kiếm. Số trong JavaScript chỉ chính xác tới 2^53, nên một id 64 bit đầy đủ sẽ bị làm tròn ở client. Định danh còn là khoá lưu trữ và khoá phân mảnh: đổi sau khi đã có dữ liệu thì phải migrate mọi bảng và phá vỡ mọi client, bot và tích hợp đã phát hành.

## Quyết định

| Định danh | Dạng nội bộ | Dạng lộ ra ngoài |
|---|---|---|
| `user_id` | int64 < 2^53, có bit shard | số < 2^53 |
| `chat_id` | int64 < 2^53; mọi chat, kể cả chat 1-1, có `chat_id` riêng | số < 2^53 kèm `type` |
| tin nhắn | Snowflake int64, dùng làm khoá lưu trữ và khoá tìm kiếm | cặp `(chat_id, seq)`, `seq` < 2^53 |
| update | `pts` theo người dùng, `chat_pts` theo chat lớn, kèm `server_epoch` | `pts` và `server_epoch`; với bot là `update_id` < 2^53 tăng theo từng bot |
| file | uuid | `file_id` gắn với chủ thể sở hữu, cùng `file_hash` ổn định |
| bot token | chỉ lưu hash | chuỗi opaque có tiền tố theo brand |

- `type` của chat nhận một trong các giá trị `private`, `group`, `channel`, `secret`. Trường này mang cùng tên `type` ở database, protobuf và JSON. Giá trị `secret` được chừa sẵn cho chat mã hoá đầu cuối, chưa dùng ở v1.
- Tin nhắn lộ ra bằng `(chat_id, seq)` ở mọi bề mặt: client, Bot API, webhook và tìm kiếm. Snowflake không bao giờ rời server.
- `seq` tăng liên tục trong từng chat và được cấp trong cùng transaction với việc ghi tin. Trả lời tin dùng `reply_to_seq` trong cùng chat.
- Id của bot là `user_id` của một user có `is_bot`, nên duy nhất trên toàn hệ thống chứ không chỉ trong một tenant. Điều này cần cho origin Mini App dùng chung mọi tenant, xem [ADR 0010](./0010-tenants-by-domain.md).
- Serializer protobuf và JSON từ chối mọi id lộ ra ngoài từ 2^53 trở lên. CI kiểm điều kiện này.
- Trường id trong proto là `int64` có `[jstype = JS_NUMBER]` để ghi rõ cam kết < 2^53. Code TS sinh bằng protobuf-es vẫn là `bigint` vì protobuf-es cố ý bỏ qua `jstype = JS_NUMBER`. Client core đổi `bigint` sang `number` ở đúng một chỗ, nơi ánh xạ message protocol sang model của chính nó, và gọi `assertSafeId` trước khi đổi; phần còn lại của client chỉ thấy `number`.

## Lý do

- Giữ mọi id dưới 2^53 cho phép client web dùng `number` mà không mất độ chính xác, và Bot API trả JSON số mà SDK ở mọi ngôn ngữ đọc đúng.
- Snowflake cho khoá lưu trữ có thứ tự thời gian và không cần điều phối giữa các node. Nó vượt 2^53 nên chỉ dùng nội bộ.
- `(chat_id, seq)` theo mô hình `message_id` theo từng chat của Telegram: `seq` liên tục giúp phân trang lịch sử theo cursor và giúp client nhận ra tin bị thiếu.
- Cho mọi chat, kể cả chat 1-1, một `chat_id` riêng làm cho quyền, đồng bộ, tìm kiếm và Bot API chỉ có một đường xử lý.
- Bit shard trong `user_id` cố định khoá phân mảnh ngay từ đầu, nên tách dữ liệu sau này không phải đổi id.
- `file_id` gắn chủ thể giúp kiểm quyền khi tải; `file_hash` ổn định giúp khử trùng và cache.

## Hệ quả

- Mọi API nhận hoặc trả tin nhắn phải mang đủ cặp `(chat_id, seq)`. Không có id tin toàn cục nào ở bề mặt ngoài.
- Kết quả tìm kiếm phải đổi khoá Snowflake về `(chat_id, seq)` trước khi trả cho client.
- Cột `seq` của chat là điểm nóng khi nhiều người cùng gửi vào một chat; độ trễ được đo trong load test trước khi phát hành.
- Bot token chỉ hiện một lần khi cấp; server không thể đọc lại token gốc.
- Cách cấp `pts`, `chat_pts` và `server_epoch` thuộc [ADR 0002](./0002-sync.md); cách cấp `update_id` cho bot dựa vào outbox ở [ADR 0003](./0003-outbox.md).

## Cách thay đổi

- Protobuf chỉ được thêm trường; `buf breaking` chạy trong CI để chặn thay đổi phá vỡ.
- Đổi dạng id ra ngoài, ví dụ chuyển sang chuỗi để vượt 2^53, cần một trường mới song song với trường cũ, một phiên bản API mới cho Bot API và một khoảng thời gian client cũ còn đọc trường cũ.
- Đổi khoá phân mảnh hoặc số bit shard cần migration dữ liệu toàn bộ bảng có id; lên kế hoạch như một lần chuyển dữ liệu, không phải một bản phát hành thường.
- Dùng giá trị `secret` của `type` khi làm chat mã hoá đầu cuối không cần migration, nhưng client cũ phải bỏ qua chat có `type` lạ.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
