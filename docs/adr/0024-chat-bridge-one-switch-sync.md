# ADR 0024: Chat Bridge: một nút đồng bộ, không tuỳ chọn

Trạng thái: **đã chấp nhận** (19/11/2026), cài đặt theo [plan](../../../plans/dattqh/261119-1740-chat-bridge-one-switch-sync/plan.md). Thay phần tuỳ chọn của [ADR 0022](./0022-chat-bridge.md) (chọn chat, số tin, hướng) và [ADR 0023](./0023-chat-bridge-feature-model.md) (hướng theo từng tính năng, mặc định, mức nhanh); giữ mô hình tính năng làm cách viết adapter.

## Bối cảnh

Chat là nơi quản lý tập trung, Telegram và các app khác là nguồn chat chính (quyết định 18/11/2026). Giao diện chọn từng chat, số tin, hướng và bảng tính năng bắt người dùng quyết những điều không ai muốn quyết, và để Chat thiếu những chat chưa được chọn.

## Quyết định

- **Một trạng thái đồng bộ cho cả tài khoản:** tắt, đang nhập, trực tiếp. Sau khi đăng nhập, Chat hỏi một lần có đồng bộ không; đồng ý thì mọi cuộc trò chuyện (chat riêng, nhóm, kênh, bot) được liên kết, cuộc mới xuất hiện sau cũng tự vào.
- **Mỗi cuộc nhập 2.000 tin gần nhất**, cuộc có tin mới nhất trước; tin mới đến trong lúc nhập vẫn vào ngay. Không chèn được lịch sử cũ hơn tin đầu tiên đã nhập.
- **Mọi tính năng chạy theo hướng adapter hỗ trợ** (hai chiều khi có cả hai). Không còn hướng theo chat, theo tính năng hay mặc định theo tài khoản.
- **Hàng rào của hành động lên người và nhóm giữ nguyên ở từng lần làm:** hỏi xác nhận, nhật ký, giới hạn số lần; xoá nhóm hai bước. Chỉ bỏ công tắc bật riêng từng chat.
- **Thanh tiến trình tổng** của tài khoản: số cuộc đã nhập xong và số tin đã nhập trên tổng dự kiến.

## Số liệu (spike 19/11/2026, production)

- 8 chat đã đồng bộ: 9.396 tin, 549 tệp, 64 MB (trung bình 119 kB mỗi tệp, khoảng 7 kB mỗi tin). Đĩa máy chủ còn 30 GB.
- Tốc độ nhập thật: khoảng 1.000 tin mỗi phút kể cả tệp (chat 2.054 tin trong khoảng 2 phút).
- Tài khoản có khoảng 189 cuộc trò chuyện. Trần lý thuyết 378.000 tin và khoảng 2,6 GB tệp, khoảng 6 giờ; thực tế ít hơn nhiều vì phần lớn chat riêng có ít tin.

## Hệ quả

- Chat cũ có ít hơn 2.000 tin vì cửa sổ nhỏ: chỉ `tg_cloudpanel_staging_bot` (cửa sổ 200). Đại ca chọn xoá bản sao để nhập lại.
- Kênh mà chủ không có quyền đăng vẫn ở hướng hai chiều; Telegram từ chối khi gửi, lỗi hiện ở «Lỗi đồng bộ».
- Bỏ RPC và bảng của tuỳ chọn ở phase cuối; xử lý kiểm breaking của proto có chủ đích.
