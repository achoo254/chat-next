# ADR 0023: Chat Bridge: mô hình tính năng cho đồng bộ hai chiều và nhiều nền tảng

Trạng thái: **nháp**, chờ spike R2 và R3 và xác nhận bốn quyết định ở [plan](../../../plans/dattqh/261118-1800-chat-bridge-full-sync/plan.md). Chưa có gì ở đây được cài đặt.

## Bối cảnh

ADR 0022 và các bước sau đó đã đưa vào hai chiều cho tin nhắn, ghim và topic bằng cách thêm từng interface riêng (`Sender`, `TopicReader`, `PinReader`, `Pinner`), từng giá trị `op` của `external_outbox` và một hướng duy nhất cho cả chat (`direction`). Mỗi tính năng mới và mỗi nền tảng mới sẽ đụng engine, bảng và giao diện ở nhiều chỗ. Cần một mô hình để thêm tính năng và nền tảng mà không sửa lõi.

## Quyết định (dự kiến)

- **Tính năng là đơn vị** (`messages`, `pins`, `reactions`, `read`, `notify`, `dialog`, `info`, `members`, `invites`, `topics`, `typing`). Mỗi tính năng có mức rủi ro cố định (R1 trạng thái cá nhân, R2 nội dung người khác thấy, R3 hành động lên người và nhóm) quyết định mặc định và điều kiện bật.
- **Hướng theo từng tính năng và từng chat** (`external_chat_features`: tắt, chỉ nhận, hai chiều); `direction` hiện có vẫn là hướng của `messages`.
- **Adapter khai báo `Features()`** (tính năng và hướng hỗ trợ); các `Cap*` hiện có suy ra từ đó. Giao diện và engine chỉ hiện và chạy những gì có.
- **`FeatureHandler` đăng ký tĩnh** trong engine; `messages`, `pins`, `topics` chuyển vào khung mà không đổi hành vi.
- **Hàng đợi gửi tổng quát** với `feature`, `payload`, đối tượng đích và hai loại hàng: *state* (một hàng cho mỗi đối tượng, hàng sau đè hàng trước) và *event* (nối đuôi).
- **Áp dụng đi vào Chat luôn là đặt trạng thái** nên idempotent: tiếng vang không tạo thay đổi thứ hai; hai bên đổi cùng lúc thì bên đến sau thắng; lần đối chiếu đầu lấy trạng thái app kia làm gốc.
- **R3 luôn tắt mặc định**, bật riêng từng chat và từng hành động, có xác nhận, nhật ký và hạn mức; rời nhóm và xoá nhóm không đồng bộ.
- **Bộ kiểm hợp đồng theo tính năng** chạy cho mọi adapter, kèm adapter giả có công tắc từng tính năng.

## Kết quả spike đã biết (Telegram, 18/11/2026)

- Ghi và nhận tách biệt: lệnh ghi không làm phiên gửi nhận lại sự kiện, nên không cần cơ chế chống dội riêng.
- Đã đọc ở thiết bị khác và đang gõ đến được dưới dạng sự kiện. Chưa xác nhận sự kiện cho tắt tiếng, ghim hội thoại, đánh dấu chưa đọc và reaction.
- Reaction cần tài khoản Premium ở «Tin nhắn đã lưu»; chưa rõ ở chat khác.

## Hệ quả

Chưa có (nháp).
