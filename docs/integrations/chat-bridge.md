# Chat Bridge: đưa chat của ứng dụng khác vào Chat

Chat Bridge đồng bộ các cuộc trò chuyện của chính bạn ở một ứng dụng khác vào Chat để đọc, tìm kiếm và nhận tin mới theo thời gian thực, và (tuỳ từng chat) gửi tin bạn gõ trong Chat sang ứng dụng đó. Telegram là ứng dụng đầu tiên. Quyết định và lý do: [ADR 0022](../adr/0022-chat-bridge.md). Vận hành: [`operations/chat-bridge.md`](../operations/chat-bridge.md).

**Hai chiều, bật từng chat.** Tin luôn đi từ ứng dụng kia sang Chat. Chat bật **Gửi tin từ Chat** thì tin bạn gõ ở đó cũng được gửi sang ứng dụng kia như tin do chính bạn gửi; chat tắt thì bị khoá ô soạn tin (server bỏ quyền gửi, nên cả Bot API và MCP cũng không gửi vào được).

## Dùng

1. Người vận hành bật tính năng và cấp `api_id`, `api_hash` ([Cấp api_id](#cấp-api_id-và-api_hash)).
2. Cài đặt › **Kết nối ứng dụng** › Telegram › Kết nối. Nhập số điện thoại kèm mã quốc gia, mã đăng nhập Telegram gửi tới app trên thiết bị khác của bạn (hoặc SMS), và mật khẩu hai bước nếu tài khoản có. Chỉ bước đăng nhập này đòi đăng nhập Chat trong 10 phút gần đây (nó cấp quyền đọc cả tài khoản); nếu không trang đưa sang đăng nhập lại. Bật chat, bật hay tắt gửi tin, xoá bản sao và ngắt kết nối không đòi.
3. **Hiện danh sách chat**, bấm **Đồng bộ** ở chat muốn lấy, chọn số tin gần nhất cần tải (200, 500, 2.000 hoặc 10.000; mặc định 2.000) rồi **Bắt đầu đồng bộ**.
4. Lịch sử nhập dần, đúng thứ tự thời gian gốc, không báo thông báo đẩy và không tính tin chưa đọc. Tin mới, tin sửa và tin xoá bên Telegram về sau vài giây.
5. Ô **Gửi tin từ Chat sang Telegram** ở bước chọn mặc định bật: chat mới gửi được hai chiều. Bỏ tích để chat chỉ đọc. Chat đã đồng bộ từ trước giữ nguyên cách cũ; bật hoặc tắt từng chat bằng công tắc **Gửi tin từ Chat** cạnh chat đó.

## Gửi từ Chat sang Telegram

Chat hai chiều hiện ghi chú "Tin bạn gõ ở đây cũng được gửi sang Telegram" trên ô soạn tin. Gửi được: văn bản có định dạng (đậm, nghiêng, mã, liên kết), trả lời, sửa, xoá cho mọi người, ảnh, tệp và album. Xoá chỉ cho tôi chỉ xoá ở Chat. Chuyển tiếp, bot, Bot API và thành viên khác không gửi sang Telegram được.

Mỗi tin gửi đi có trạng thái ngay trên tin: đồng hồ là đang gửi (Chat xếp hàng và gửi từng tin, cách nhau chừng 0,7 giây, theo đúng thứ tự). Lỗi hiện thành dòng "Chưa gửi sang Telegram" kèm **Gửi lại** và **Xoá tin** (xoá là cách bỏ tin gửi hỏng). Tạm mất mạng hoặc Telegram bảo chờ thì Chat tự thử lại, không mất tin và không gửi trùng. Nếu server dừng đúng lúc đang gửi và quá 10 phút mới chạy lại, tin hiện "Chưa rõ đã gửi sang Telegram chưa": kiểm trong Telegram rồi chọn **Gửi lại** hoặc **Xoá tin**. Bản sửa không sang được (ví dụ Telegram không cho sửa tin cũ nữa) hiện "Bản sửa chưa sang Telegram" kèm **Gửi lại** và **Bỏ qua**.

Chat đã đồng bộ hiện nhãn nhỏ tên ứng dụng ở danh sách. Người gửi hiện bằng tên của họ ở Telegram; tin của chính bạn bên Telegram hiện là tin của bạn.

## Nhóm có chủ đề (forum)

Nhóm Telegram bật chủ đề đồng bộ thành **nhóm dạng forum** trong Chat: mỗi topic của Telegram là một topic của Chat (topic mặc định là General), tin về đúng topic, topic mới, đổi tên, đổi màu, đóng và ghim ở Telegram phản ánh sang Chat. Ở danh sách chọn chat, nhóm như vậy có nhãn **Nhóm có chủ đề**; chat đã đồng bộ có nhãn **Có chủ đề**.

- **Gõ trong topic nào thì tin vào đúng topic đó bên Telegram** (nếu chat bật Gửi tin từ Chat). Topic đã đóng hoặc đã xoá bên Telegram thì tin báo lỗi như các lỗi gửi khác, các tin sau vẫn đi.
- **Topic do Telegram quản lý:** tạo, đổi tên, đóng, ghim topic chỉ làm ở Telegram; ở Chat các thao tác đó bị chặn và không còn menu.
- **Nhóm đã đồng bộ từ trước (trước khi có chủ đề) vẫn là một dòng tin trộn các topic.** Muốn tách: ở danh sách chọn chat bấm **Đồng bộ lại theo chủ đề** (xoá bản sao rồi bật lại với cùng cửa sổ lịch sử và cùng hướng gửi; những gì chỉ có ở Chat sẽ mất).
- **Cửa sổ lịch sử vẫn áp cho cả nhóm:** topic chỉ có tin cũ hơn cửa sổ thì có mặt (danh sách topic được nạp đủ) nhưng rỗng cho tới khi có tin mới.
- **Nhóm quá 1.000 topic** (giới hạn của Chat): tin của topic thừa vào General, đồng bộ vẫn tiếp tục.

## Giới hạn

- **Không tải thêm lịch sử cũ.** Thứ tự tin trong Chat chỉ nối vào cuối (`seq`), nên cửa sổ lịch sử chọn một lần lúc bật và không đổi được. Muốn khác thì xoá bản sao và đồng bộ lại.
- **Tệp:** ảnh, video, thoại, âm thanh và tệp tới 25 MiB được sao chép vào kho media của bạn (tính vào hạn mức lưu trữ). Lớn hơn, nhãn dán, vị trí, danh bạ và bình chọn chỉ hiện một dòng chữ như `[Ảnh]` hay `[Tệp: tên.pdf]`.
- **Định dạng chữ:** giữ đậm, nghiêng, gạch chân, gạch ngang, spoiler, mã, khối mã, link, email, hashtag và nhắc tên người đã xuất hiện trong chat. Link `tg://`, lệnh bot và số điện thoại bị bỏ định dạng; tin dài quá giới hạn của Chat bị cắt.
- **Chat bí mật (E2E) của Telegram không đồng bộ được**; "Tin nhắn đã lưu" không được nhập.
- **Người liên hệ là người dùng ảo:** mỗi người bên Telegram là một tài khoản ảo trong Chat, không đăng nhập được, không ai tìm, nhắn hay thêm vào nhóm được. Chưa có ảnh đại diện của họ (hiện chữ cái đầu).
- **Gửi:** kênh Telegram chỉ đăng được khi bạn là quản trị viên, nhóm hay người dùng cấm bạn thì tin báo lỗi kèm lý do. Văn bản tối đa 4.096 ký tự (chú thích tệp 1.024), tệp tối đa 2.000 MB và còn chịu hạn mức tệp của Chat. Album chỉ mang chú thích của tệp đầu. Mention chỉ thành mention thật với người đã có trong danh sách hội thoại của bạn; còn lại giữ nguyên chữ.
- **Phiên Telegram:** Chat là một thiết bị trong danh sách thiết bị của bạn. Chat tôn trọng giới hạn tốc độ của Telegram (chờ đúng thời gian Telegram yêu cầu). Nếu bạn kết thúc phiên đó ở Telegram, tài khoản chuyển "Cần đăng nhập lại".
- **Không lưu số điện thoại và mã.** Chỉ phiên đăng nhập đã mã hoá (khoá `SESSION_KEY`, gắn với tài khoản của bạn) được giữ.

## Ngắt kết nối và xoá

- **Xoá bản sao** của một chat: xoá chat đó khỏi Chat, bản gốc ở Telegram không đổi.
- **Ngắt kết nối**: đăng xuất phiên Chat ở Telegram. Chọn giữ các chat (chỉ đọc, hàng đợi gửi chưa đi bị bỏ) hoặc xoá hết chat cùng các liên hệ đã nhập (họ mất tên và ảnh).
- **Tắt gửi** ở một chat: tin đang chờ trong hàng đợi bị bỏ; tin đã gửi sang Telegram giữ nguyên ở đó.
- **Xoá tài khoản hoandat.com** xoá cả phiên Telegram (đăng xuất qua hàng đợi), chat đã đồng bộ và người dùng ảo.

## Cấp api_id và api_hash

Một lần cho cả hệ thống, bởi người vận hành, bằng tài khoản Telegram: đăng nhập `my.telegram.org`, mục "API development tools", tạo ứng dụng và lấy `api_id`, `api_hash`. Đặt vào `/opt/chat/.env` (không vào repo): `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`; `api_hash` là bí mật, không in ra log hay gửi cho client.

## Thêm một ứng dụng khác

Lõi Chat không đổi khi thêm ứng dụng. Việc cần làm:

1. Viết gói adapter cài `bridge.Adapter` ([`server/internal/bridge/adapter.go`](../../server/internal/bridge/adapter.go)): `Name`, `Capabilities` (`history`, `live`, `edits`, `deletes`, `media`, `send` chỉ khai những gì có thật), `Login` (chuỗi bước `input`, `qr`, `confirm`, kết thúc bằng `done` kèm phiên để server niêm phong; trả `*bridge.InputError` khi người dùng nhập sai), `Logout`, `ListConversations`, `Backfill` (một trang lịch sử cũ hơn con trỏ, mới nhất trước), `Subscribe` (luồng sự kiện cả tài khoản; mỗi `Event` mang trạng thái update sau nó dưới dạng blob mờ do adapter sở hữu; trả `ErrGapTooLarge` khi không phát lại được khoảng hở) và `FetchMedia`. Nhóm có topic: cài thêm `bridge.TopicReader` (`ListTopics`), khai `topics`, đặt `Conversation.Forum`, `Message.Topic` và gửi `Event.Topic` khi topic đổi; Chat giữ ánh xạ id topic của app sang id topic của mình (`external_topics`), nên id topic của app là chuỗi mờ; chỉ một topic được đánh dấu `General` (topic mặc định, ánh xạ vào General của Chat). Muốn gửi từ Chat thì cài thêm `bridge.Sender` (`SendMessage`, `EditMessage`, `DeleteMessages`) và khai `send`; **chỉ khai khi gửi lại cùng `RandomID` không tạo tin thứ hai** (Telegram bảo đảm, đã đo cho cả tin và album), vì engine gửi lại sau sự cố bằng đúng `RandomID` đã lưu. Lỗi vĩnh viễn trả `ErrNotAllowed`, `ErrEditExpired` hoặc `ErrTooLarge`; lỗi lạ được thử lại.
2. Id ngoài (hội thoại, tin, người) là chuỗi mờ, lõi không phân tích. Dịch lỗi: giới hạn tốc độ thành `*bridge.RateLimitError`, phiên bị thu hồi thành `bridge.ErrSessionRevoked`. Bộ test gửi dùng adapter giả (có dedupe theo `RandomID`) trong `bridge/engine/outbox_test.go`; mẫu kiểm tay gửi thật là [`adapters/telegram/send_live_test.go`](../../server/internal/bridge/adapters/telegram/send_live_test.go) (`BRIDGE_LIVE_SEND=1`, chỉ gửi vào "Tin nhắn đã lưu" và tự xoá).
3. Nối vào map tĩnh ở [`server/internal/api/bridge_adapters.go`](../../server/internal/api/bridge_adapters.go) (không có registry hay plugin loader) và thêm cấu hình cần thiết vào `config`.
4. Kiểm bằng adapter giả [`bridge/contracttest`](../../server/internal/bridge/contracttest/fake.go): nó có log phát lại theo trạng thái như `pts`, và các kịch bản của engine (`bridge/engine/engine_test.go`) là bộ test hợp đồng. Test tự động không chạy trên tài khoản thật; mẫu kiểm tay một lần là [`adapters/telegram/live_test.go`](../../server/internal/bridge/adapters/telegram/live_test.go) (`BRIDGE_LIVE=1`).
5. Thêm tên ứng dụng ở `apps/web/src/messaging/settings/bridge-copy-*.ts` và `chat-row.tsx`.

**Giới hạn của hợp đồng:** ứng dụng kiểu đẩy (webhook: Slack, Messenger) không có kết nối dài nên không có `Subscribe`; chúng vào Chat qua webhook đến ([`hooks`](../../server/internal/hooks)), không qua Bridge. Ứng dụng đăng nhập bằng OAuth chưa có kiểu bước đăng nhập `oauth` (chỉ `input`, `qr`, `confirm`). Zalo là ứng dụng kế tiếp dự kiến, đăng nhập `qr`; Zalo không có API chính thức cho tài khoản cá nhân nên cần phân tích riêng và xem điều khoản trước.
