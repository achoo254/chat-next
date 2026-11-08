# ADR 0013: Máy của tôi — điều khiển AI lập trình trên máy riêng từ xa

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-08

## Bối cảnh

Người dùng muốn chat với Claude Code đang chạy trên máy của chính họ (máy B: Mac, Windows) từ một thiết bị khác (máy A: web, PWA, điện thoại): xem chữ chạy, thẻ tool, diff, bấm cho phép/từ chối, dừng, mở lại phiên. Chat không có app desktop (desktop = PWA), nên phía máy B cần một tiến trình nền nhỏ.

## Quyết định

### Kiến trúc

- Máy B chạy `hda` ("hoandat agent", `apps/agent`; tên cũ `chat-agent`, đổi ngày 08/11/2026 cho ngắn và gõ được khi bật Unikey): một file chạy duy nhất, giữ các phiên AI qua adapter. Adapter đầu tiên chạy `claude` CLI người dùng đã cài, qua Claude Agent SDK.
- Máy A nối tới máy B qua relay Tunelo (`wss://<subdomain>.tunnel.hoandat.com`). Tiến trình nền mở WebSocket server trên `127.0.0.1` và cho tunnel chuyển tới đó.
- Server Chat chỉ là danh bạ máy (tên, OS, khoá công khai, địa chỉ tunnel, lần thấy cuối), cấp mã cài và bắn Web Push không chứa nội dung. Server không phải gốc tin cậy cho khoá máy B và không thấy nội dung.
- Không dùng Bot API của Chat: bot đi qua server và lưu tin nhắn, trái với yêu cầu nội dung chỉ nằm ở hai đầu.

### Giao thức và mã hoá (`proto/remote/v1/remote.proto`, `packages/remote-protocol`)

- Trước bắt tay chỉ có `Plain` (khoá công khai, bằng chứng); sau bắt tay mỗi tin WebSocket là một `Frame` đã niêm phong.
- Bắt tay kiểu Noise KK: A gửi khoá tạm + khoá tĩnh + nonce; B kiểm khoá tĩnh của A nằm trong danh sách đã ghép; hai bên tính `ee`, `es`, `se` (X25519, WebCrypto), HKDF-SHA256 với salt = SHA-256(nonceA ‖ nonceB) và info = băm transcript, ra hai khoá một chiều + mã phiên 15 byte. `Ready` mang bản niêm phong của transcript (khung 0 chiều B → A) để A xác nhận khoá; khung đầu của A xác nhận khoá A.
- Khung: `secretbox` (tweetnacl), nonce = mã phiên ‖ chiều ‖ bộ đếm 64-bit. Bộ đếm phải tăng đúng 1: khung phát lại, mất hay đảo thứ tự làm hỏng phiên, máy A nối lại theo con trỏ journal.
- `Hello`/`Ready`/`HandshakeError` mang `protocolVersion` và `minProtocolVersion`; lệch thì báo bên nào cần cập nhật.
- Ghép thiết bị, không có bí mật nào đi qua server:
  - Lệnh cài một dòng: trình duyệt sinh bí mật 32 byte, đưa cho `chat-agent install` qua stdin (không nằm trong argv). Ở lần bắt tay đầu, B gửi HMAC(bí mật, "install" ‖ khoá A ‖ khoá B); A kiểm rồi mới ghim khoá B. A không bao giờ lấy khoá B từ server.
  - `chat-agent pair` mở cửa sổ ghép 10 phút, in QR (khoá B + bí mật 32 byte) và mã 6 số. QR: A chứng minh bí mật trong `Hello`. Mã 6 số: CPace trên ristretto255 (`@noble/curves`) trước bắt tay, kèm thẻ xác nhận gắn cả hai khoá tĩnh; relay nhìn thấy trao đổi cũng không dò mã offline được. Tối đa 5 lần thử mỗi cửa sổ, ghép xong thì đóng cửa sổ.
- Journal theo luồng chat: mỗi mục có `seq` tăng dần và `revision`; thiết bị nhận tiếp từ con trỏ `{epoch, seq}`. `epoch` tăng mỗi lần tiến trình nền khởi động lại; con trỏ khác epoch, vượt quá, hay rơi vào phần đã nén thì nhận `ThreadReset` và tải lại (`journal-rules.ts`).
- Không gắn với một AI: khung tin dùng loại tool chuẩn (`read, edit, shell, search, web, mcp, subagent, todo, other`) và cờ khả năng của adapter; web không đọc tên tool riêng.

### Ràng buộc khi chạy claude CLI

1. Chạy đúng file `claude` người dùng đã cài (`pathToClaudeCodeExecutable`), không dùng bản kèm trong gói SDK.
2. Không đọc, lưu, chuyển token hay credential Claude; người dùng tự đăng nhập bằng `claude`. Tiến trình nền không gọi API Anthropic.
3. Mỗi người dùng chạy bằng gói hoặc key Claude của chính họ.
4. Không dùng "Claude Code"/"Anthropic" làm tên tính năng hay logo.

### An toàn phiên

- `settingSources: ['user']` mặc định: `.claude/settings.json` và hook của dự án không có hiệu lực, trừ khi người dùng tick "Nạp cấu hình .claude của dự án" (ghi nhật ký).
- `strictMcpConfig` + chỉ MCP người dùng bật tại máy B. Chế độ quyền theo đúng cấu hình Claude của máy B (`permissions.defaultMode` và luật allow/deny trong settings của người dùng; settings dự án chỉ nạp khi người dùng tick), kể cả `bypassPermissions` nếu chủ máy đã đặt vậy. Máy A chỉ thấy chế độ hiện tại, không đổi được (Jev 08/11/2026, phương án A 0,54; thay quyết định cũ "luôn hỏi quyền").
- Thư mục nhạy cảm (`~`, `/`, `~/.ssh`, `~/.aws`, thư mục cấu hình của tiến trình nền…) không bị chặn mà phải xác nhận; đồng ý được ghi vào nhật ký trên máy B.
- Rủi ro còn lại: XSS trên `chat.hoandat.com` dùng được khoá thiết bị (non-extractable) trong lúc trang mở, dù không lấy được khoá ra. Giảm bằng CSP chặt và xoá khoá khi đăng xuất.

## Thử khả thi (08/11/2026)

`apps/agent/src/spike.ts`, Agent SDK 0.3.319, `claude` 2.1.319, model haiku, thư mục có `.claude/settings.json` cho phép `Bash(*)`, `Write(*)` và hook ghi file đánh dấu.

| Kiểm | Windows 11 x64 (Node 24) | Windows (Bun compile) | Mac mini arm64 (Bun compile) |
|---|---|---|---|
| Dùng đúng `claude` của máy, 0 MCP | đạt | đạt | đạt |
| Hook và quyền của dự án không áp dụng | đạt | đạt | đạt |
| `canUseTool` cho phép rồi từ chối | đạt (file bị từ chối không được tạo) | đạt | chưa thử được¹ |
| `interrupt` giữa lượt | đạt | đạt | chưa thử được¹ |
| `getContextUsage` | đạt | đạt | đạt |
| Khởi động tới `init` | 2,7 s | 3,2 s | 0,48 s |
| Token stream đầu tiên | 4,4 s | 4,7 s | — |
| RAM tiến trình nền (không tính `claude`) | 68 MB | 57 MB | 28 MB |
| Kích thước file | — | 117 MB | 91 MB (darwin-x64: 100 MB) |

¹ Chạy qua SSH nên `claude` trên Mac không mở được Keychain ("OAuth session expired"); thử lại khi tiến trình nền chạy như LaunchAgent trong phiên đăng nhập.

Ghi nhận cho tiến trình nền:

- `Bash` lệnh chỉ đọc (như `echo`) được `claude` tự cho phép, không đi qua `canUseTool`.
- Sau `interrupt`, lượt kết thúc với `error_during_execution` và luồng SDK ném lỗi khi đóng; adapter phải bắt và ghi lượt là `interrupted`.
- Lỗi đăng nhập trả về như một câu trả lời bình thường ("Failed to authenticate") với chi phí 0; adapter phải nhận ra để báo "cần đăng nhập".
- Gọi `interrupt()` sau khi phiên đã đóng ném lỗi chưa bắt; mọi lệnh điều khiển phải kiểm phiên còn mở.
- Bun compile chạy được Agent SDK, không cần Node SEA hay tarball.

## Hệ quả

- Thêm `packages/remote-protocol` (chạy trên trình duyệt và Node), `apps/agent`, `proto/remote/v1` (sinh TS vào `@achoo254/chat-proto/remote/*`).
- Mỗi adapter AI mới phải qua bộ test hợp đồng `provider-contract` trước khi gộp.
