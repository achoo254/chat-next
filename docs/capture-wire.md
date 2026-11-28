# Giao thức `tunelo` ↔ `tunelo-capture`

`tunelo` khởi chạy `tunelo-capture` làm tiến trình con và nói chuyện qua stdin/stdout của nó: **một đối tượng JSON mỗi dòng**, lệnh đi vào stdin,
sự kiện đi ra stdout. Chỉ tiến trình cha giữ hai đầu ống. Không có ảnh nào đi trên ống: ảnh là tệp PNG trong thư mục `--out`.
Quyết định: [ADR 0031](./adr/0031-screen-capture.md). Mã: `apps/capture/src/wire.rs`.

## Khởi chạy

```
tunelo-capture --out <thư mục ảnh> [--lang vi|en|zh-CN] [--hotkey "Ctrl+Alt+A"]
```

- `--out`: nơi ghi ảnh (`capture-<ms>.png`); `tunelo` đọc rồi chuyển vào lịch sử mã hoá của nó.
- `--lang`: ngôn ngữ chữ trên lớp phủ (mặc định tiếng Việt).
- `--hotkey`: phím tắt toàn cục mở chụp; chuỗi rỗng là tắt.
- Đóng stdin (tunelo thoát) thì tiến trình thoát.

## Lệnh (stdin)

| Lệnh | Trường | Ý nghĩa |
|---|---|---|
| `capture_interactive` | `id`, `origin`: `hotkey` \| `chat` \| `ai` | Lớp phủ trên mọi màn hình; người dùng kéo vùng, chú thích, bấm một nút. `origin` quyết định chữ của nút chính: Gửi, Thêm vào khay, Gửi cho AI. |
| `capture_screen` | `id`, `display`: số hoặc `null` (màn hình chính) | Chụp nguyên một màn hình, không giao diện. `tunelo` phải hỏi người dùng trước (chính sách MCP). |
| `list_displays` | `id` | Danh sách màn hình. |
| `set_hotkey` | `capture` | Đổi phím tắt (`"Ctrl+Alt+A"`; rỗng là tắt). |
| `quit` | | Thoát. |

## Sự kiện (stdout)

| Sự kiện | Trường | Khi nào |
|---|---|---|
| `ready` | `version` (của tunelo-capture), `wire` (số phiên bản giao thức, hiện là 1), `hotkey` (đã đăng ký, rỗng nếu không) | Ngay khi khởi chạy. |
| `opened` | `id` (rỗng nếu do phím tắt) | Lớp phủ đã hiện trên các màn hình (sau `capture_interactive` hoặc phím tắt). |
| `captured` | `id` (rỗng nếu do phím tắt), `origin`, `action`: `main` \| `ask_ai` \| `copy` \| `save`, `file`, `width`, `height` | Có ảnh. Ảnh luôn đã nằm trong clipboard; `save` thì `file` nằm trong thư mục Pictures. |
| `cancelled` | `id` | Người dùng đóng lớp phủ (Esc, chuột phải, nút ×). |
| `displays` | `id`, `displays`: `[{index, name, width, height, primary}]` | Trả lời `list_displays`. |
| `error` | `id`, `code`, `message` | `code`: `hotkey_taken`, `no_display`, `busy` (đang có lớp phủ), `capture_failed`, `bad_command`. Dòng lệnh sai không được lặp lại trong `message`. |

## Lớp phủ

- Kéo theo hướng bất kỳ để chọn vùng (nhỏ hơn 6 px là bấm, không phải vùng); kéo ra ngoài vùng là chọn lại, khi chưa vẽ gì.
- Con trỏ là dấu chữ thập khi chưa có vùng và trong lúc đang kéo (chọn vùng hoặc vẽ); thả chuột ra là về mũi tên thường.
- Thanh công cụ dưới vùng (biến thể A; lên trên khi không đủ chỗ): Khung, Mũi tên, Bút, Chữ, Làm mờ · 4 màu · Hoàn tác · Sao chép, Lưu, Hỏi AI
  (trừ khi AI tự chụp), nút chính, ×.
- Phím: Esc bỏ vùng rồi mới đóng; Enter là nút chính (đang gõ chữ thì Enter kết thúc chữ); Ctrl/⌘+Z hoàn tác; Ctrl/⌘+C sao chép.
