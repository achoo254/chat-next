# Phase 2: Quay video, thanh quay, MCP quay

Tier: **L** (encoder, âm thanh, vòng đời clip, MCP). Trạng thái: pending. Bắt đầu sau khi phase 1 đã lên prod và đại ca nghiệm thu.

## Context

Dùng lại toàn bộ phần chọn vùng, phím tắt, IPC, tải lên, lịch sử, chính sách duyệt của [phase 1](phase-01-screenshot.md). Giao diện: chế độ "Quay video" trong [`prototype/capture-overlay-prototype.html`](prototype/capture-overlay-prototype.html), biến thể A (thanh quay nằm dưới vùng chọn, đếm ngược 3-2-1, đồng hồ, tạm dừng, dừng).

Ràng buộc từ hệ thống: server Chat nhận tệp tới 2 GB, hạn mức mỗi người 20 GB (`server/internal/config/media.go`); cầu nối Zalo chỉ chuyển tệp tới 25 MB (`bridge/adapters/zalo/send_media.go`).

## Requirements

1. `Ctrl+Alt+R` hoặc nút Quay trong composer: kéo chọn vùng, thanh quay dưới vùng chọn, viền đỏ nét đứt; bấm Bắt đầu thì đếm ngược 3-2-1.
2. Khi quay: đồng hồ, Tạm dừng/Tiếp tục, Dừng; micro và âm thanh hệ thống bật/tắt riêng, đổi được lúc đang quay; con trỏ chuột hiện trong video.
3. Đầu ra MP4 (H.264 + AAC) 30 fps, kích thước đúng vùng chọn (làm chẵn nếu cần); encoder phần cứng qua Media Foundation nếu có, nếu không dùng bộ mã hoá Media Foundation sẵn của Windows (không đóng kèm FFmpeg).
4. Mặc định tối đa 15 phút mỗi clip, cấu hình được (`tunelo config`), trần 2 GB; cảnh báo trước khi hết giờ; hết giờ thì dừng và giữ clip.
5. Sau khi dừng: Sao chép (đường tệp vào clipboard), Lưu, Gửi (danh sách chat như phase 1). Clip lớn hơn 25 MB có cảnh báo "không chuyển sang Zalo được".
6. MCP: `start_recording` (vùng/màn hình/cửa sổ), `stop_recording`, `get_recording_status`; mọi thao tác bắt đầu quay do AI phải được duyệt từng lần (có tuỳ chọn cho phép trong phiên), luôn có dấu hiệu đang quay trên màn hình và audit log; người dùng dừng được bằng phím tắt bất kỳ lúc nào.
7. Clip vào lịch sử 24 giờ như ảnh (giới hạn tổng dung lượng lịch sử, ví dụ 2 GB, xoá cũ nhất trước), **mã hoá khi nghỉ bằng khoá trong keystore như ảnh** (mã hoá theo luồng từng khối để clip hàng trăm MB không phải nạp hết vào bộ nhớ). <!-- Updated: Validation Session 1 - lịch sử mã hoá -->
8. Duyệt `start_recording` bằng hộp thoại native như phase 1 (không dùng thẻ web). <!-- Updated: Validation Session 1 -->

## Files (dự kiến)

- Mới: `apps/capture/src/record/` (frame source, audio, encoder, mux), mở rộng `docs/capture-wire.md` (lệnh `record_start|pause|resume|stop`, sự kiện tiến độ), cập nhật ADR 0031.
- Sửa: `apps/agent/src/capture/` (vòng đời clip, giới hạn, tải lên tệp lớn theo từng phần), `apps/agent/src/mcp/capture-tools.ts`, `proto/remote/v1/remote.proto` (yêu cầu quay + cờ khả năng), `apps/web` (nút Quay trong composer, hiển thị clip trong khay), i18n ba ngôn ngữ, `docs/acceptance.md`.

## Steps

1. **Spike quay**: lấy khung hình bằng Windows.Graphics.Capture hay DXGI Desktop Duplication; đo CPU/GPU và rớt khung ở 1080p và 1440p; thử encoder phần cứng NVENC/QSV/AMF qua Media Foundation; chốt và ghi vào ADR.
2. Nguồn khung hình theo vùng chọn + vẽ con trỏ; bộ đệm giữ nhịp 30 fps.
3. Âm thanh: WASAPI loopback (hệ thống) và micro, trộn thành một luồng AAC (hoặc hai luồng nếu spike cho thấy dễ hơn), đồng bộ với hình.
4. Mã hoá và ghi MP4 bằng Media Foundation Sink Writer; tạm dừng không để lại khoảng trống; tệp ghi dần để mất điện/crash vẫn phát được (fragmented MP4 hoặc ghi lại phần đã có).
5. Thanh quay biến thể A: Bắt đầu → đếm ngược → đồng hồ, tạm dừng, dừng, cảnh báo hết giờ; phím tắt dừng toàn cục.
6. Giới hạn thời lượng/dung lượng; tải lên tệp lớn bằng đường nhiều phần có sẵn (`start_media_upload`/`complete_media_upload`), tiến độ trên overlay, huỷ được.
7. Proto + web: nút Quay trong composer, clip vào khay đính kèm.
8. MCP: ba tool quay + chính sách duyệt, dấu hiệu "đang quay" không tắt được bởi AI.
9. Kiểm thử: Rust (đồng hồ, giới hạn, ghép tệp), TS (vòng đời, chính sách duyệt), web; thủ công.

## Validation

- Cùng gate như phase 1.
- Thủ công trên máy Windows của đại ca: quay 1 phút có tiếng hệ thống + micro, kiểm đồng bộ hình-tiếng; tạm dừng/tiếp tục; hết 15 phút (thu nhỏ giới hạn bằng cấu hình để thử nhanh); phát lại trên web và iOS; clip trên 25 MB có cảnh báo; AI gọi `start_recording` bị hỏi duyệt; rút điện giả lập (kill tiến trình) vẫn còn tệp phát được.
- Sau deploy: kiểm trên chat thật.

## Risk và rollback

- Đồng bộ âm thanh và rớt khung ở độ phân giải cao là rủi ro lớn nhất; spike bước 1 quyết định có cần giảm mặc định xuống vùng nhỏ hơn hay 24 fps.
- Quay làm máy giật: đo, giới hạn độ phân giải đầu ra nếu cần, ghi vào tài liệu.
- Rollback: `capture.recording.enabled=false` tắt riêng quay mà giữ chụp ảnh; proto cộng thêm nên web ẩn nút Quay khi thiếu cờ khả năng.
