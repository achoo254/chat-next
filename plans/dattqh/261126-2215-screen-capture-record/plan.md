---
title: "Chụp ảnh và quay màn hình trong Chat, có MCP cho AI"
description: "tunelo-capture (Rust) chụp ảnh kèm chọn vùng và chú thích kiểu Zalo, quay vùng chọn kiểu Bandicam; nút trong ô soạn tin Chat; tool MCP của tunelo cho AI."
status: pending
priority: P2
effort: "L + L (hai phase)"
tags: [tunelo, capture, mcp, composer, windows]
created: 2026-11-26
---

# Chụp ảnh và quay màn hình trong Chat, có MCP cho AI

## Overview

Người dùng muốn chụp ảnh màn hình có chọn vùng và chú thích như Zalo, quay màn hình theo vùng chọn như Bandicam, gắn vào ứng dụng Chat, và có MCP để AI dùng được. Chat không có app desktop (desktop là PWA, ADR 0013) nên không đăng ký được phím tắt toàn cục hay vẽ lớp chọn vùng đè lên màn hình. Engine vì vậy nằm ở máy người dùng, trong hệ `tunelo` đã cài sẵn.

Đại ca chốt 26/11/2026 qua phiên phỏng vấn, mọi quyết định dưới đây là của đại ca, không phải suy đoán.

## Outcome đã chốt

- **Engine ở `tunelo`**: tiến trình Rust mới `tunelo-capture`, theo mẫu `apps/term-host`, đóng chung gói `tunelo` và script cài. `tunelo` điều phối, tải lên Chat và phục vụ MCP.
- **Chỉ chụp tại chỗ.** Chụp/quay từ xa (máy A điều khiển máy B) ngoài phạm vi.
- **Hai phase**: phase 1 chụp ảnh + MCP chụp; phase 2 quay video + tool quay. Windows trước; macOS, Linux, mobile để sau mà không đổi kiến trúc.
- **Giao diện biến thể A** (thanh ngang dưới vùng chọn, kiểu Zalo; thanh quay cũng nằm dưới vùng quay). Bản mẫu duyệt: [`prototype/capture-overlay-prototype.html`](prototype/capture-overlay-prototype.html). Biến thể B, C bỏ.
- Chú thích đủ 5 công cụ: khung, mũi tên, bút, chữ, làm mờ. Nút: Sao chép, Lưu, Hỏi AI, Gửi.
- "Gửi": luôn copy vào clipboard; danh sách chat gần nhất kèm ô tìm kiếm; tải lên bằng đường media sẵn có. "Hỏi AI" đính ảnh vào cuộc chat AI (ADR 0028).
- Nút **Chụp màn hình** và **Quay** trong ô soạn tin Chat; bấm thì trang Chat ra lệnh cho `tunelo` trên máy này qua kênh mã hoá sẵn có, ảnh vào khay đính kèm của chat đang mở. Máy chưa cài `tunelo` thì nút gợi ý cài.
- Quay: MP4 (H.264 + AAC) qua Windows Media Foundation, 30 fps, encoder phần cứng nếu có; micro và âm thanh hệ thống bật/tắt riêng; con trỏ hiện trong video; tối đa 15 phút mỗi clip (cấu hình được, trần 2 GB); cảnh báo khi clip lớn hơn 25 MB vì cầu nối Zalo không chuyển được.
- Lưu trữ: mặc định chỉ clipboard và gửi; nút Lưu ghi ra Pictures; lịch sử 20 mục gần nhất giữ 24 giờ trong thư mục cấu hình của `tunelo` để `get_recent_captures` đọc.
- Quyền AI: `capture_interactive` luôn cho phép (người dùng tự chọn vùng); `capture_screen`, `capture_window`, đọc ảnh cũ phải duyệt từng lần, có tuỳ chọn cho phép trong phiên; ghi audit log và hiện thông báo trên máy mỗi lần AI chụp. <!-- Updated: Validation Session 1 - duyệt bằng hộp thoại native của tunelo-capture, không dùng thẻ duyệt web --> **Duyệt bằng hộp thoại native trên máy do `tunelo-capture` hiện** (cố vấn quyết 26/11, độ tin 92%): thẻ duyệt `mcp/write-approvals.ts` gắn với giao diện web của phiên AI Agent, còn AI client chạy qua `tunelo mcp` (như Claude Code) không có giao diện đó. Dùng lại phần lõi của `write-approvals` (khoá theo công cụ + tham số, dùng một lần, hạn 60 giây) nhưng nguồn bấm duyệt là hộp thoại native.
- Lịch sử 20 mục/24 giờ **mã hoá khi nghỉ bằng khoá giữ trong keystore của `tunelo`** (cố vấn quyết 26/11, độ tin 67%); chỉ tệp người dùng chủ động Lưu ra Pictures là không mã hoá. <!-- Updated: Validation Session 1 - lịch sử mã hoá -->
- Phím tắt mặc định `Ctrl+Alt+A` (chụp), `Ctrl+Alt+R` (quay); đổi được trong `tunelo config`.

## Constraints

- Repo công khai: không ghi IP, secret, token, số điện thoại vào code, test, log hay ảnh mẫu.
- Chỉ `pnpm`; gate TS: `pnpm lint` → `pnpm typecheck` → `pnpm test` của đúng gói; Rust: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` trong `apps/capture`. Máy dev dùng chung: chạy từng gói, không chạy song song job nặng; bộ đầy đủ chạy trên CI.
- Ba ngôn ngữ giao diện (vi, en, zh-CN) cho mọi chữ mới ở web; chữ trên overlay theo ngôn ngữ hệ điều hành như `tunelo` đang làm.
- Nội dung màn hình có thể nhạy cảm: không ghi nội dung ảnh/âm thanh vào log; ảnh chỉ rời máy khi người dùng bấm Gửi hoặc AI được duyệt.
- Tên sản phẩm chỉ khai ở `brand.config.json` (`pnpm check:brand`).
- Hợp đồng proto/remote đổi theo kiểu cộng thêm; bản `tunelo` cũ không hiểu tin mới phải được báo "cần cập nhật" thay vì lỗi im lặng.

## Non-goals

- Chụp/quay từ xa máy khác; quay máy khác qua relay.
- macOS, Linux, mobile (kế hoạch sau, cùng giao thức IPC).
- Chỉnh sửa video, xuất GIF, WebM, phát trực tiếp.
- Nhận dạng chữ (OCR) trong ảnh; tự động che thông tin nhạy cảm.
- Quay từng cửa sổ riêng (chỉ quay vùng chọn trên màn hình).

## Phases

| # | Phase | Tier | Phụ thuộc |
|---|-------|------|-----------|
| 1 | [Chụp ảnh, chú thích, gửi, nút trong Chat, MCP chụp](phase-01-screenshot.md) | L | — |
| 2 | [Quay video, thanh quay, MCP quay](phase-02-recording.md) | L | phase 1 lên prod |

## Acceptance (toàn plan)

1. Trên Windows, `Ctrl+Alt+A` ở bất kỳ ứng dụng nào: kéo chọn vùng, vẽ chú thích, bấm Gửi vào một chat, ảnh xuất hiện trong chat đó với đúng nội dung và kích thước.
2. Nút **Chụp màn hình** trong ô soạn tin đưa ảnh vào khay đính kèm của chat đang mở.
3. AI (Claude Code) gọi `capture_interactive` thấy ảnh; gọi `capture_screen` thì máy hỏi duyệt, từ chối thì không có ảnh và có dòng audit.
4. Phase 2: quay vùng chọn có tiếng, dừng, gửi vào chat, phát được trên web và iOS; clip lớn hơn 25 MB có cảnh báo.
5. Gate xanh (lint, typecheck, test, clippy) và CI xanh; deploy theo quy trình chuẩn, kiểm trên site thật.

## Rủi ro

| Rủi ro | Xử lý |
|---|---|
| Overlay trong suốt sai khi nhiều màn hình, DPI khác nhau (125%, 150%) | Spike ở phase 1 bước 1, kiểm thủ công 2 màn hình DPI khác nhau |
| Phím tắt toàn cục bị ứng dụng khác chiếm | Báo lỗi rõ ở `tunelo capture status`, cho đổi phím trong `tunelo config` |
| Cửa sổ nội dung bảo vệ (DRM) hoặc màn hình UAC chụp ra đen | Ghi rõ giới hạn trong tài liệu; không cố vượt |
| Phần mềm diệt virus nghi file không ký | Ký minisign như hiện có, kiểm Windows Defender; phát hành trước, ký Authenticode sau (đại ca chốt); ghi cách xử lý cảnh báo SmartScreen vào README |
| `tunelo` bản cũ + web mới (lệch giao thức) | Cờ khả năng trong heartbeat; web ẩn nút hoặc báo cần cập nhật |
| AI bị prompt injection để chụp màn hình | Chính sách duyệt từng lần, audit log, thông báo trên máy (đã chốt) |

## Câu hỏi còn mở

Không còn câu hỏi cho đại ca. Còn một quyết định kỹ thuật: công nghệ vẽ overlay (egui hay Win32 + Direct2D) do phase 1 bước 1 (spike) chốt và ghi vào ADR.

**Đã chốt 26/11/2026 (đại ca):** phát hành `tunelo-capture` trước với chữ ký minisign + SHA-256 như hiện có, ký Authenticode làm sau (không chặn phát hành). Hệ quả cần ghi trong tài liệu cài: lần đầu Windows có thể hiện cảnh báo SmartScreen/Defender; kiểm trên máy thật khi phát hành và ghi cách xử lý vào `apps/agent/README.md`. <!-- Updated: Validation Session 1 - Authenticode sau -->

## Validation Log

### Session 1 (26/11/2026)

- `ak plan validate`: cấu trúc hợp lệ.
- Xác minh tuyên bố với repo: **đạt** hạn mức 2 GB/20 GB (`server/internal/config/media.go`), cầu nối Zalo 25 MB, `mcp/write-approvals.ts`, `chat-inbox` gọi MCP của Chat (`list_chats`) bằng token của máy, `config.ts`, `docs/acceptance.md`, `docs/README.md`, `agent-release.yml`, số ADR 0031 còn trống. **Sai và đã sửa**: plan trỏ khay đính kèm của chat vào `machines/attachment-tray.tsx` (thuộc luồng AI Agent), đúng là `messaging/media/attach-tray.tsx` + `media-state.ts` (`addAttachments`); script cài Windows ở `apps/web/public/agent/install.ps1`, không ở `apps/agent/scripts`.
- Câu hỏi gửi cố vấn: (1) nơi hiện hộp duyệt, (2) ký Authenticode, (3) bảo vệ lịch sử khi nghỉ. Kết quả: (1) native, tin; (3) mã hoá bằng keystore, tin; (2) không chắc, chuyển đại ca; đại ca chốt: phát hành trước với minisign, ký Authenticode sau.
- Đã lan truyền vào `phase-01` và `phase-02` (đánh dấu `Updated: Validation Session 1`).
