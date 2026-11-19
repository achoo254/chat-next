# ADR 0023: Chat Bridge: mô hình tính năng cho đồng bộ hai chiều và nhiều nền tảng

Trạng thái: **đã chấp nhận** (18/11/2026), đã cài đặt qua các phase của [plan](../../../plans/dattqh/261118-1800-chat-bridge-full-sync/plan.md). Bổ sung [ADR 0022](./0022-chat-bridge.md).

## Bối cảnh

ADR 0022 và các bước sau đó đã đưa vào hai chiều cho tin nhắn, ghim và topic bằng cách thêm từng interface riêng (`Sender`, `TopicReader`, `PinReader`, `Pinner`), từng giá trị `op` của `external_outbox` và một hướng duy nhất cho cả chat (`direction`). Mỗi tính năng mới và mỗi nền tảng mới sẽ đụng engine, bảng và giao diện ở nhiều chỗ. Cần một mô hình để thêm tính năng và nền tảng mà không sửa lõi.

## Quyết định

- **Tính năng là đơn vị** (`messages`, `pins`, `topics`, `read`, `notify`, `dialog`, `info`, `members`, `invites`, `lifecycle`, `alerts`; `reactions` từ 19/11/2026; còn `typing` đã đặt tên nhưng chưa có adapter nào làm). Mỗi tính năng có mức rủi ro cố định (R1 trạng thái cá nhân, R2 nội dung người khác thấy, R3 hành động lên người và nhóm) quyết định mặc định và điều kiện bật.
- **Hướng theo từng tính năng và từng chat** (`external_chat_features`: tắt, chỉ nhận, hai chiều); `direction` hiện có vẫn là hướng của `messages`.
- **Adapter khai báo `Features()`** (tính năng và hướng hỗ trợ); các `Cap*` hiện có suy ra từ đó. Giao diện và engine chỉ hiện và chạy những gì có.
- **`FeatureHandler` đăng ký tĩnh** trong engine; `messages`, `pins`, `topics` chuyển vào khung mà không đổi hành vi.
- **Hàng đợi gửi tổng quát** với `feature`, `payload`, đối tượng đích và hai loại hàng: *state* (một hàng cho mỗi đối tượng, hàng sau đè hàng trước) và *event* (nối đuôi).
- **Áp dụng đi vào Chat luôn là đặt trạng thái** nên idempotent: tiếng vang không tạo thay đổi thứ hai; hai bên đổi cùng lúc thì bên đến sau thắng; lần đối chiếu đầu lấy trạng thái app kia làm gốc.
- **R3 luôn tắt mặc định**, bật riêng từng chat, có xác nhận, nhật ký (`external_audit`) và hạn mức mỗi giờ. Rời nhóm và xoá nhóm là tính năng `lifecycle` riêng, chỉ chiều ra, không nối vào nút xoá chat của Chat (xoá bản sao không bao giờ xoá nhóm ở app kia); cần đăng nhập lại gần đây, gõ lại tên nhóm, xoá còn phải xác nhận lần hai bằng mã dùng một lần sau 10 giây và chỉ một lần mỗi giờ. `alerts` (tin mới của app kia báo trong Chat) tắt mặc định để nhóm đông không tự báo.
- **Mặc định theo tài khoản** (`external_feature_defaults`) được chép vào chat lúc đồng bộ, có thể áp cho mọi chat đã đồng bộ; không áp cho `messages` và R3.
- **Một trung tâm lỗi** liệt kê mọi hàng `failed`, `unknown` của outbox theo tài khoản, cho thử lại hoặc bỏ qua (tin gửi bỏ bằng cách xoá tin).
- **Bộ kiểm hợp đồng theo tính năng** chạy cho mọi adapter, kèm adapter giả có công tắc từng tính năng.

## Kết quả spike đã biết (Telegram, 18/11/2026)

- Ghi và nhận tách biệt: lệnh ghi không làm phiên gửi nhận lại sự kiện, nên không cần cơ chế chống dội riêng.
- Đã đọc ở thiết bị khác và đang gõ đến được dưới dạng sự kiện. Chưa xác nhận sự kiện cho tắt tiếng, ghim hội thoại, đánh dấu chưa đọc và reaction.
- Reaction cần tài khoản Premium ở «Tin nhắn đã lưu»; chưa rõ ở chat khác.

## Hệ quả

- Thêm tính năng hoặc nền tảng là thêm một mục vào bảng `handlers` ở `engine/handlers.go` hoặc một gói adapter; engine, bảng và bảng tính năng ở giao diện không đổi.
- Telegram khai báo: `messages`, `pins`, `topics`, `read` (vào và ra), `notify`, `dialog`, `info`, `members`, `invites` (vào và ra), `lifecycle` (ra), `alerts` (vào). Mọi thứ tác động lên người và nhóm mới được kiểm bằng test và adapter giả, **chưa kiểm trên Telegram thật** (xem G33–G41 ở `docs/acceptance.md`).
- Migration 0047–0051 chỉ mở rộng; hoàn tác là tắt tính năng ở bảng tính năng.
- Bộ kiểm hợp đồng (`contracttest.Run`) bắt adapter khai báo tính năng mà không cài interface.
- Reaction hai chiều làm ngày 19/11/2026: vào bằng sự kiện cộng đọc định kỳ 50 tin mới nhất (vì chưa chứng minh Telegram đẩy sự kiện ở mọi loại chat), ra là hàng trạng thái theo từng tin. Danh sách của Telegram có thể thiếu (nhóm lớn, emoji tuỳ chỉnh): khi thiếu thì chỉ thêm, không xoá; khi Telegram không nói reaction của chủ thì giữ nguyên của chủ.
- Còn lại, chưa làm: tin đang gõ, đọc theo chủ đề diễn đàn, chuyển tiếp và bản nháp.
