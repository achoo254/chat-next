---
title: "Đóng gói nghiệm thu và tín hiệu phản hồi"
status: in-progress
created: 2026-10-19
---

# Đóng gói nghiệm thu và tín hiệu phản hồi

User 2026-10-19: tập trung PR/marketing; dev chỉ sửa nốt lỗi vặt, đóng gói nghiệm thu, và thấy được tín hiệu phản hồi của người dùng. Không làm tính năng lớn mới.

Hiện trạng prod (2026-10-19): 4 người dùng, 89 tin/7 ngày, 1 góp ý, 0 báo cáo vi phạm. Góp ý chỉ gửi qua bot Trợ lý; operator phải mở Kiểm duyệt › Góp ý mới thấy; không có số liệu tổng hợp; lỗi JS phía trình duyệt không được ghi.

## Phase (thứ tự theo Jev)

| # | Việc | Tier | Jev | Trạng thái |
|---|---|---|---|---|
| 1 | Tín hiệu phản hồi: mục "Góp ý" trong Cài đặt (0,91); góp ý/báo cáo mới báo ngay vào nhóm "Vận hành chat" (0,88); bản tin hằng ngày (0,85); ghi nhận lỗi JS phía client (0,85) | M | làm trước (0,64) | Xong code 2026-10-19 (migration 29, `FeedbackService`, `ops_digests`, `client_errors`) |
| 2 | Rà lỗi vặt trên prod: desktop, Windows 150% (1280×720, 1366×768), điện thoại 390×844; sửa | M | 0,24 | Đang làm: đã sửa "0 đang hoạt động", ẩn Báo cáo với chủ nhóm/kênh; còn rà cỡ 1280/1366/390 |
| 3 | Bộ nghiệm thu: danh sách tính năng, kịch bản kiểm, URL, bot và Mini App mẫu | S | 0,12 | [`docs/acceptance.md`](../../../docs/acceptance.md) |

## Tiêu chí xong

- Người dùng gửi góp ý từ Cài đặt trong 2 lần bấm; operator thấy ngay trong nhóm "Vận hành chat".
- Mỗi sáng nhóm "Vận hành chat" có bản tin số liệu ngày hôm trước.
- Lỗi JS phía client được đếm theo loại, không chứa PII, có trong bản tin.
- Danh sách lỗi vặt tìm được đã sửa hoặc ghi lý do để lại.
- Có tài liệu nghiệm thu trong `docs/`.

## Ngoài phạm vi

Native R7/R8, test tải lớn, ND13, tính năng lớn mới.
