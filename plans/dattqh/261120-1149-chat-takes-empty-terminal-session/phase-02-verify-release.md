# Phase 2: Nghiệm thu máy thật, docs, phát hành tunelo

Tier: S · Phụ thuộc: phase 1 · Trạng thái: chờ

## Việc
- `docs/terminal-wire.md` mục "Phiên AI trong terminal": ghi rằng phiên chưa có tin nào mà CLI giữ cũng được lấy lại, và
  điều kiện (một tiến trình đăng ký đúng id, đủ yên lặng). Đọc mục trước khi sửa, kiểm lại bằng mã sau khi sửa.
- Nếu bước đo ở phase 1 để lại cửa sổ rủi ro, ghi một dòng vào ADR hiện có về phiên terminal thay vì tạo ADR mới.
- Phát hành tunelo theo quy trình của repo, ghim script cài.

## Nghiệm thu máy thật (lặp lại kịch bản buổi thử 20/11)
1. Tạo phiên mới trong một dự án thử, bấm tab Terminal, đợi CLI hiện ô nhập, không gõ gì.
2. Sang tab Trò chuyện, gửi một tin ngắn. Kỳ vọng: không lỗi, tin chạy, banner biến mất, tab Terminal báo phiên đã chuyển
   sang Trò chuyện.
3. Mở terminal lại: resume đúng phiên, có tin vừa gửi.
4. Ca bận: ở terminal gõ một yêu cầu dài, trong lúc nó chạy gửi từ Trò chuyện. Kỳ vọng: bị từ chối, chữ còn trong ô soạn.
   Kèm ca sát nhất với phiên trống: phiên mới, gõ tin đầu ở terminal và gửi từ Trò chuyện ngay khi vừa nhấn Enter. Kỳ vọng:
   bị từ chối (xác nhận `status` sang `busy` kịp trước khi transcript xuất hiện).
5. Máy bản cũ: web giữ hành vi cũ (chỉ xem, nút mở terminal).

Phiên thử dùng phiên mới riêng trong dự án thử, không dùng phiên đang chạy việc thật; xoá hoặc lưu trữ sau khi xong khi người
dùng đồng ý.

## Tiêu chí xong
- Năm ca trên đạt trên máy thật; kết quả ghi vào plan này.
- CI xanh, tag phát hành đủ file, script cài ghim đúng bản.
