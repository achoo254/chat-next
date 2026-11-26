# Phase 1: Chụp ảnh, chú thích, gửi, nút trong Chat, MCP chụp

Tier: **L** (Rust mới + agent TS + proto + web + MCP + đóng gói). Trạng thái: pending.

## Context

[plan.md](plan.md) chốt kiến trúc. Bản mẫu giao diện biến thể A: [`prototype/capture-overlay-prototype.html`](prototype/capture-overlay-prototype.html) (ba chế độ; chỉ chế độ Chụp ảnh và Ô soạn tin thuộc phase này).

Điểm tựa trong repo (đã quét):

- Tiến trình Rust nền: `apps/term-host` (đặc tả `docs/terminal-wire.md`); `tunelo` giám sát qua `apps/agent/src/terminal/host-supervisor.ts`, `host-link.ts`.
- Kênh điều khiển cục bộ có token: `apps/agent/src/control-socket.ts`.
- MCP của `tunelo`: `apps/agent/src/mcp/` (đăng ký tool theo nhóm, `write-approvals.ts`, `confirm-tokens.ts`, `chat-file-tools.ts`).
- Tải tệp lên Chat: `apps/agent/src/attachments/uploads.ts` (từ thiết bị vào máy) và đường media của server (`start_media_upload`, `complete_media_upload`, `send_media`, ADR 0012).
- Web biết máy hiện tại: `apps/web/src/machines/local-machine.tsx`; ô soạn tin của Chat `apps/web/src/messaging/ui/composer.tsx` và khay đính kèm `apps/web/src/messaging/media/attach-tray.tsx` + `media-state.ts` (`addAttachments`). Không nhầm với `machines/attachment-tray.tsx` (khay của phiên AI Agent). <!-- Updated: Validation Session 1 - sửa đường dẫn khay đính kèm -->
- Giao thức máy: `proto/remote/v1/remote.proto`, `packages/remote-protocol`.
- Đóng gói: `apps/agent/scripts/package-release.sh`, script cài `install.ps1`, workflow `agent-release.yml`.

## Requirements

1. `tunelo-capture` (Windows) có phím tắt toàn cục, overlay kéo chọn vùng trên mọi màn hình, thanh công cụ biến thể A, 5 công cụ chú thích, hoàn tác, thoát bằng `Esc`.
2. Kết quả (PNG) luôn vào clipboard; nút Lưu ghi vào Pictures; Gửi/Hỏi AI theo plan.
3. Nút Chụp màn hình trong composer hoạt động qua kênh máy hiện có; ảnh vào khay đính kèm của chat đang mở.
4. MCP `tunelo` có: `capture_interactive`, `capture_screen`, `capture_window`, `list_displays_windows`, `get_recent_captures`/`get_capture`, `send_capture_to_chat`; chính sách quyền theo plan.
5. Lịch sử 20 mục, 24 giờ; dọn tự động.
6. Cài và cập nhật `tunelo-capture` cùng `tunelo` (script cài, `tunelo update`, gỡ cài).

## Files (dự kiến)

- Mới: `apps/capture/` (Cargo.toml, `src/`: hotkey, grab, overlay, annotate, ipc, clipboard), `docs/capture-wire.md`, `docs/adr/0031-screen-capture.md`.
- Mới: `apps/agent/src/capture/` (supervisor, history, upload, notify), `apps/agent/src/mcp/capture-tools.ts`.
- Sửa: `apps/agent/src/service.ts` (khởi động/dừng), `apps/agent/src/config.ts` (phím tắt), `apps/agent/src/cli.ts` (`tunelo capture status`), `apps/agent/scripts/package-release.sh`, `apps/web/public/agent/install.ps1` (và bản `install.sh`) cùng script gỡ, `apps/agent/README.md`.
- Sửa: `proto/remote/v1/remote.proto` + `packages/proto-ts` (CaptureRequest/CaptureResult, cờ khả năng), `apps/agent/src/link/` (xử lý tin mới).
- Sửa: `apps/web/src/messaging/ui/composer.tsx` + một tệp nút mới, i18n `copy-vi/en/zh-CN`, `docs/acceptance.md`, `docs/README.md` (mục lục ADR).

## Steps

1. **Spike công nghệ overlay** (kết quả ghi vào ADR): thử egui/eframe trong suốt toàn màn hình và Win32 layered window + Direct2D; tiêu chí: nhiều màn hình, DPI khác nhau, độ trễ kéo chọn, kích thước file, khả năng vẽ 5 công cụ. Chọn một.
2. **ADR 0031** và `docs/capture-wire.md`: IPC giữa `tunelo` và `tunelo-capture` (pipe có tên + token như `control-socket`, JSON dòng), lệnh `capture_interactive|capture_region|capture_screen|capture_window|list_targets`, sự kiện kết quả (đường dẫn tệp trong `captures/`, kích thước), mã lỗi (`hotkey_taken`, `cancelled`, `no_display`).
3. **`tunelo-capture` lõi**: phím tắt (`RegisterHotKey`), chụp màn hình (DXGI Desktop Duplication hoặc GDI cho ảnh tĩnh, quyết theo spike), danh sách cửa sổ/màn hình, clipboard PNG, ghi PNG.
4. **Overlay + chú thích**: kéo chọn, nút theo biến thể A, 5 công cụ, 4 màu, hoàn tác; làm mờ bằng mosaic thật trên điểm ảnh gốc (không phải lớp phủ); xuất ảnh gộp.
5. **Giám sát phía `tunelo`**: khởi động `tunelo-capture` cùng service, khởi động lại khi chết, trạng thái ở `tunelo status`; hỗ trợ ngôn ngữ hệ điều hành cho chữ trên overlay.
6. **Gửi vào Chat**: danh sách chat gần nhất qua MCP của Chat bằng token của máy (cùng đường `chat-inbox` đang dùng: `list_chats`), ô tìm kiếm; tải lên theo đường media sẵn có rồi gửi; "Hỏi AI" đính vào cuộc chat AI.
7. **Lịch sử** 20 mục / 24 giờ + dọn tự động; thư mục trong cấu hình của `tunelo`, quyền chỉ người dùng; **tệp mã hoá bằng khoá trong keystore của `tunelo`** (`keystore.ts`), giải mã khi AI đọc sau khi được duyệt hoặc khi gửi. <!-- Updated: Validation Session 1 - mã hoá lịch sử -->
8. **Proto + kênh máy**: thêm tin yêu cầu chụp và kết quả vào `remote.proto` (cộng thêm), cờ khả năng trong heartbeat; `tunelo` bản cũ không có cờ thì web ẩn nút và báo cần cập nhật; ảnh về web bằng đường tệp đính kèm hiện có.
9. **Web**: nút Chụp màn hình trong composer (chỉ hiện khi máy này có `tunelo` có cờ khả năng; không có thì gợi ý cài), vào khay đính kèm; i18n ba ngôn ngữ; kiểm trên Chrome.
10. **MCP**: đăng ký 6 tool ở `capture-tools.ts`; `capture_interactive` không cần duyệt; chụp toàn màn hình, chụp cửa sổ và đọc ảnh cũ duyệt qua **hộp thoại native do `tunelo-capture` hiện** (thêm lệnh `confirm` vào IPC và `capture-wire.md`), lõi khoá dùng một lần lấy từ `write-approvals`, tuỳ chọn cho phép trong phiên; hộp thoại không bị AI bấm hộ được; <!-- Updated: Validation Session 1 - duyệt bằng hộp thoại native -->
    ảnh trả về thu nhỏ cạnh dài tối đa ~1568 px; audit log + thông báo trên máy mỗi lần AI chụp.
11. **Đóng gói**: thêm `tunelo-capture` vào file nén Windows, script cài/gỡ, minisign + SHA-256 (chưa ký Authenticode, đại ca chốt ký sau), `tunelo update`; README ghi cảnh báo SmartScreen/Defender có thể gặp lần đầu và cách xử lý; kiểm cài trên máy thật; `docs/acceptance.md`. <!-- Updated: Validation Session 1 - Authenticode sau -->
12. **Kiểm thử**: Rust (hình học vùng chọn, phân tích phím tắt, IPC), TS (lịch sử, chính sách duyệt, MCP với giả lập IPC), web (nút, khay); thủ công theo danh sách dưới.

## Validation

- `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` (`apps/capture`); `pnpm lint`, `pnpm typecheck`, `pnpm test` của `apps/agent`, `apps/web`, `packages/remote-protocol` (từng gói một).
- Thủ công trên máy Windows của đại ca (agent không tự bấm phím tắt toàn cục được): phím tắt ở ứng dụng khác; hai màn hình DPI khác nhau; kéo chọn từ mọi hướng; 5 công cụ; làm mờ che được chuỗi token mẫu (kiểm bằng cách phóng ảnh xuất); Gửi vào chat; nút trong composer; AI gọi 3 loại tool và hành vi duyệt/từ chối.
- Sau deploy: kiểm trên chat thật; `tunelo` phát hành qua `agent-release.yml`, cài lại máy thật bằng script cài.

## Risk và rollback

- Rủi ro theo bảng ở plan.md. Thêm: spike chọn sai công nghệ → mất một vòng, nên làm bước 1 trước hết.
- Rollback: web ẩn nút nếu không có cờ khả năng (gỡ `tunelo` bản mới không phá Chat); `tunelo-capture` là tiến trình riêng nên tắt bằng cấu hình `capture.enabled=false` mà không ảnh hưởng tunnel, terminal, AI Agent.
- Thay đổi proto chỉ cộng thêm; không migration DB; không đụng dữ liệu production.
