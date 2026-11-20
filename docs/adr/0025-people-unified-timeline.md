# ADR 0025: Người và dòng thời gian gộp

Trạng thái: **đã chấp nhận** (20/11/2026, đại ca duyệt), cài đặt theo [plan](../../../plans/dattqh/261120-1119-unified-inbox/plan.md). Mở rộng [ADR 0022](./0022-chat-bridge.md): mô hình bridge giữ nguyên, thêm một lớp «người» ở trên.

## Bối cảnh

Chat là hộp thư chung của đại ca cho Telegram, Zalo và chính Chat. Một người có thể có mặt ở nhiều nền tảng: ở Chat họ là một tài khoản thật hoặc một user bóng (`external_users`) cho mỗi nền tảng. Hiện mỗi hội thoại là một chat riêng, nên cùng một người bị tách thành nhiều chat. Đại ca muốn mở một người là thấy dòng thời gian gộp các chat riêng 1-1 của họ, gửi được qua nền tảng chọn, mà dữ liệu gốc không đổi.

## Quyết định

- **Bảng mới `people`, `people_members`, `people_rejections`** gom user bóng và tài khoản Chat thật của cùng một người. Danh bạ (`contacts`) và mô hình bridge hiện có giữ nguyên. Migration chỉ thêm (expand-only).
- **Gợi ý tính khi xem, không lưu**; chỉ lưu cặp đại ca đã từ chối. Tín hiệu: tên trùng hẳn sau khi gấp dấu và chuẩn hoá khoảng trắng (yếu, luôn ghi «tên giống nhau, chưa xác minh»); số điện thoại trùng (mạnh) chỉ có khi adapter Zalo được duyệt. Không dùng ảnh, **không bao giờ tự nối**.
- **Nối bằng tay luôn có** («Nối với…»), vì tài khoản Chat thật không có số điện thoại nên cặp khác tên sẽ không bao giờ được gợi ý.
- **Phạm vi gộp: chỉ chat riêng 1-1.** Nhóm và kênh không bao giờ gộp.
- **Ứng viên và quyền:** một người dùng chỉ nối được các user mà họ có chat riêng 1-1 cùng, và chỉ thấy người và gợi ý của chính mình. Mọi RPC ghi kiểm từng `user_id` trong cùng giao dịch; id không thuộc tập ứng viên trả NotFound như `GetUsers`, không phân biệt «không tồn tại» với «không liên quan». Khoá ngoại `(person_id, owner_id)` giữ hai chủ khác nhau không lẫn.
- **Tên người ghim lúc nối** (tên tài khoản Chat thật nếu có, không thì tên danh tính lúc nối), không có chức năng đổi tên; đổi tên của danh tính sau đó không đổi tên người. Nối hai user đã thuộc hai người khác nhau thì gộp thành một (giữ id nhỏ nhất); tách đến khi còn dưới hai user thì xoá người. Khoá các dòng liên quan theo thứ tự id.
- **RPC nằm trong `UsersService`** cạnh danh bạ: `ListPeople`, `LinkUsers`, `UnlinkUser`, `ListLinkSuggestions`, `RejectLinkSuggestion`; cập nhật trực tiếp bằng `UpdatePeopleChanged` (field 33 của `oneof` trong `updates.proto`), client gọi lại `ListPeople` khi nhận và sau mỗi lần kết nối lại.
- **Dòng thời gian gộp là màn xem ảo, không chép tin.** Trộn ở client, mỗi chat gốc một bộ đệm riêng ngoài cửa sổ 120/6 của store, hiển thị giữa hai mốc. Trả lời, sửa, reaction đi theo nền tảng của tin; **không có xoá và chuyển tiếp** ở màn gộp. Đọc ở màn gộp là `markRead(chatId, maxShownSeq)` cho từng chat gốc tới tin đã hiện, không đánh dấu tới `topSeq`.
- **Gửi ở màn gộp:** từ hai chat gửi được trở lên thì ô gửi có hàng chọn đích `Gửi qua: [Telegram] [Zalo] [Chat]`, bật hoặc tắt từng app (luôn còn ít nhất một); mỗi app được chọn nhận một tin, nhãn ghi rõ nơi gửi. Lần đầu chỉ chọn sẵn app của tin gần nhất, sau đó nhớ theo người; popup xác nhận chỉ hiện một lần, ở lần đầu gửi tới nhiều app, không hỏi mỗi lần gửi. Chỉ một chat gửi được thì không có hàng chọn. Trả lời hay sửa một tin thì hàng chọn thu về app của tin đó. Không sửa `composer.tsx`.
- **«Tất cả»:** người đã nối hiện một dòng, dựng ở client chỉ trong view «Tất cả», badge đếm một lần; dòng người được ghim nếu có ít nhất một chat gốc được ghim (bỏ ghim ở chat gốc); thư mục nền tảng vẫn hiện từng chat.
- **Số điện thoại** (khi có Zalo): chỉ lưu HMAC có khoá trên `external_users`, không lưu số gốc, không ra khỏi server; chuẩn hoá E.164 bằng một hàm chung.
- **Xoá dữ liệu:** xoá tài khoản xoá `people_rejections`, `people_members` (cả hai chiều chủ và người được nối) và `people` của chủ; gỡ tài khoản bridge tách các user bóng của nó khỏi `people_members` trong cùng giao dịch. Thêm loại dữ liệu «liên kết danh tính» vào `docs/privacy/data-inventory.md`.
- **Nhật ký:** nối, tách, từ chối chỉ ghi `slog` có cấu trúc (chỉ id, không tên, không số điện thoại) để vào VictoriaLogs; không thêm bảng audit vì chưa có tính năng nào đọc lại. `people_rejections` ở Postgres vì truy vấn gợi ý đọc lại.

## Hệ quả

- Nối và tách không làm mất hay đổi tin nào; tách lại luôn được.
- Danh tính bị chiếm bằng cách giả tên chỉ gây gợi ý sai (đại ca vẫn phải xác nhận), không tự nối; đích gửi do đại ca chọn trên hàng chọn, không do hệ thống đoán, và nhãn nơi gửi luôn hiện.
- Tin của người dùng khác không bao giờ lộ qua `people`: truy vấn luôn lọc theo `owner_id`.
- Thêm một bảng ánh xạ vào luồng xoá dữ liệu và kiểm kê dữ liệu; thiếu một trong hai là lỗi riêng tư.
- Chỉ thêm field proto mới (kiểm breaking đạt); bản cũ không đọc các bảng mới nên lùi bản vẫn an toàn.
