---
title: "tunelo 3.17.1 bỏ Full Disk Access, xin quyền macOS từng thư mục"
date: 2026-11-18
summary: tunelo không còn xin Full Disk Access; thư mục macOS bảo vệ chỉ được vào sau khi người dùng đồng ý trên web
---

# tunelo 3.17.1 bỏ Full Disk Access, xin quyền macOS từng thư mục

## What happened
- Người dùng muốn tunelo chỉ có quyền mặc định như Claude Code trong Terminal, không bắt cấp Full Disk Access, và mọi việc cần quyền phải hiện trên UI để xác nhận.
- Thử nghiệm: một binary ad-hoc chạy qua `launchctl bootstrap gui/<uid>` (giống tunelo), không có Full Disk Access, vẫn đọc được Desktop/Documents/Downloads/iCloud/ổ ngoài; lần đầu Documents chờ 8 giây, Photos bị giữ khoảng 10 giây. Không ai thấy hộp thoại trên màn hình, nên chưa chắc macOS có hỏi hay không.
- Tag `tunelo-v3.17.0` hỏng ở bước test trên Linux: handler `macFolderAccessAsk` kiểm `process.platform !== "darwin"`, nên test giả lập macOS bằng `MacFolders({ platform: "darwin" })` bị từ chối trên runner Linux. Sửa bằng `MacFolders.applies` rồi phát hành 3.17.1 (3.17.0 không có bản phát hành).

## Decision
- Proto: `MachineInfo.mac_folders` (26), `MacFolderAccessAsk` (177), `ERROR_REASON_MAC_FOLDER_ACCESS` (86). Field Full Disk Access cũ giữ nhưng không còn đặt; `OpenDiskAccessSettings` bị từ chối UNSUPPORTED_REQUEST.
- Agent (`apps/agent/src/safety/mac-folders.ts`): cổng chung chặn mở phiên, Cố vấn, mở lại phiên, duyệt thư mục, thêm/tạo/clone dự án, terminal trong thư mục chưa được cho. Việc hỏi macOS chạy trong tiến trình con `tunelo mac-folder-access <path>` (tối đa 5 phút), nên không bao giờ treo tunelo. Câu trả lời lưu ở `config.json` (`macFolders`). Máy đã có Full Disk Access coi mọi thư mục là đã cho.
- Web: `mac-folder-access.tsx` thay banner/guide Full Disk Access; hộp thoại theo trạng thái chưa hỏi / đang hỏi (nút mở màn hình máy) / đã cho / bị từ chối.
- Script cài, `tunelo login` và `tunelo status` không còn mở hay nhắc cài đặt Full Disk Access.

## Next steps
- Nghiệm thu trên một Mac chưa cấp Full Disk Access cho tunelo (hoặc gỡ tunelo khỏi danh sách đó trên Mac mini) để xem hộp thoại web và hộp thoại macOS thật.
- Giới hạn còn lại: `tunelo-term-host` có danh tính quyền riêng với macOS; AI hoặc terminal tự vào một thư mục được bảo vệ khác giữa phiên vẫn có thể gặp hộp thoại macOS mà web không biết trước; symlink trỏ vào thư mục được bảo vệ không bị cổng nhận ra.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
