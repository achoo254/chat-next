# Nghiệm thu bản web (R0–R6)

Tài liệu cho người nghiệm thu: mở đâu, thử gì, kết quả đúng trông thế nào, giới hạn đã biết và cách gửi phản hồi. Thử trên prod, không cần cài gì.

## Mở ở đâu

| Thứ | Địa chỉ |
|---|---|
| App chat (tenant chính) | https://chat.hoandat.com |
| Tenant nghiệm thu thứ hai | https://chat.inetdev.io.vn (dữ liệu tách riêng hoàn toàn với tenant chính) |
| Developer Console | Cài đặt › Developer Console (https://chat.hoandat.com/console) |
| Tài liệu Bot API | [`docs/bot-api/README.md`](bot-api/README.md) |
| Mini App mẫu | https://achoo254.github.io/chat-next/miniapp-demo/ |

Đăng nhập bằng tài khoản hoandat.com (Google hoặc GitHub qua trang đăng nhập hoandat.com). Trình duyệt: Chrome, Edge, Safari, Firefox bản mới; điện thoại dùng trình duyệt hoặc cài thành app (Cài đặt › Cài ứng dụng). Nên thử ít nhất hai tài khoản để nhắn qua lại.

## Kịch bản kiểm

Cột "Kết quả" để người nghiệm thu ghi Đạt / Không đạt kèm ảnh chụp.

### Tài khoản và cài đặt

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| A1 | Đăng nhập lần đầu | Vào app; có "Cloud của tôi" ghim đầu danh sách và chat với bot Trợ lý | |
| A2 | Cài đặt › Hồ sơ: đổi tên hiển thị, username, ảnh đại diện (cắt ảnh) | Lưu được; người khác thấy theo luật riêng tư | |
| A3 | Cài đặt › Quyền riêng tư: đổi "Ai thấy ảnh đại diện", "Trạng thái hoạt động" | Người khác thấy đúng theo lựa chọn | |
| A4 | Cài đặt › Phiên đăng nhập: đăng xuất một phiên khác | Phiên đó bị đăng xuất | |
| A5 | Cài đặt › Thông báo: bật thông báo khi đã đóng app | Đóng tab, nhờ người khác nhắn: có thông báo | |
| A6 | Cài đặt › Tài khoản: xuất dữ liệu | Tải được tệp dữ liệu của mình | |

### Nhắn tin

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| B1 | Tìm người theo username, nhắn tin 1-1 | Tin tới ngay, có dấu đã gửi/đã xem | |
| B2 | Trả lời, sửa, xoá, chuyển tiếp, thả cảm xúc, ghim tin | Hai bên thấy cùng lúc | |
| B3 | Tạo nhóm có ảnh, mời bằng link mời | Người nhận link vào được nhóm | |
| B4 | Nhóm: phân quyền phó nhóm, cấm thành viên, bật chủ đề | Quyền áp đúng | |
| B5 | Tạo kênh, đăng bài | Người đăng ký đọc được, không trả lời được | |
| B6 | Gửi ảnh, album, video, file, ghi âm; tạm dừng rồi tiếp tục tải lên | Xem được trong trình xem; metadata vị trí bị xoá | |
| B7 | Tắt mạng, soạn và gửi tin, bật lại | Tin xếp hàng rồi tự gửi theo thứ tự | |
| B8 | Tìm "chuc mung" (không dấu) | Ra cả tin "chúc mừng" | |
| B9 | Chặn một người, báo cáo một tin | Người bị chặn không nhắn được; báo cáo vào hàng đợi kiểm duyệt | |

### Bot và Mini App

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| C1 | Developer Console › Tạo bot, cấp token | Có token (chỉ hiện một lần) | |
| C2 | Chạy bot ví dụ `echo` trong SDK TS, Python hoặc Go ([`sdk/`](../sdk)) với token đó | Bot trả lời trong 10 phút từ lúc bắt đầu | |
| C3 | Thêm bot vào nhóm, dùng menu lệnh `/` | Bot nhận lệnh, trả lời có nút bấm | |
| C4 | Console › Mini App: đặt URL https://achoo254.github.io/chat-next/miniapp-demo/, mở chat với bot, bấm "Mở app" | Mini App mở ở cột phải (điện thoại: toàn màn hình), đầu khung hiện `achoo254.github.io` | |
| C5 | Trong Mini App: Gửi dữ liệu cho bot, Xin quyền nhắn tin, Mở link ngoài, menu ⋯ › Tải lại / Thu nhỏ | Mỗi việc đều hỏi lại người dùng khi cần; thu nhỏ rồi mở lại giữ nguyên trang | |
| C6 | Nhóm › Webhook tích hợp: tạo webhook, gửi cảnh báo Grafana/GitLab mẫu | Cảnh báo vào nhóm, cập nhật tại chỗ khi resolved | |

### Vận hành

| # | Thao tác | Kết quả đúng | Kết quả |
|---|---|---|---|
| D1 | Tài khoản vận hành: Kiểm duyệt › Hàng đợi báo cáo, Góp ý | Thấy báo cáo và góp ý, xử lý được | |
| D2 | Nhóm "Vận hành chat" | Nhận cảnh báo vận hành (watchdog) và góp ý, báo cáo mới | |

## Giới hạn đã biết

- Chưa có app iOS/Android (R7); trên điện thoại dùng bản web hoặc cài thành app từ trình duyệt. Không có app desktop riêng (huỷ R8 ngày 20/10/2026: desktop = PWA).
- Server chưa có ffmpeg: video, audio do bot gửi chưa có ảnh xem trước, sóng âm và thời lượng.
- Ở bề rộng 761–1100 px, cột thông tin và Mini App phủ lên phần phải khung chat thay vì xếp thành cột riêng.
- Mỗi process phục vụ tối đa 1000 người online cùng lúc (giới hạn đã đo trên máy hiện tại); vượt thì người sau chờ "Đang kết nối…".

## Gửi phản hồi

- Trong app: Cài đặt › Góp ý, hoặc nhắn cho bot Trợ lý.
- Lỗi hiển thị: chụp màn hình kèm cỡ cửa sổ (hoặc tên máy điện thoại) và thời điểm.
- Người vận hành xem tại Kiểm duyệt › Góp ý và trong nhóm "Vận hành chat".
