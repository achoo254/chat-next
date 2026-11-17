# Chat Bridge: đưa chat của ứng dụng khác vào Chat

Chat Bridge sao chép các cuộc trò chuyện của chính bạn ở một ứng dụng khác vào Chat để đọc, tìm kiếm và nhận tin mới theo thời gian thực. Telegram là ứng dụng đầu tiên. Quyết định và lý do: [ADR 0022](../adr/0022-chat-bridge.md). Vận hành: [`operations/chat-bridge.md`](../operations/chat-bridge.md).

**Một chiều.** Tin đi từ ứng dụng kia sang Chat. Chat không gửi gì ngược lại: chat đã sao chép bị khoá ô soạn tin (server bỏ quyền gửi, nên cả Bot API và MCP cũng không gửi vào được).

## Dùng

1. Người vận hành bật tính năng và cấp `api_id`, `api_hash` ([Cấp api_id](#cấp-api_id-và-api_hash)).
2. Cài đặt › **Kết nối ứng dụng** › Telegram › Kết nối. Nhập số điện thoại kèm mã quốc gia, mã đăng nhập Telegram gửi tới app trên thiết bị khác của bạn (hoặc SMS), và mật khẩu hai bước nếu tài khoản có. Cần đăng nhập Chat trong 10 phút gần đây, nếu không trang đưa sang đăng nhập lại.
3. **Hiện danh sách chat**, bấm **Đồng bộ** ở chat muốn lấy, chọn số tin gần nhất cần tải (200, 500, 2.000 hoặc 10.000; mặc định 2.000) rồi **Bắt đầu đồng bộ**.
4. Lịch sử nhập dần, đúng thứ tự thời gian gốc, không báo thông báo đẩy và không tính tin chưa đọc. Tin mới, tin sửa và tin xoá bên Telegram về sau vài giây.

Chat đã đồng bộ hiện nhãn nhỏ tên ứng dụng ở danh sách. Người gửi hiện bằng tên của họ ở Telegram; tin của chính bạn bên Telegram hiện là tin của bạn.

## Giới hạn

- **Không tải thêm lịch sử cũ.** Thứ tự tin trong Chat chỉ nối vào cuối (`seq`), nên cửa sổ lịch sử chọn một lần lúc bật và không đổi được. Muốn khác thì xoá bản sao và đồng bộ lại.
- **Tệp:** ảnh, video, thoại, âm thanh và tệp tới 25 MiB được sao chép vào kho media của bạn (tính vào hạn mức lưu trữ). Lớn hơn, nhãn dán, vị trí, danh bạ và bình chọn chỉ hiện một dòng chữ như `[Ảnh]` hay `[Tệp: tên.pdf]`.
- **Định dạng chữ:** giữ đậm, nghiêng, gạch chân, gạch ngang, spoiler, mã, khối mã, link, email, hashtag và nhắc tên người đã xuất hiện trong chat. Link `tg://`, lệnh bot và số điện thoại bị bỏ định dạng; tin dài quá giới hạn của Chat bị cắt.
- **Chat bí mật (E2E) của Telegram không đồng bộ được**; "Tin nhắn đã lưu" không được nhập.
- **Người liên hệ là người dùng ảo:** mỗi người bên Telegram là một tài khoản ảo trong Chat, không đăng nhập được, không ai tìm, nhắn hay thêm vào nhóm được. Chưa có ảnh đại diện của họ (hiện chữ cái đầu).
- **Phiên Telegram:** Chat là một thiết bị trong danh sách thiết bị của bạn. Chat chỉ đọc và tôn trọng giới hạn tốc độ của Telegram (chờ đúng thời gian Telegram yêu cầu). Nếu bạn kết thúc phiên đó ở Telegram, tài khoản chuyển "Cần đăng nhập lại".
- **Không lưu số điện thoại và mã.** Chỉ phiên đăng nhập đã mã hoá (khoá `SESSION_KEY`, gắn với tài khoản của bạn) được giữ.

## Ngắt kết nối và xoá

- **Xoá bản sao** của một chat: xoá chat đó khỏi Chat, bản gốc ở Telegram không đổi.
- **Ngắt kết nối**: đăng xuất phiên Chat ở Telegram. Chọn giữ các chat (chỉ đọc) hoặc xoá hết chat cùng các liên hệ đã nhập (họ mất tên và ảnh).
- **Xoá tài khoản hoandat.com** xoá cả phiên Telegram (đăng xuất qua hàng đợi), chat đã đồng bộ và người dùng ảo.

## Cấp api_id và api_hash

Một lần cho cả hệ thống, bởi người vận hành, bằng tài khoản Telegram: đăng nhập `my.telegram.org`, mục "API development tools", tạo ứng dụng và lấy `api_id`, `api_hash`. Đặt vào `/opt/chat/.env` (không vào repo): `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`; `api_hash` là bí mật, không in ra log hay gửi cho client.

## Thêm một ứng dụng khác

Lõi Chat không đổi khi thêm ứng dụng. Việc cần làm:

1. Viết gói adapter cài `bridge.Adapter` ([`server/internal/bridge/adapter.go`](../../server/internal/bridge/adapter.go)): `Name`, `Capabilities` (`history`, `live`, `edits`, `deletes`, `media` chỉ khai những gì có thật), `Login` (chuỗi bước `input`, `qr`, `confirm`, kết thúc bằng `done` kèm phiên để server niêm phong; trả `*bridge.InputError` khi người dùng nhập sai), `Logout`, `ListConversations`, `Backfill` (một trang lịch sử cũ hơn con trỏ, mới nhất trước), `Subscribe` (luồng sự kiện cả tài khoản; mỗi `Event` mang trạng thái update sau nó dưới dạng blob mờ do adapter sở hữu; trả `ErrGapTooLarge` khi không phát lại được khoảng hở) và `FetchMedia`.
2. Id ngoài (hội thoại, tin, người) là chuỗi mờ, lõi không phân tích. Dịch lỗi: giới hạn tốc độ thành `*bridge.RateLimitError`, phiên bị thu hồi thành `bridge.ErrSessionRevoked`.
3. Nối vào map tĩnh ở [`server/internal/api/bridge_adapters.go`](../../server/internal/api/bridge_adapters.go) (không có registry hay plugin loader) và thêm cấu hình cần thiết vào `config`.
4. Kiểm bằng adapter giả [`bridge/contracttest`](../../server/internal/bridge/contracttest/fake.go): nó có log phát lại theo trạng thái như `pts`, và các kịch bản của engine (`bridge/engine/engine_test.go`) là bộ test hợp đồng. Test tự động không chạy trên tài khoản thật; mẫu kiểm tay một lần là [`adapters/telegram/live_test.go`](../../server/internal/bridge/adapters/telegram/live_test.go) (`BRIDGE_LIVE=1`).
5. Thêm tên ứng dụng ở `apps/web/src/messaging/settings/bridge-copy-*.ts` và `chat-row.tsx`.

**Giới hạn của hợp đồng:** ứng dụng kiểu đẩy (webhook: Slack, Messenger) không có kết nối dài nên không có `Subscribe`; chúng vào Chat qua webhook đến ([`hooks`](../../server/internal/hooks)), không qua Bridge. Ứng dụng đăng nhập bằng OAuth chưa có kiểu bước đăng nhập `oauth` (chỉ `input`, `qr`, `confirm`). Zalo là ứng dụng kế tiếp dự kiến, đăng nhập `qr`; Zalo không có API chính thức cho tài khoản cá nhân nên cần phân tích riêng và xem điều khoản trước.
