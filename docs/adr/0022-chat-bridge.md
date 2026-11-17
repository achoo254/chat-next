# ADR 0022: Chat Bridge: đồng bộ hội thoại của app khác vào Chat

- Trạng thái: Đã chấp nhận
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
- **Một chiều ở bước 1.** `external_chats.direction = in`; server từ chối gửi tin vào chat đã liên kết. Giá trị `both` và hàng đợi gửi để bước sau, mô hình dữ liệu đã chừa chỗ.
- **Secret** chỉ server niêm phong và mở (`sealbox`, nhãn mục đích riêng, AAD gắn id tài khoản), nối vào `reseal` và xoá tài khoản.
- **Điều khiển từ trình duyệt** qua `BridgeService` trong `proto/app/v1`, xác thực bằng phiên Chat, đòi đăng nhập lại gần đây.
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
