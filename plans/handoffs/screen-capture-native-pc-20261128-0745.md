---
handoff-version: 1
generated: 2026-11-28T00:45:00Z
generator: ak-handoff
focus: "ghi handoff để PC pull code về làm tiếp"
workspace: chat-next
branch: main
head: 3c5cedb1
---

# HANDOFF: Chụp màn hình native (tunelo-capture) trong Chat — làm tiếp trên PC Windows

## Mission and current status

"ghi handoff để PC pull code về làm tiếp"

Outcome: chụp màn hình có chọn vùng và chú thích kiểu Zalo bằng tiến trình native `tunelo-capture` (Rust, `apps/capture`), gọi được từ ô soạn tin Chat, từ phím tắt toàn cục và (sau này) từ MCP cho AI. Bản web (getDisplayMedia + chọn vùng) giữ làm dự phòng cho máy chưa cài tunelo.

Done:
- Bản web chụp/quay có chọn vùng, phím Alt+S / Alt+R: trên prod.
- Engine Rust `apps/capture`: overlay đóng băng khung hình mỗi màn hình, chọn vùng, 5 công cụ chú thích (khung, mũi tên, bút, chữ có IME, làm mờ), Sao chép/Lưu/Hỏi AI/Gửi, phím tắt toàn cục (mặc định Ctrl+Alt+A, đổi bằng `tunelo config capture-hotkey`).
- Tích hợp: proto (`CaptureRequest`/`CaptureResult`/`CaptureInfo`), `CaptureService` trong agent, composer Chat tự chọn "máy này" (nhớ trong localStorage `chat.capture.machine`), fallback web.
- Pipeline phát hành: build-capture (macOS arm64/x64, Windows x64), ký Developer ID + kiểm designated requirement trên macOS, minisign, đóng vào archive; `tunelo update` và install.sh/install.ps1 cài `tunelo-capture` cạnh `tunelo`.
- tunelo 3.31.1 đã phát hành; script cài trên prod ghim 3.31.1; web đã deploy.
- 3.31.1 sửa lỗi: cập nhật từ bản ≤ 3.30.x (code cũ chạy update) bỏ sót overlay → agent khi khởi động tự tải overlay từ chính release đang chạy (`installMissingCapture`), `tunelo update` cũng cài bù.
- Mac của đại ca: tunelo 3.31.1, `tunelo-capture` đang chạy, chữ ký `com.hoandat.tunelo.capture`.

Remaining:
- Đại ca nghiệm thu trên Mac (chưa có kết quả).
- **Kiểm tay trên Windows (việc của PC)**: chưa ai chạy overlay thật trên Windows.
- Chữ trên overlay ra tiếng Anh trên Mac (dịch vụ nền không có locale → `en-US`).
- Các mục sau của plan: danh sách chat cho nút "Gửi" từ phím tắt (hiện chỉ vào clipboard), MCP capture có duyệt native, lịch sử mã hoá 20 mục/24 giờ, phase 2 quay video native.

Urgency: P2.

## Scope and guardrails

Workspace: repo `chat-next` (public), nhánh `main`. Trên PC: thư mục tương ứng `/d/CONG VIEC/<...>/chat-next` theo ánh xạ đường dẫn Mac → Windows.

In scope: kiểm và sửa `tunelo-capture` trên Windows; các mục Remaining ở trên khi đại ca yêu cầu.

Out of scope: chụp/quay từ xa (máy A điều khiển máy B); Linux overlay (chưa build cho Linux).

Constraints:
- Repo công khai: không ghi IP, cổng SSH, secret, token vào file/commit.
- Chỉ `pnpm`, không npm. Làm trên `main`, không tạo branch/PR.
- Gate TS: lint → typecheck → test của đúng gói; Rust: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` trong `apps/capture`. Bộ đầy đủ chạy trên CI.
- Push lên `main` xong thì kiểm CI rồi deploy prod: `bash tools/deploy-prod.sh chat-next` chạy từ thư mục gốc workspace `hoandat-app` (không chạy từ trong repo). Không cần hỏi trước khi deploy.
- Đổi agent tunelo: tăng `apps/agent/src/version.ts`, commit `chore(agent): X.Y.Z`, CI xanh rồi mới gắn tag `tunelo-vX.Y.Z`; sau publish: tải `SHA256SUMS`, `node apps/agent/scripts/pin-release.ts X.Y.Z <SHA256SUMS>`, commit "chore(agent): pin the install scripts to tunelo X.Y.Z", push, deploy.
- Tiếng Việt khi trả lời đại ca; chữ giao diện web đủ vi, en, zh-CN.
- Không chạy song song job nặng (test suite, install, build).

Safety boundaries: vẫn hỏi trước khi ghi dữ liệu tay lên prod, restore, sửa bí mật/OAuth, chạy script setup, `MIU_RELEASE_FORCE`. Không xoá tin nhắn thử trong "Cloud của tôi" khi chưa được đồng ý.

## Current state

- Branch: `main`, đồng bộ `origin/main` lúc ghi.
- HEAD: `3c5cedb1940bc5285178f6d5cbf45c69be50a26e` (2 commit mới nhất do phiên khác đẩy, không liên quan capture).
- Working tree: sạch trước khi ghi file handoff này.
- Changed files: không có.
- Untracked files: không có (ngoài file này, sẽ được commit).
- Intentional local modifications: no.

## Decisions and rationale

| Decision | Rationale | Alternative rejected | Reference |
|---|---|---|---|
| Engine native `tunelo-capture` + giữ bản web dự phòng | Chat là PWA, không có phím tắt toàn cục/overlay đè màn hình | Chỉ bản web | `docs/adr/0031-screen-capture.md` |
| Mac được nghiệm thu trước | Đại ca làm việc trên Mac | Windows trước như plan gốc | Lời đại ca 27/11 |
| Phím mặc định Ctrl+Alt+A (⌃⌥A trên Mac), người dùng tự đổi | Đại ca chốt | Phím khác | `apps/agent/src/commands/capture-hotkey.ts` |
| "Máy này" nhớ theo trình duyệt | Đại ca chọn (Recommended) | Hỏi mỗi lần / theo tên máy | `apps/web/src/machines/native-capture.ts` |
| IPC stdin/stdout JSON lines giữa tunelo và tunelo-capture | Đơn giản, giống term-host | Socket/RPC | `docs/capture-wire.md` |
| Agent tự cài bù overlay khi khởi động | Update từ bản cũ chạy code cũ nên không biết file mới | Chỉ sửa `update()` (không cứu được máy cập nhật từ 3.30.x) | commit `185e6d7b` |

## Work performed

- Rust crate mới `apps/capture` (geometry, annotate, compose, text, toolbar, wire, overlay, platform, main). Trên Windows/Linux màn hình nào winit không khớp thì phủ bằng cửa sổ theo vị trí + kích thước (`platform.rs` `cover`).
- Agent: `src/capture/capture-service.ts`, `capture-settings.ts`, `commands/capture-hotkey.ts`, `machine.ts`, `link/connection.ts`, `update.ts` (`captureAssetName`, `installCapture`, `repairRelease`, `installMissingCapture`).
- Web: `src/machines/native-capture.ts`, `messaging/ui/composer.tsx`, `messaging/ui/attach-menu.tsx`, bản dịch vi/en/zh-CN.
- Release: `.github/workflows/agent-release.yml` (job `build-capture`, ký/kiểm requirement), `ci.yml` (job `capture-windows`), `apps/agent/scripts/package-release.sh`, `apps/agent/macos/designated-requirements.txt`, `apps/web/public/agent/install.sh` + `install.ps1`.
- Phát hành: `tunelo-v3.31.0`, rồi `tunelo-v3.31.1` (lần đầu 4 job macOS bị GitHub huỷ vì chờ runner quá 15 phút, chạy lại xanh).
- 0 redactions applied.

## Verification

| Check | Command | Outcome | When |
|---|---|---|---|
| Rust capture | `cargo fmt --check && cargo clippy -D warnings && cargo test` (apps/capture) | 26 test xanh | 27/11 |
| Clippy Windows | `cargo clippy --target x86_64-pc-windows-msvc` trên Mac | sạch | 27/11 |
| CI | `ci.yml` commit `f0b8a29b` | success (gồm capture-windows, agent-windows) | 27/11 |
| Update tests | `vitest run test/update-install.test.ts test/update.test.ts test/agent-updater.test.ts test/capture-service.test.ts` | xanh (update.test cần `sha256sum` — Mac thiếu, dùng shim) | 27/11 |
| Typecheck agent | `pnpm typecheck` | sạch | 27/11 |
| Release | agent-release run 46001797557 | success | 27/11 |
| Mac thật | `tunelo --version`, `pgrep tunelo-capture`, `codesign -dv` | 3.31.1, đang chạy, đúng identifier | 27/11 |
| Prod | install.sh trên prod | `TUNELO_VERSION="3.31.1"` | 27/11 |

Not run:
- Overlay thật trên Windows (chưa có máy Windows trong phiên) — việc của PC.
- Nghiệm thu UI chụp native từ composer Chat trên Mac — chờ đại ca.

Known: `test/update.test.ts` (đóng gói) hỏng trên Mac vì thiếu `sha256sum`, có từ trước, không liên quan.

## Open risks and blockers

- Type: risk. Owner: unknown. Impact: overlay trên Windows chưa từng chạy thật — đa màn hình, DPI scaling, IME tiếng Việt, phím tắt toàn cục, clipboard có thể lỗi.
- Type: risk. Owner: agent. Impact: chữ overlay theo locale của tiến trình; dịch vụ nền macOS nhận `en-US`. Đề xuất: lấy ngôn ngữ Chat đang dùng (gửi kèm `CaptureRequest` hoặc lưu trong `capture.json`). Chưa được đại ca duyệt.
- Type: question. Owner: đại ca. Impact: kết quả nghiệm thu trên Mac (bấm "Chụp màn hình" trong Chat, kéo vùng, chú thích, "Thêm vào khay"; thử ⌃⌥A; cấp quyền Ghi màn hình lần đầu).
- Type: question. Owner: đại ca. Impact: có xoá 2 tin nhắn thử trong "Cloud của tôi" ("Test chụp + quay màn hình", "Test quay vùng" video đen) không.
- Type: risk. Owner: unknown. Impact: `installMissingCapture` cần mạng tới GitHub Releases lúc agent khởi động; lỗi chỉ ghi log, overlay vắng thì composer dùng bản web.

## Exact next actions

1. **First safe step**: trên PC, `git pull` repo `chat-next` rồi đọc file này, `docs/adr/0031-screen-capture.md`, `docs/capture-wire.md`, `plans/dattqh/261126-2215-screen-capture-record/plan.md`; đối chiếu Current state với `git log -5`.
2. Cập nhật tunelo trên PC lên 3.31.1 (`tunelo update`); kiểm có `tunelo-capture.exe` cạnh `tunelo.exe` và tiến trình đang chạy. Nếu thiếu, xem log agent dòng `capture:`.
3. Kiểm tay trên Windows: Ctrl+Alt+A từ bất kỳ đâu, kéo vùng trên từng màn hình, 5 công cụ chú thích, gõ chữ tiếng Việt (Telex), Sao chép/Lưu; rồi từ Chat web trên PC: Đính kèm → "Chụp màn hình" → "Thêm vào khay".
4. Lỗi thì sửa trong `apps/capture` (chạy fmt/clippy/test), push, chờ CI, tăng version, phát hành theo quy trình ở "Scope and guardrails", ghim script, deploy.
5. Báo đại ca kết quả Windows bằng tiếng Việt; hỏi lại các câu hỏi mở (nghiệm thu Mac, ngôn ngữ overlay, xoá tin nhắn thử).

## Source pointers

- `apps/capture/` — engine Rust (`src/main.rs`, `src/overlay.rs`, `src/platform.rs`, `src/wire.rs`).
- `apps/agent/src/capture/capture-service.ts`, `apps/agent/src/capture/capture-settings.ts`, `apps/agent/src/commands/capture-hotkey.ts`.
- `apps/agent/src/update.ts` (`installMissingCapture`, `repairRelease`), `apps/agent/src/machine.ts`.
- `apps/agent/src/link/connection.ts` (`captureRequest`).
- `apps/web/src/machines/native-capture.ts`, `apps/web/src/messaging/ui/composer.tsx`, `apps/web/src/messaging/ui/attach-menu.tsx`.
- `proto/remote/v1/remote.proto` (Frame 203/204, MachineInfo 28).
- `.github/workflows/agent-release.yml`, `.github/workflows/ci.yml`, `apps/agent/scripts/package-release.sh`, `apps/agent/scripts/pin-release.ts`.
- `docs/adr/0031-screen-capture.md`, `docs/capture-wire.md`, `apps/agent/README.md` (mục "Chụp màn hình").
- `plans/dattqh/261126-2215-screen-capture-record/plan.md`.
- Release: https://github.com/achoo254/chat-next/releases/tag/tunelo-v3.31.1
