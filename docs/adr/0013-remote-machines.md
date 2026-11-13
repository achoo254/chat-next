# ADR 0013: Máy của tôi — điều khiển AI lập trình trên máy riêng từ xa

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-08
- Bổ sung bởi [ADR 0014](./0014-tunelo-machine-agent.md): Tunelo là tiến trình máy duy nhất, máy đăng ký theo tài khoản (không còn mã cài), profile Claude, Localman gọi `localhost` của máy.
- Bổ sung bởi [ADR 0017](./0017-provider-neutral-ai-agent.md): không AI mặc định, tài khoản theo từng AI, Antigravity.
- Sửa ngày 2026-11-12 (tunelo 3.0): tài khoản là gốc tin cậy cả hai chiều, thay ghép thiết bị bằng lệnh cài và mã Authenticator (mục "Tài khoản là gốc tin cậy").

## Bối cảnh

Người dùng muốn chat với Claude Code đang chạy trên máy của chính họ (máy B: Mac, Windows, Linux) từ một thiết bị khác (máy A: web, PWA, điện thoại): xem chữ chạy, thẻ tool, diff, bấm cho phép/từ chối, dừng, mở lại phiên. Chat không có app desktop (desktop = PWA), nên phía máy B cần một tiến trình nền nhỏ.

## Quyết định

### Kiến trúc

- Máy B chạy `tunelo` (`apps/agent`, xem "Cài đặt và phát hành tunelo"): một file chạy duy nhất, giữ các phiên AI qua adapter. Adapter đầu tiên chạy `claude` CLI người dùng đã cài, qua Claude Agent SDK.
- Máy A nối tới máy B qua relay Tunelo (`wss://<subdomain>.tunnel.hoandat.com`). Tiến trình nền mở WebSocket server trên `127.0.0.1` và cho tunnel chuyển tới đó.
- Server Chat giữ danh bạ máy (tên, OS, khoá công khai, địa chỉ tunnel, lần thấy cuối) và danh bạ khoá thiết bị của tài khoản, và bắn Web Push không chứa nội dung. Máy đăng ký theo tài khoản của chủ (ADR 0014). Server là gốc tin cậy cho khoá ở cả hai chiều (mục "Tài khoản là gốc tin cậy") nhưng không thấy nội dung.
- Không dùng Bot API của Chat: bot đi qua server và lưu tin nhắn, trái với yêu cầu nội dung chỉ nằm ở hai đầu.

### Giao thức và mã hoá (`proto/remote/v1/remote.proto`, `packages/remote-protocol`)

- Trước bắt tay chỉ có `Plain` (khoá công khai, bằng chứng); sau bắt tay mỗi tin WebSocket là một `Frame` đã niêm phong.
- Bắt tay kiểu Noise KK: A gửi khoá tạm + khoá tĩnh + nonce; B kiểm khoá tĩnh của A nằm trong danh sách thiết bị tin cậy; A kiểm khoá tĩnh của B đúng khoá máy mong đợi; hai bên tính `ee`, `es`, `se` (X25519, WebCrypto), HKDF-SHA256 với salt = SHA-256(nonceA ‖ nonceB) và info = băm transcript, ra hai khoá một chiều + mã phiên 15 byte. `Ready` mang bản niêm phong của transcript (khung 0 chiều B → A) để A xác nhận khoá; khung đầu của A xác nhận khoá A.
- Khung: `secretbox` (tweetnacl), nonce = mã phiên ‖ chiều ‖ bộ đếm 64-bit. Bộ đếm phải tăng đúng 1: khung phát lại, mất hay đảo thứ tự làm hỏng phiên, máy A nối lại theo con trỏ journal.
- `Hello`/`Ready`/`HandshakeError` mang `protocolVersion` và `minProtocolVersion`; lệch thì báo bên nào cần cập nhật. Giao thức hiện là 3 (`PROTOCOL_VERSION` = `MIN_PROTOCOL_VERSION` = 3, [`handshake.ts`](../../packages/remote-protocol/src/crypto/handshake.ts)); server chỉ nhận `tunelo` 3.0.0 trở lên (`MinAgentVersion` ở [`machineapi.go`](../../server/internal/machineapi/machineapi.go)), bản cũ được báo chạy lại lệnh cài trên trang Máy.
- Ghép thiết bị bằng lệnh cài (`tunelo install --trust`, bí mật một lần qua stdin) và bằng mã Authenticator (TOTP làm mật khẩu CPace, bí mật chỉ trên máy, khoá ghép sau 5 lần sai), cùng `tunelo authenticator`: **đã thay thế bởi tunelo 3.0** (mục "Tài khoản là gốc tin cậy"). Quyết định cũ giữ máy làm gốc tin cậy, server không bảo lãnh thiết bị nào; cái giá là mỗi thiết bị mới phải ghép, cài phải dán bí mật, máy cài qua SSH không có thiết bị nào. Chi tiết cũ ở lịch sử git của tệp này.
- Journal theo luồng chat: mỗi mục có `seq` tăng dần và `revision`; thiết bị nhận tiếp từ con trỏ `{epoch, seq}`. `epoch` tăng mỗi lần tiến trình nền khởi động lại; con trỏ khác epoch, vượt quá, hay rơi vào phần đã nén thì nhận `ThreadReset` và tải lại (`journal-rules.ts`).
- Không gắn với một AI: khung tin dùng loại tool chuẩn (`read, edit, shell, search, web, mcp, subagent, todo, other`) và cờ khả năng của adapter; web không đọc tên tool riêng.

### Tài khoản là gốc tin cậy (tunelo 3.0, chốt 12/11/2026)

Mục tiêu: thêm máy bằng một lệnh cố định (không mã, không khoá), và mọi trình duyệt hay app điện thoại đã đăng nhập cùng tài khoản điều khiển được máy ngay, không ghép.

- **Thiết bị → máy.** Chat lưu khoá công khai X25519 của thiết bị theo tài khoản (`account_devices`, [`0037_account_devices.sql`](../../server/migrations/0037_account_devices.sql)). Trình duyệt và app Capacitor/PWA tự tạo và đăng ký khoá khi vào khu Máy (`RegisterDevice`, [`device-registration.ts`](../../apps/web/src/machines/link/device-registration.ts)). Mỗi heartbeat trả cho máy các khoá sống của chủ (`trusted_devices`); máy chỉ nhận bắt tay của khoá trong danh sách, khoá rời danh sách thì máy cắt kênh của nó ([`device-trust.ts`](../../apps/agent/src/device-trust.ts)).
- **Máy → thiết bị.** Thiết bị lấy khoá máy mong đợi từ `ListMachines[].public_key` mỗi lần kết nối, không còn ghim lúc ghép. Khoá khác khoá đã thấy lần trước (lưu trên thiết bị) thì không mở kênh, báo khoá máy đã đổi và ghi log; người dùng bấm làm mới trạng thái máy mới là đồng ý nhận khoá mới.
- Kênh vẫn mã hoá đầu cuối, server không thấy nội dung. `Ready.confirm` giữ nguyên: mọi lần bắt tay vẫn xác nhận khoá hai chiều.
- Khoá thiết bị mới: push tới mọi đăng ký push của tài khoản và hiện trong "Thiết bị của tài khoản" ở trang Quản lý máy (thời điểm thêm, lần dùng cuối, thu hồi). Không có bước duyệt.

**Đánh đổi.** Người vận hành server (hoặc ai chiếm được server) về lý thuyết cài được khoá giả ở một trong hai chiều; lộ phiên tài khoản là vào được máy cho tới khi chủ thấy push và thu hồi. Chấp nhận để bỏ ghép, TOTP và bí mật trong lệnh cài. Các biện pháp bù:

1. **Gắn phiên.** Mỗi khoá thiết bị gắn phiên chat đã đăng ký nó. Thu hồi khoá thu hồi luôn phiên đó; phiên kết thúc vì bất cứ lý do gì (đăng xuất, bị thu hồi, IdP kết thúc grant, xoá tài khoản) thì trigger trong DB thu hồi khoá của nó, phiên chỉ hết hạn thì bị bắt ở lần đọc kế tiếp. Khoá đã thu hồi không bao giờ đăng ký lại được, và phiên từng bị thu hồi khoá không đăng ký khoá mới: thiết bị phải đăng nhập lại và tạo khoá mới, kéo theo push "thiết bị mới".
2. **Chứng minh sở hữu khoá.** `RegisterDevice` và `RegisterMachine` cần trả lời một thử thách Diffie-Hellman do server cấp (`GetDeviceKeyChallenge`, `GetMachineKeyChallenge`; server không giữ trạng thái, [`keyproof`](../../server/internal/keyproof/keyproof.go)), nên không ai đăng ký được khoá công khai của người khác.
3. **Thu hồi máy dứt điểm.** Xoá máy trên web (hoặc `tunelo logout`) thu hồi luôn grant `tunelo-agent` của máy ở auth-next ([`agentgrant`](../../server/internal/agentgrant/agentgrant.go), biến `TUNELO_GRANT_REVOKE_URL` ở [`server/README.md`](../../server/README.md); quyết định phía IdP ở [ADR 0016 của `auth-next`](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0016-tunelo-agent-grant-revocation-and-prefilled-link.md)). Muốn quay lại máy phải `tunelo login` mới và chủ bấm Đồng ý. Mục máy đã xoá không hồi sinh; cài lại khi còn khoá máy giữ mục máy cũ.
4. **Link điền sẵn mã chỉ khi trùng IP.** `tunelo login` mở trang đồng ý của auth-next với mã điền sẵn; trang chỉ nhận mã đó khi IP trình duyệt trùng IP máy xin mã, khác IP thì người dùng gõ mã đang hiện trong terminal. Cùng NAT (cùng mạng nhà, công ty) vẫn lọt; chấp nhận.
5. **Chat sập tối đa 24 giờ.** Máy lưu danh sách thiết bị tin cậy ra đĩa kèm thời điểm đồng bộ; quá 24 giờ không đồng bộ được thì từ chối mọi bắt tay mới (kênh đang mở giữ). Hệ quả: thiết bị bị thu hồi trong lúc Chat sập vẫn vào được tới 24 giờ.

Khoá lạ chưa có trong danh sách làm máy hỏi Chat ngay (một heartbeat, mỗi khoá tối đa một lần trong 30 giây), nên thiết bị vừa đăng ký vào được ngay mà người lạ không bắt máy gọi Chat liên tục được.

### Ràng buộc khi chạy claude CLI

1. Chạy đúng file `claude` người dùng đã cài (`pathToClaudeCodeExecutable`), không dùng bản kèm trong gói SDK.
2. Không đọc, lưu, chuyển token hay credential Claude; người dùng tự đăng nhập bằng `claude`. Tiến trình nền không gọi API Anthropic.
3. Mỗi người dùng chạy bằng gói hoặc key Claude của chính họ.
4. Không dùng "Claude Code"/"Anthropic" làm tên tính năng hay logo.

### An toàn phiên

- `settingSources: ['user']` mặc định: `.claude/settings.json` và hook của dự án không có hiệu lực, trừ khi người dùng tick "Nạp cấu hình .claude của dự án" (ghi nhật ký).
  Máy chỉ nạp cấu hình đó ở thư mục đã tin (`tunelo trust` trên máy). Từ `tunelo` 2.0.1, thiết bị của tài khoản tin được thư mục ngay
  trên web bằng nút "Tin thư mục này và mở phiên" (`Consent.trust_project`); máy ghi nhật ký đồng ý (thiết bị, thời điểm, thư mục,
  `project_settings`/`trust`). Thư mục nhạy cảm (home, gốc ổ đĩa…) chỉ tin được trên máy, vì tin nó là tin mọi thư mục con.
  Từ 12/11/2026 (Jev chốt): mức cấu hình dự án theo **thư mục** (`ProjectConfigSet`, `ProjectConfigLevel` OFF/FULL), mặc định OFF,
  người dùng bật một lần, máy nhớ theo thư mục (và thư mục con) và áp cho phiên chat mới lẫn phiên mở lại, không cần tick từng phiên;
  nhật ký ghi `project_settings` với thư mục và `level:full`/`level:off`. Mức giữa "chỉ skill và lệnh" để dành trong enum nhưng
  không làm: Claude Code nạp cấu hình dự án nguyên khối, và skill dự án mang theo hook cùng `allowed-tools` trong front matter, có
  hiệu lực khi skill chạy kể cả khi nạp riêng skill (thử với `claude` 2.1.322:
  [`project-config-real-claude.test.ts`](../../apps/agent/test/project-config-real-claude.test.ts)). Terminal của luồng chạy CLI
  với nguồn cài đặt mặc định của nó (không `--setting-sources`).
- `strictMcpConfig` + chỉ MCP người dùng bật tại máy B. Chế độ quyền theo đúng cấu hình Claude của máy B (`permissions.defaultMode` và luật allow/deny trong settings của người dùng; settings dự án chỉ nạp khi người dùng tick), kể cả `bypassPermissions` nếu chủ máy đã đặt vậy. Máy A thấy chế độ hiện tại và đổi được trong khung chat (`ThreadSetPermissionMode`, đại ca chốt 08/11/2026 chiều, thay "chỉ hiển thị"): chỉ trong các chế độ máy B liệt kê ở `ThreadInfo.permission_modes` (default, acceptEdits, plan, auto); `bypassPermissions` chỉ có trong danh sách khi chính cấu hình máy B khởi động phiên ở chế độ đó, nên máy A không bao giờ tự bật được. Mỗi lần đổi ghi vào nhật ký đồng ý trên máy B (`permission_mode`). Effort đổi bằng `ThreadSetEffort`; lựa chọn của thiết bị lưu theo phiên, mở lại phiên vẫn giữ. Thanh trạng thái hiện tài khoản Claude đang đăng nhập (email, tổ chức, gói) lấy từ `accountInfo()` của CLI, không có token.
- Thư mục nhạy cảm (`~`, `/`, `~/.ssh`, `~/.aws`, thư mục cấu hình của tiến trình nền…) không bị chặn mà phải xác nhận; đồng ý được ghi vào nhật ký trên máy B.
- Rủi ro còn lại: XSS trên `chat.hoandat.com` dùng được khoá thiết bị (non-extractable) trong lúc trang mở, dù không lấy được khoá ra. Giảm bằng CSP chặt và xoá khoá khi đăng xuất.

## Cài đặt và phát hành tunelo (08/11/2026)

- Lệnh và file chạy `tunelo` (`%LOCALAPPDATA%\tunelo\tunelo.exe` / `~/.local/bin/tunelo`); thư mục cấu hình `%APPDATA%\tunelo`, `~/.config/tunelo` (biến `TUNELO_HOME`); LaunchAgent `com.hoandat.tunelo`, giá trị Run `tunelo`; Keychain `com.hoandat.tunelo`. Danh tính máy: `deviceId = tunelo.<machineId>` (subdomain suy từ tài khoản và `deviceId`), `machineId`, `machineSecret`, khoá X25519.
- Phát hành: tag `tunelo-v<semver>`, chú thích ký `tunelo <version> <file>`. Từ 3.0.0 release chỉ đăng file nén mỗi nền tảng (`tunelo-<os>-<arch>.tar.gz`, `tunelo-windows-x64.zip`), mỗi file chứa `tunelo`, `tunelo-term-host` và chữ ký minisign của từng file; `SHA256SUMS` và chữ ký tính trên file nén ([`package-release.sh`](../../apps/agent/scripts/package-release.sh)). Lý do giữ chữ ký từng file: term-host và `tunelo update --rollback` kiểm từng binary.
- Cài (từ 3.0.0): trang "Thêm máy" hiện một lệnh cố định không tham số, bốn tab (macOS và Linux `curl … | sh`, Windows PowerShell `irm … | iex`, Windows cmd là một dòng `powershell -NoProfile -c "irm … | iex"`, không `-ExecutionPolicy Bypass`). Script tải file nén đã ghim, kiểm rồi chạy `tunelo login`: đăng nhập, cài dịch vụ nền, máy tự đăng ký (có chứng minh khoá máy) và tự liên kết Localman. Lệnh cmd giống kiểu lừa "ClickFix" nên có thể bị Defender chặn; khi đó mới đổi sang tải zip.
- `install.sh`/`install.ps1` thấy gói npm `tunelo` 1.x thì nhắc `npm uninstall -g tunelo` (không tự gỡ).
- Rủi ro macOS: LaunchAgent và Keychain cần phiên đăng nhập GUI (`gui/<uid>`). Mac headless tắt tự đăng nhập không chạy được tiến trình nền; cài qua SSH thì `launchctl bootstrap` hỏng. Nghiệm thu trên Mac làm khi có phiên GUI.
- Linux (từ `tunelo` 2.2.0, chốt 10/11/2026):
  - Bản `tunelo-linux-x64` và `tunelo-linux-arm64`, dùng glibc (Alpine/musl chưa hỗ trợ, `install.sh` từ chối), cùng chữ ký minisign và `SHA256SUMS` như các bản khác.
  - Dịch vụ là systemd **user unit** `~/.config/systemd/user/tunelo.service` (`Restart=always`), không cần root; tunelo không bao giờ tự gọi `sudo`.
  - Chạy khi chưa đăng nhập cần `loginctl enable-linger`: tunelo thử không cần mật khẩu; không được thì vẫn cài và chạy, rồi in `sudo loginctl enable-linger <user>` để chủ máy chạy một lần.
  - Kho khoá là tệp 0600 trong thư mục cấu hình; không dùng libsecret/secret-service. Giới hạn: ai đọc được thư mục cấu hình là đọc được khoá máy.
  - Chia sẻ màn hình của máy chỉ có trên macOS.

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

## Kiểm trên Linux (10/11/2026)

Binary dựng bằng Bun 1.3.14, cùng một chương trình thử gọi đúng mã dịch vụ của tunelo trên systemd thật, người dùng thường, Ubuntu 22.04 (glibc 2.35, CPU có AVX2) và Ubuntu 24.04 (glibc 2.39): binary báo 2.2.0; chưa có phiên systemd của người dùng thì lỗi nêu đúng tên người dùng và cách xử lý; sau `loginctl enable-linger` cài dịch vụ được, `kill -9` thì có PID mới trong khoảng 13 giây; stop, start, cài lại khi đang chạy, gỡ (gỡ lần hai và dừng khi chưa cài báo lỗi rõ) đều đúng; tunelo thật chạy dưới dịch vụ, `status` nhận provider `claude` khi có ở `~/.local/bin` (rỗng khi máy không có `claude`), `fullDiskAccess: not-applicable`. Bẫy gặp: `claude` cài riêng cho root thì người dùng khác không chạy được, nên tunelo không thấy provider.

Chưa kiểm: bản arm64 chạy thật, đăng ký máy vào Chat và chạy phiên Claude Code trên Linux, `curl … | sh` thật trên Linux (cần bản 2.2.0 đã phát hành và ghim), `tunelo update` trên Linux, Alpine/musl, CPU không có AVX2 (bản x64 mặc định có thể cần AVX2).

## Hệ quả

- Thêm `packages/remote-protocol` (chạy trên trình duyệt và Node), `apps/agent`, `proto/remote/v1` (sinh TS vào `@achoo254/chat-proto/remote/*`).
- Mỗi adapter AI mới phải qua bộ test hợp đồng `provider-contract` trước khi gộp.
