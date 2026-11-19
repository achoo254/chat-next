# ADR 0022: Chat Bridge: đồng bộ hội thoại của app khác vào Chat

- Trạng thái: Đã chấp nhận; phần chọn chat, số tin và hướng được thay bởi [ADR 0024](./0024-chat-bridge-one-switch-sync.md)
- Ngày: 2026-11-17
- Bổ sung [ADR 0001](./0001-id-scheme.md), [ADR 0003](./0003-outbox.md) và [ADR 0016](./0016-account-deletion-at-idp.md).

## Bối cảnh

Người dùng muốn thấy hội thoại Telegram của chính mình trong Chat: có người gửi, thời gian gốc, trả lời, media, tìm kiếm và realtime. Telegram là app đầu tiên; app thứ hai dự kiến là Zalo. Lõi Chat không được sửa mỗi khi thêm một app.

## Quyết định

- **Lớp bridge chung, adapter riêng cho từng app.** Hợp đồng là Go interface `Adapter` trong `server/internal/bridge/adapter.go` (`Capabilities`, `Login`, `ListConversations`, `Backfill`, `Subscribe(account)`, `FetchMedia`), không dùng proto: hợp đồng không bao giờ qua ranh giới tiến trình. Adapter nối bằng map tĩnh trong code, không có registry hay plugin loader. App kiểu đẩy (webhook) không có `Subscribe` giữ kết nối và đi vào Chat qua `hooks`, không thuộc hợp đồng này.
- **Chạy trong tiến trình `server`**, một dịch vụ có `Run(ctx)` gọi thẳng `chat.Service`. Không có `/bridge/v1`, không có token riêng, không có tiến trình thứ hai cầm `SESSION_KEY`.
- **Đường ghi nội bộ `ImportTx`** theo mẫu `WithIntegration` nhưng riêng, vì `WithIntegration` chỉ nhận group và channel còn tin nhập cần cả chat `private`, người gửi ngoài, thời gian gốc và không bắn push.
- **Người dùng ảo (puppet).** Mỗi liên hệ ngoài là một `users` gắn cờ `external_source`, là thành viên thật của chat đã nhập để mention và hồ sơ hoạt động như thường. Biện pháp giảm rủi ro: puppet bị loại khỏi tìm kiếm, DM, thêm vào nhóm và danh bạ; không sinh `user_state`, `user_updates` hay số chưa đọc cho thành viên ngoài; người dùng Chat khác không nhắn được puppet. Đại ca chọn giữ puppet dù chi phí nới schema `users`.
- **Tin của chính chủ bên Telegram** gán `from_id` = người dùng thật của chủ.
- **Ánh xạ loại chat** theo `type` ở ADR 0001: chat riêng → `private` giữa chủ và puppet; bot → `private` với puppet gắn cờ bot; nhóm và supergroup → `group`; kênh → `channel`; chat bí mật (E2E) bỏ qua vì không đồng bộ được.
- **Id ngoài là chuỗi mờ**, lõi không phân tích. Khoá idempotent là `(external_account, external_chat, external_msg)`; so sánh `Version` để bản cũ không đè bản mới; lệnh xoá đến trước tin gốc để lại tombstone.
- **Trạng thái update của tài khoản là blob mờ do adapter sở hữu**, engine lưu cùng transaction với việc ghi tin nên chết giữa chừng thì phát lại chứ không mất.
- **Một chiều ở bước 1, hai chiều ở bước 2.** `external_chats.direction` là `in` (nguồn → Chat, server từ chối gửi vào chat) hoặc `both`. Với `both`, tin do chủ viết ở Chat được ghi vào Chat trước (có `seq` ngay, không dùng tin tạm) rồi một dòng trong hàng đợi `external_outbox` ghi cùng giao dịch; runner của tài khoản gửi sang app kia. Gửi và xử lý sự kiện của một tài khoản chạy trong cùng một goroutine nên tin dội ngược không đua với việc ghi khoá `(account, chat, external_msg)`.
- **Hợp đồng gửi là interface riêng.** `Sender` (`SendMessage`, `EditMessage`, `DeleteMessages`) nằm cạnh `Adapter` và chỉ adapter khai `CapSend` mới cài; app không có `CapSend` vẫn là một chiều. `OutMessage.RandomID` lưu trước khi gửi và dùng lại khi thử lại sau sự cố; adapter không hứa được rằng cùng `RandomID` không tạo tin thứ hai thì không được khai `CapSend`. Lỗi vĩnh viễn có kiểu (`ErrNotAllowed`, `ErrEditExpired`, `ErrTooLarge`) hiện cho người dùng kèm lý do; lỗi tạm thời (`RateLimitError`, mất kết nối) thử lại theo thứ tự.
- **Chỉ tin do chủ chat viết sang app kia.** Bot, Bot API và người khác tiếp tục bị từ chối ở chat liên kết. Đây là quyền mới: trước bước 2 một phiên Chat bị lộ chỉ đọc được, sau đó còn gửi được tin giả danh chủ ở app kia. Giảm rủi ro bằng cờ riêng từng chat, trần tốc độ gửi mỗi tài khoản và log kiểm toán mỗi lần đổi `direction`.
- **Topic của nhóm forum.** Topic là khả năng riêng như gửi tin: adapter khai `CapTopics` và cài `TopicReader` (`ListTopics`); `Conversation.Forum` báo nhóm có topic, `Message.Topic` (id mờ) và `OutMessage.Topic` mang topic, `Event.Topic` báo topic mới hoặc đổi (tên, đóng, ghim). Lõi giữ bảng `external_topics` vì id topic của Telegram là id tin mở topic (không liên tục, có thể lớn tới hàng trăm nghìn), còn id topic của Chat do Chat cấp. Topic do bên kia quản lý: tạo, đổi tên, đóng, ghim ở Chat bị chặn cho nhóm đã liên kết. Quy tắc topic của một tin Telegram (đã đối chiếu với `messages.getReplies`, báo cáo spike 18/11/2026): không có header trả lời là General (id 1); header có cờ forum mà không có `ReplyToTopID` là topic `ReplyToMsgID`; có `ReplyToTopID` là topic đó. Danh sách topic không dùng `Count` của Telegram (sai lệch so với số mục) và bỏ mục đã xoá.
- **Ghim, hai chiều.** `CapPins` với `PinReader` (`ListPinned`, đọc theo bộ lọc tin ghim vì cờ `Pinned` của lịch sử không đủ: tin ghim thường cũ) và `Event.Pin`; `Pinner` (`PinMessage`, `PinTopic`) cho adapter có cả `CapSend`. Ghim topic dùng lại `Topic.Pinned` và `TopicChange`. Chiều vào chỉ thêm ghim (`ImportTx.SetPinned`, không kiểm quyền, không đăng tin dịch vụ) và không gỡ ghim đặt riêng trong Chat. Chiều ra đi qua `external_outbox` với một hàng cho mỗi tin hay topic mang trạng thái muốn có, nên chỉ trạng thái cuối được gửi; Chat áp ngay, và nếu app kia từ chối dứt khoát thì trả ghim về như cũ rồi báo một lần, vì Chat không được giữ ghim mà app kia không có. Ghim topic từ Chat là ngoại lệ duy nhất của việc topic do app kia quản lý, chỉ ở chat hai chiều của chính chủ. Chat chỉ đọc không gửi ghim ra ngoài. Tiếng vang của sự kiện ghim không cần cơ chế riêng vì áp lại trạng thái đã đúng thì không đổi gì.
- **Secret** chỉ server niêm phong và mở (`sealbox`, nhãn mục đích riêng, AAD gắn id tài khoản), nối vào `reseal` và xoá tài khoản.
- **Điều khiển từ trình duyệt** qua `BridgeService` trong `proto/app/v1`, xác thực bằng phiên Chat. Chỉ hai bước đăng nhập app kia (cấp quyền đọc cả tài khoản) đòi đăng nhập Chat trong 10 phút gần đây; bật chat, xoá bản sao, ngắt kết nối và đổi `direction` không đòi.
- **Hệ thống đơn tenant** (`TenantID` luôn là `primary`): bảng `external_*` không có `tenant_id`.

## Vì sao không dùng cách khác

- **Bot API của Chat**: không đặt được người gửi ngoài và thời gian gốc; id tin do server cấp, `seq` nối vào cuối (ADR 0001).
- **Giải mã `postbox` cục bộ của Telegram**: không dùng đường chính thức, dễ vỡ theo bản app, bị REA loại. Dùng MTProto tài khoản người dùng với `api_id` và `api_hash` do chủ app đăng ký.

## Hệ quả

- **Không tải thêm lịch sử cũ sau khi đã đồng bộ.** `seq` chỉ nối vào cuối, nên cửa sổ lịch sử (N tin gần nhất, mặc định 2.000) chọn một lần lúc bật đồng bộ. Backfill đi tăng dần theo thời gian gốc, tin live xếp hàng chờ backfill xong, `last_message_at = greatest(...)` để chat không nhảy lên đầu vì ngày nhập.
- Migration chỉ mở rộng; hoàn tác là tắt cờ cấu hình và đổi binary, không chạy chiều xuống. Tính năng tắt mặc định.
- Thư viện MTProto (`gotd`) là phụ thuộc mới của `server/go.mod`, thêm ở phase adapter.
- Xoá tài khoản Chat phải đăng xuất session Telegram và xoá secret, chat đồng bộ và puppet (nối vào ADR 0016).
- Adapter thứ hai (Zalo) chỉ thêm gói adapter, mô tả bước đăng nhập và ánh xạ định dạng chữ; Zalo không có API chính thức cho tài khoản cá nhân nên cần phân tích riêng và xem xét điều khoản trước.
- **Cập nhật 18/11/2026:** hướng đi theo từng tính năng chứ không chỉ theo chat, hàng đợi gửi tổng quát và các tính năng thêm sau này nằm ở [ADR 0023](./0023-chat-bridge-feature-model.md); `direction` của chat là hướng của `messages`.
