# tunelo không xin Full Disk Access; quyền macOS theo từng thư mục, xác nhận trên web

Trạng thái: xong, phát hành tunelo 3.17.1 (18/11/2026; tag 3.17.0 hỏng ở test Linux, không phát hành) · Tier: L

## Kết quả mong muốn
- tunelo không bao giờ xin Full Disk Access (script cài, `tunelo login`, `tunelo status`, log, banner web đều bỏ).
- tunelo chỉ có quyền mặc định của macOS như Claude Code trong Terminal: mỗi thư mục được bảo vệ (Desktop, Documents,
  Downloads, iCloud Drive, `~/Library/CloudStorage/*`, ổ gắn ngoài `/Volumes/*`) được hỏi riêng.
- Trước khi tunelo chạm vào một thư mục như vậy lần đầu, web hiện hộp thoại xin xác nhận; chỉ khi người dùng bấm
  "Xin quyền" tunelo mới hỏi macOS (tiến trình con, không treo tunelo). macOS hỏi trên màn hình Mac thì web báo và cho mở
  màn hình máy; bị từ chối thì chỉ chỗ bật lại.

## Quyết định
- Chọn phương án A (người dùng chốt 18/11/2026). Thử nghiệm: tiến trình launchd không có Full Disk Access vẫn đọc được
  Desktop/Documents/Downloads/iCloud (lần đầu Documents chờ 8 giây), không ai thấy hộp thoại.
- Proto: `MachineInfo.mac_folders` (26), `MacFolderAccessAsk` (177, trả Ack, B gửi MachineInfo khi trạng thái đổi),
  `ERROR_REASON_MAC_FOLDER_ACCESS` (86, subject = thư mục được bảo vệ). Field Full Disk Access cũ giữ, không còn đặt.
- Máy đã có Full Disk Access: mọi thư mục coi như đã cho, không hỏi gì.

## Tiêu chí nghiệm thu
- Không còn đường nào mở cài đặt Full Disk Access; `OpenDiskAccessSettings` bị từ chối UNSUPPORTED_REQUEST.
- Mở phiên / duyệt thư mục / thêm dự án trong thư mục chưa xác nhận bị từ chối với lý do mới; web hiện hộp thoại.
- Duyệt thư mục home không chạm vào bên trong thư mục được bảo vệ chưa xác nhận.
- Test agent + web cho cổng, hộp thoại, trạng thái; typecheck/lint sạch; phát hành tunelo và ghim script cài.

## Giới hạn
- Hộp thoại của macOS chỉ bấm được trên Mac (hoặc qua chia sẻ màn hình). Lệnh do AI hoặc terminal tự chạy vào thư mục
  được bảo vệ khác giữa phiên vẫn có thể gặp hộp thoại của macOS mà web không thấy trước.
