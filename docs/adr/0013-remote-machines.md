# ADR 0013: Máy của tôi — điều khiển AI lập trình trên máy riêng từ xa

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-08
- Bổ sung bởi [ADR 0014](./0014-tunelo-machine-agent.md): Tunelo là tiến trình máy duy nhất, máy đăng ký theo tài khoản (không còn mã cài), profile Claude, Localman gọi `localhost` của máy.

## Bối cảnh

Người dùng muốn chat với Claude Code đang chạy trên máy của chính họ (máy B: Mac, Windows) từ một thiết bị khác (máy A: web, PWA, điện thoại): xem chữ chạy, thẻ tool, diff, bấm cho phép/từ chối, dừng, mở lại phiên. Chat không có app desktop (desktop = PWA), nên phía máy B cần một tiến trình nền nhỏ.

## Quyết định

### Kiến trúc

- Máy B chạy `tunelo` (`apps/agent`; tên cũ `chat-agent`, rồi `hda` ngày 08/11/2026, rồi `tunelo` 2.0.0 cùng ngày, xem "Đổi tên thành tunelo"): một file chạy duy nhất, giữ các phiên AI qua adapter. Adapter đầu tiên chạy `claude` CLI người dùng đã cài, qua Claude Agent SDK.
- Máy A nối tới máy B qua relay Tunelo (`wss://<subdomain>.tunnel.hoandat.com`). Tiến trình nền mở WebSocket server trên `127.0.0.1` và cho tunnel chuyển tới đó.
- Server Chat chỉ là danh bạ máy (tên, OS, khoá công khai, địa chỉ tunnel, lần thấy cuối) và bắn Web Push không chứa nội dung. Máy đăng ký theo tài khoản của chủ (ADR 0014); mã cài trước đây chỉ còn cho máy cũ tới bước dọn. Server không phải gốc tin cậy cho khoá máy B và không thấy nội dung.
- Không dùng Bot API của Chat: bot đi qua server và lưu tin nhắn, trái với yêu cầu nội dung chỉ nằm ở hai đầu.

### Giao thức và mã hoá (`proto/remote/v1/remote.proto`, `packages/remote-protocol`)

- Trước bắt tay chỉ có `Plain` (khoá công khai, bằng chứng); sau bắt tay mỗi tin WebSocket là một `Frame` đã niêm phong.
- Bắt tay kiểu Noise KK: A gửi khoá tạm + khoá tĩnh + nonce; B kiểm khoá tĩnh của A nằm trong danh sách đã ghép; hai bên tính `ee`, `es`, `se` (X25519, WebCrypto), HKDF-SHA256 với salt = SHA-256(nonceA ‖ nonceB) và info = băm transcript, ra hai khoá một chiều + mã phiên 15 byte. `Ready` mang bản niêm phong của transcript (khung 0 chiều B → A) để A xác nhận khoá; khung đầu của A xác nhận khoá A.
- Khung: `secretbox` (tweetnacl), nonce = mã phiên ‖ chiều ‖ bộ đếm 64-bit. Bộ đếm phải tăng đúng 1: khung phát lại, mất hay đảo thứ tự làm hỏng phiên, máy A nối lại theo con trỏ journal.
- `Hello`/`Ready`/`HandshakeError` mang `protocolVersion` và `minProtocolVersion`; lệch thì báo bên nào cần cập nhật.
- Ghép thiết bị, không có bí mật nào đi qua server:
  - Lệnh cài một dòng: trình duyệt sinh bí mật 32 byte, người dùng dán vào script cài, script đưa cho `tunelo install` qua stdin (không nằm trong argv). Ở lần bắt tay đầu, B gửi HMAC(bí mật, "install" ‖ khoá A ‖ khoá B); A kiểm rồi mới ghim khoá B. A không bao giờ lấy khoá B từ server.
  - `tunelo pair` mở cửa sổ ghép 10 phút, in QR (khoá B + bí mật 32 byte) và mã 6 số. QR: A chứng minh bí mật trong `Hello`. Mã 6 số: CPace trên ristretto255 (`@noble/curves`) trước bắt tay, kèm thẻ xác nhận gắn cả hai khoá tĩnh; relay nhìn thấy trao đổi cũng không dò mã offline được. Tối đa 5 lần thử mỗi cửa sổ, ghép xong thì đóng cửa sổ.
- Journal theo luồng chat: mỗi mục có `seq` tăng dần và `revision`; thiết bị nhận tiếp từ con trỏ `{epoch, seq}`. `epoch` tăng mỗi lần tiến trình nền khởi động lại; con trỏ khác epoch, vượt quá, hay rơi vào phần đã nén thì nhận `ThreadReset` và tải lại (`journal-rules.ts`).
- Không gắn với một AI: khung tin dùng loại tool chuẩn (`read, edit, shell, search, web, mcp, subagent, todo, other`) và cờ khả năng của adapter; web không đọc tên tool riêng.

### Ràng buộc khi chạy claude CLI

1. Chạy đúng file `claude` người dùng đã cài (`pathToClaudeCodeExecutable`), không dùng bản kèm trong gói SDK.
2. Không đọc, lưu, chuyển token hay credential Claude; người dùng tự đăng nhập bằng `claude`. Tiến trình nền không gọi API Anthropic.
3. Mỗi người dùng chạy bằng gói hoặc key Claude của chính họ.
4. Không dùng "Claude Code"/"Anthropic" làm tên tính năng hay logo.

### An toàn phiên

- `settingSources: ['user']` mặc định: `.claude/settings.json` và hook của dự án không có hiệu lực, trừ khi người dùng tick "Nạp cấu hình .claude của dự án" (ghi nhật ký).
- `strictMcpConfig` + chỉ MCP người dùng bật tại máy B. Chế độ quyền theo đúng cấu hình Claude của máy B (`permissions.defaultMode` và luật allow/deny trong settings của người dùng; settings dự án chỉ nạp khi người dùng tick), kể cả `bypassPermissions` nếu chủ máy đã đặt vậy. Máy A thấy chế độ hiện tại và đổi được trong khung chat (`ThreadSetPermissionMode`, đại ca chốt 08/11/2026 chiều, thay "chỉ hiển thị"): chỉ trong các chế độ máy B liệt kê ở `ThreadInfo.permission_modes` (default, acceptEdits, plan, auto); `bypassPermissions` chỉ có trong danh sách khi chính cấu hình máy B khởi động phiên ở chế độ đó, nên máy A không bao giờ tự bật được. Mỗi lần đổi ghi vào nhật ký đồng ý trên máy B (`permission_mode`). Effort đổi bằng `ThreadSetEffort`; lựa chọn của thiết bị lưu theo phiên, mở lại phiên vẫn giữ. Thanh trạng thái hiện tài khoản Claude đang đăng nhập (email, tổ chức, gói) lấy từ `accountInfo()` của CLI, không có token.
- Thư mục nhạy cảm (`~`, `/`, `~/.ssh`, `~/.aws`, thư mục cấu hình của tiến trình nền…) không bị chặn mà phải xác nhận; đồng ý được ghi vào nhật ký trên máy B.
- Rủi ro còn lại: XSS trên `chat.hoandat.com` dùng được khoá thiết bị (non-extractable) trong lúc trang mở, dù không lấy được khoá ra. Giảm bằng CSP chặt và xoá khoá khi đăng xuất.

## Đổi tên thành tunelo (08/11/2026)

- Lệnh, file chạy, dịch vụ nền, thư mục cấu hình đổi sang `tunelo` 2.0.0: `%APPDATA%\tunelo`, `~/.config/tunelo` (biến `TUNELO_HOME`, vẫn đọc `CHAT_AGENT_HOME` khi biến mới trống); LaunchAgent `com.hoandat.tunelo`, giá trị Run `tunelo`; Keychain `com.hoandat.tunelo`, đọc `com.hoandat.chat-agent` khi mục mới chưa có. Danh tính máy không đổi: `deviceId = chat-agent.<machineId>` (nên subdomain giữ nguyên), `machineId`, `machineSecret`, khoá X25519.
- Phát hành: tag `tunelo-v<semver>`, file `tunelo-*`, chú thích ký `tunelo <version> <file>`. Bản cầu nối duy nhất `agent-v0.3.0` chứa `tunelo` 2.0.0 dưới tên `hda-*`, ký `hda 0.3.0 <file>`, vì `hda` 0.2.x chỉ cập nhật từ đó; CI cho phép riêng tag này build từ `AGENT_VERSION` 2.0.0. Không bao giờ xoá release đó.
- Chuyển cài đặt (`apps/agent/src/migrate-from-hda.ts`), chạy lại được sau mọi lần dừng giữa chừng, thứ tự giữ đúng một vòng nền: (1) chép thư mục cũ (trừ file của tiến trình đang chạy) và khoá Keychain, đọc lại được mới đi tiếp; (2) chép file chạy sang `%LOCALAPPDATA%\tunelo\tunelo.exe` / `~/.local/bin/tunelo`, thêm PATH, cài và chờ dịch vụ mới trả lời; (3) ghi `stop` và `migrated-to-tunelo` vào thư mục cũ; (4) xoá mục khởi động cũ; (5) cuối cùng `launchctl bootout` nhãn cũ. Thư mục và khoá cũ giữ lại để quay về.
- Chạy bằng tên `hda`: `hda run` (do dịch vụ cũ gọi) chuyển cài đặt; đã có marker thì không bao giờ mở agent, chỉ bảo đảm `tunelo` đang chạy rồi thoát; chuyển lỗi trước bước 3 thì agent chạy tiếp từ thư mục cũ như `hda`. Lệnh khác chuyển sang `tunelo`. `tunelo run` từ chối khi có agent trả lời ở thư mục cũ hoặc mới. `tunelo start` trên Windows xoá `hda.exe` khi không còn ai giữ.
- Lối thoát: `hda` 0.2.x chỉ đọc 20 release mới nhất. Khi `agent-v0.3.0` trôi khỏi đó, người dùng chạy lại `install.sh`/`install.ps1` (không cần mã cài, trang thêm máy có lệnh); script thấy `hda` thì chạy `tunelo migrate-from-hda`, thấy gói npm `tunelo` 1.x thì nhắc `npm uninstall -g tunelo` (không tự gỡ).
- Từ CLI Tunelo 1.x (`~/.tunelo/config.json`) chỉ nhập địa chỉ tunnel server; không đọc khoá, phiên, không sửa `~/.tunelo`.
- Rủi ro macOS: LaunchAgent (cũ lẫn mới) và Keychain cần phiên đăng nhập GUI (`gui/<uid>`). Mac headless tắt tự đăng nhập không chạy được tiến trình nền nào; chạy chuyển đổi qua SSH thì `launchctl bootstrap` hỏng ở bước 2 và cài đặt cũ không bị đổi. Nghiệm thu chuyển đổi trên Mac làm khi có phiên GUI.

## MCP của tunelo trong phiên claude (09/11/2026)

- Phiên claude do tunelo mở có MCP `tunelo` (stdio, chính file chạy `tunelo mcp`). Có ba nhóm tool, khai báo trong danh sách tĩnh `apps/agent/src/mcp/groups.ts`:
  - `tunnel`: 11 tool của CLI Tunelo 1.x, chạy trong dịch vụ.
  - `chat`: `chat_list_chats`, `chat_get_messages`, `chat_search_messages`, …; tool ghi `chat_send_message`.
  - `localman`: `localman_list_collections`, `localman_list_history`, `localman_list_machines`, …; tool ghi `localman_send_request`.
  - Localman không có tool chạy cả collection.
- `tunelo mcp` và claude không cầm token:
  - Mọi lời gọi đi qua kênh điều khiển (`POST /mcp/call`). Dịch vụ kiểm tool có trong danh sách của nhóm, gắn Bearer của đúng app (`https://chat.<miền>/mcp`, `https://localman.<miền>/mcp`; đây cũng là `aud` của token), rồi gọi MCP của app (`mcp/remote-proxy.ts`).
  - Danh sách tool được nhớ 10 phút theo tài khoản; lỗi liệt kê được nhớ 30 giây. Gặp 401 thì làm mới đúng token bị từ chối, một lần. Thiếu scope thì báo chạy lại `tunelo login`.
  - Mọi chuỗi rời phía MCP đều qua một hàm che (`mcp/redact.ts`): kết quả, lỗi, danh sách tool, stderr của `tunelo mcp`, lỗi của kênh điều khiển, log. Hàm này bỏ token đã gửi, mọi chuỗi dạng JWT và `Bearer …`, kể cả khi server hay proxy đứng trước nó chép lại header.
  - Mỗi lời gọi ghi một dòng vào `agent.log`: phiên, nhóm, tool, kết quả. Không ghi tham số.
- Vé `TUNELO_MCP_TICKET` (256 bit, mỗi phiên một vé, hết khi phiên đóng) **chỉ là định danh phiên, không phải bí mật**:
  - claude nhận vé qua argv (`--mcp-config`), nên mọi tiến trình cùng user đọc được vé, kể cả Bash trong chính phiên.
  - Vé đã hết bị từ chối.
- **Quyền ghi nằm ở lần cấp duyệt, giữ trong dịch vụ** (`mcp/write-approvals.ts`):
  - Tool ghi gồm `chat_send_message`, `localman_send_request`, mở/đóng tunnel, dừng tiến trình tunnel, và lượt có `confirm_token` của `revoke_linked_machine`.
  - Khi người dùng duyệt thẻ của tool ghi trên thiết bị, `canUseTool` (chạy trong dịch vụ) cấp một lần cho phép gắn với vé, tool và hash tham số. Lần cấp dùng được một lần, sống 60 giây.
  - Dịch vụ chỉ chạy tool ghi của một phiên có vé khi tiêu được đúng lần cấp đó. Ngoại lệ duy nhất là phiên đang ở `bypassPermissions`, chế độ chỉ có khi cấu hình claude của chính máy khởi động ở đó.
  - Vì vậy Bash trong phiên lấy được vé (qua `ps`, hoặc đọc `control.json` rồi gọi socket) vẫn không gửi được tin hay request.
- Hook `PreToolUse` trả `ask` cho tool ghi ở default, acceptEdits, plan, auto, kể cả khi có luật allow `mcp__tunelo__*`; ở `bypassPermissions` thì không can thiệp:
  - Đã thử với claude 2.1.319: hook `allow` trong settings không thắng `ask` của tunelo, `canUseTool` vẫn được gọi. Lỡ có cách gộp khác, tool ghi vẫn không chạy khi chưa có lần cấp.
  - Thẻ duyệt hiện người nhận theo tên cuộc trò chuyện (lấy bằng `get_chat`, lỗi thì hiện `chat <id>`) kèm 300 ký tự đầu của tin; với request thì hiện `METHOD URL`. Input dài hơn 4000 ký tự thì thẻ ghi rõ đã bị cắt.
  - "Cho phép cả phiên" không thêm luật cho tool ghi.
  - Server MCP nào trong cấu hình máy chạy `tunelo mcp` dưới tên khác đều bị bỏ khỏi phiên có MCP `tunelo`.
- **Lời gọi không vé chỉ được đọc** (người dùng chốt 09/11/2026). Lời gọi không vé là `claude mcp add tunelo -- tunelo mcp` ở phiên ngoài tunelo, hay bất kỳ tiến trình cùng user nào đọc `control.json`.
  - Mọi tool ghi (gửi tin, gửi request, mở/đóng tunnel, dừng tiến trình tunnel, thu hồi liên kết) đều bị từ chối, kèm hướng dẫn cách bật.
  - `tools/list` của client đó không có tool ghi.
  - Chủ máy bật bằng `tunelo config mcp-local-writes on|off` (bật chỉ trong terminal, có hỏi xác nhận), mặc định off:
    - Cờ lưu ở file `mcp-local-writes.json`. Ghi dưới khoá file, ghi nguyên tử, dịch vụ đang chạy đọc lại khi file đổi. File hỏng thì coi là tắt.
    - Mỗi lần đổi được ghi vào nhật ký đồng ý (`mcp_local_writes`).
    - Khi bật, lời gọi không vé dùng đủ tool, và chỉ còn việc duyệt của chính client đó chặn tool ghi.
  - Lời gọi có vé không phụ thuộc cờ này: vẫn cần lần cấp duyệt.
- Rủi ro prompt injection:
  - Nội dung claude đọc từ Chat (tin của người khác), Localman (response) hay file dự án có thể dụ claude gửi tin thay người dùng hoặc gửi request tới `localhost` của máy.
  - Ở default/acceptEdits/auto, lần cấp duyệt chặn lời gọi tool. Bash trong phiên hay tiến trình lạ cũng không ghi được qua tunelo: có vé thì vẫn thiếu lần cấp, không vé thì chỉ được đọc. Người dùng vẫn phải đọc thẻ: người nhận, nội dung, URL.
  - Còn hở:
    - Chủ máy tự bật `mcp-local-writes`: khi đó mọi tiến trình cùng user ghi được qua socket. `tunelo config mcp-local-writes on` chỉ chạy khi stdin và stdout là terminal và người dùng gõ `yes`; Bash của claude hay script không có terminal nên bị từ chối (`off` luôn chạy được). Lệnh này (cũng như thư mục cấu hình tunelo) còn được tính là nhạy cảm: thẻ của nó có nhãn cảnh báo và không bao giờ được "cho phép cả phiên". Đây là bước chặn model tự bật, không phải tường chắn: mã cùng user vẫn tự ghi được file cờ hoặc giả terminal (`script`).
    - Bash tự gửi request mạng bằng thông tin đăng nhập riêng của nó (ngoài tunelo).
    - `bypassPermissions`: không có gì chặn. Người dùng chấp nhận rủi ro này khi tự đặt máy ở chế độ đó.
- Dữ liệu nhạy cảm đi vào context:
  - `localman_list_history`, `localman_get_history_entry`, `localman_send_request` có thể trả header của những request người dùng từng gửi.
  - Dịch vụ che giá trị của các header nhạy cảm trước khi trả về: `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key`, …
  - Thân request/response và header tên lạ vẫn có thể chứa khoá API, và sẽ vào context claude (rồi lên Anthropic). Localman MCP nên tự che ở phía server.
- Tắt: trong `config.json` của tunelo, `sessionMcp: false` thì phiên mới không có MCP `tunelo`; `mcpGroups` giới hạn các nhóm được phục vụ trên máy.

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
