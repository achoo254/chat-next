# Load test lượt 1 (Phase 14) — 2026-10-17

## Kết luận

- **Mức tải an toàn trên `.65`: 1000 người online, khoảng 100 tin/giây.** Ở mức này mọi chỉ số đều thấp hơn nhiều so với ngân sách: ack p99 21 ms, giao tin p99 82–88 ms, tìm kiếm p99 66–96 ms. RAM của api khoảng 150 MB.
- **1500 người (150 tin/giây) là sát ngưỡng.** Khi tăng dần thì vẫn đạt ngân sách (giao tin p99 407 ms). Nhưng khi cả 1500 người vào cùng lúc, việc giao tin bị dồn hàng tới khoảng 10 giây. Lúc đó máy đã bão hoà CPU: tải 4,8 trên 4 nhân.
- **2000 người: dừng.** Chốt RAM tự dừng lượt chạy khi RAM khả dụng của máy xuống 29%, dưới ngưỡng 30% mà plan yêu cầu chừa lại.
- **Nghẽn là CPU của cả máy, không phải code api.** Ở 1500 người, api chỉ dùng khoảng 0,4 nhân; phần còn lại thuộc về Postgres và công cụ tải chạy chung máy. Phần lớn thời gian của api là chờ các lượt gọi DB của gửi tin và bộ phát update.
- **Đã sửa một điểm:** connect nén gzip cả những phản hồi chỉ vài trăm byte, tốn khoảng 7% CPU của api. Giờ phản hồi dưới 1 KB không nén nữa.

## Cách đo

- Công cụ: `server/cmd/loadgen` (Go, dùng lại client proto/connect và socket thật). Jev chọn công cụ này thay cho k6 (1,0).
- Kịch bản: người dùng giả đăng nhập qua IdP giả bằng luồng OIDC thật, ngồi trong các nhóm 10 người, giữ socket realtime và gửi đều đặn mỗi người 1 tin/10 giây. Ngoài ra có 1 lượt tìm kiếm mỗi giây.
- Chỉ số:
  - **ack**: từ lúc gửi tới khi `SendMessage` trả lời.
  - **giao tin**: từ lúc gửi tới khi socket của 9 thành viên còn lại nhận được tin.
  - Mỗi bước có 10 giây khởi động, rồi đo 45–60 giây.
- Trên `.65` (Jev 0,99: tenant riêng): `infra/chat/load-round1.sh` chạy một tenant tạm dưới user `nobody` trong `/tmp/chat-load`, gồm Postgres riêng ở cổng 4930, IdP giả và api ở cổng 4900, đều chỉ nghe trên loopback. Script không chạm `pm2 chat-api` hay Postgres dùng chung, có chốt RAM 30%, và xoá sạch khi xong. Đã kiểm sau khi chạy: `chat-api` vẫn chạy liên tục, không thư mục hay process nào còn sót.
- Postgres dùng chung không cho role `chat` vào DB khác (pg_hba). Quy tắc vận hành lại cấm sửa cấu hình Postgres dùng chung, nên tenant tạm dùng Postgres riêng.

## Số đo trên `.65` (4 nhân, 7,7 GB, RAM khả dụng trước khi chạy 3,3 GB)

| Người online | Tin/giây | ack p50 / p99 | Giao tin p50 / p99 | Tìm kiếm p50 / p99 | Lỗi | RAM api |
|---|---|---|---|---|---|---|
| 250 | 25 | 5,1 / 10,0 ms | 18,2 / 35,3 ms | 30,8 / 46,5 ms | 0 | 82 MB |
| 500 | 50 | 5,5 / 14,1 ms | 19,8 / 43,3 ms | 31,7 / 49,6 ms | 0 | 107 MB |
| 1000 | 100 | 4,9 / 20,9 ms | 24,1 / 81,9 ms | 36,9 / 95,9 ms | 0 | 154 MB |
| 1500 (tăng dần) | 150 | 5,1 / 24,4 ms | 42,5 / 406,6 ms | 50,4 / 124,4 ms | 0 | 199 MB |
| 1500 (vào cùng lúc) | 150 | 10,0 / 37,2 ms | 10,4 / 11,7 **giây** | 82,6 / 140,5 ms | 0 | 195 MB |
| 2000 | 200 | — | — | — | — | chốt RAM dừng (29% < 30%) |

Ngân sách: ack p50 ≤ 60 / p99 ≤ 250 ms; giao tin p50 ≤ 150 / p99 ≤ 500 ms; tìm kiếm p50 ≤ 100 / p99 ≤ 500 ms. Hai dòng 1000 và 1500 lấy từ các lượt chạy khác nhau; lượt đầu cho 1000 người là ack 5,0/20,7 ms và giao tin 24,8/87,6 ms.

## Số đo trên máy dev (10 nhân, dùng chung với các phiên khác)

| Người online | Tin/giây | ack p50 / p99 | Giao tin p50 / p99 | RAM api |
|---|---|---|---|---|
| 1000 | 100 | 1,6 / 4,7 ms | 5,2 / 15,1 ms | 166 MB |
| 2000 | 200 | 1,4 / 16,1 ms | 4,2 / 36,5 ms | 254 MB |
| 3000 | 300 | 2,7 / 248,5 ms | 9,9 / 569 ms | 240 MB |

Bước 3000 không tin được: máy dev đã dùng 7,1/8 GB swap và process api bị đẩy ra khỏi RAM.

## Ghi chú kỹ thuật

- Update có thể tới trước `Hello` trên socket mới. Đây là thiết kế có chủ ý: gateway đăng ký kết nối trước rồi mới chào, và `GetDifference` bù phần còn lại. Client core xử lý theo `pts`, nên đây không phải lỗi.

## Quyết định sau lượt 1

- User 2026-10-17: đặt trần người online. Jev chọn trần theo số người khác nhau có socket realtime trên mỗi process (0,99), là 1000 người (0,61); người vượt trần không có thông báo riêng mà app giữ "Đang kết nối…" và tự thử lại (0,84). Đã làm: `CHAT_MAX_ONLINE_USERS`, mặc định 1000.
- Không có máy nào khác ngoài `.65` để chạy công cụ tải (user 2026-10-17): mọi lượt đo sau vẫn chạy chung máy, nên số đo là cận dưới.

## Còn lại của Phase 14

- Tìm nguyên nhân dồn hàng khi 1500 người vào cùng lúc (bộ phát update khi CPU bão hoà).
- Các kịch bản chưa chạy: chat lớn (10k, 100k), chuyển chế độ 200 sang 201, người dùng trong 100 nhóm, bot trong 5000 nhóm, upload media, webhook dồn 2000 req/s, gửi hàng loạt 100k, chaos, đo trên thiết bị thật, checklist phát hành.
