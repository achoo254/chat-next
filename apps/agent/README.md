# tunelo

Tiến trình máy của hệ sinh thái hoandat: tunnel tới `localhost` (CLI Tunelo), AI Agent trong Chat (chat với claude trên máy từ
thiết bị khác, mã hoá đầu-cuối), Localman gọi `localhost` của máy, MCP `tunelo` cho claude. Thiết kế:
[ADR 0013](../../docs/adr/0013-remote-machines.md), [ADR 0014](../../docs/adr/0014-tunelo-machine-agent.md).

Chạy trên macOS (arm64, x64) và Windows x64. Một file chạy do Bun build, ký minisign, phát hành ở GitHub Releases của repo này
(tag `tunelo-v<version>`). Không có gói npm. Từ 2.0.3, bản macOS còn được ký Developer ID (team `AM5C55N339`, identifier
`com.hoandat.tunelo`, hardened runtime) và notarize trong `agent-release.yml`.

## Cài

AI Agent › Máy › Thêm máy trong Chat hiện lệnh một dòng kèm khoá của thiết bị. Lệnh đó cài `tunelo`, hỏi mã ghép (dán vào, chữ
không hiện), rồi chạy `tunelo install`: đăng nhập trên trình duyệt, máy tự vào danh sách, không cần mã cài.

Chỉ cài file chạy và đăng nhập (cũng là cách cập nhật khi `tunelo update` không dùng được):

```sh
# macOS
curl -fsSL https://chat.hoandat.com/agent/install.sh | sh
```

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://chat.hoandat.com/agent/install.ps1)))
```

Script tải đúng phiên bản đã ghim, kiểm SHA-256, và kiểm chữ ký nếu máy có `minisign`. File chạy nằm ở `~/.local/bin/tunelo`
(macOS) hoặc `%LOCALAPPDATA%\tunelo\tunelo.exe` (Windows). Thư mục cấu hình là `~/.config/tunelo` hoặc `%APPDATA%\tunelo`
(biến `TUNELO_HOME` đổi được).

## Lệnh chính

| Lệnh | Việc |
|---|---|
| `tunelo login` / `logout` / `whoami` | Một lần đăng nhập cho tunnel, Chat, Localman; `whoami` hiện trạng thái từng app |
| `tunelo start` / `stop` | Bật, tắt bản chạy nền (tự chạy lúc đăng nhập máy) |
| `tunelo status` | Tunnel đang mở, rồi trạng thái máy, claude, phiên; thoát 1 khi dịch vụ không chạy |
| `tunelo logs -f` | Xem log liên tục (`agent.log` trong thư mục cấu hình) |
| `tunelo update` (`--check`) | Cài bản ký mới nhất rồi khởi động lại |
| `tunelo pair` | Ghép thêm thiết bị bằng QR hoặc mã 6 số |
| `tunelo devices list` / `revoke <khoá>` | Thiết bị đã ghép |
| `tunelo claude profiles list` / `add` / `select <profile>` / `remove <profile>` | Các tài khoản Claude của máy; `add` đăng nhập ngay trong terminal; `select` đổi profile cho cả máy: phiên rảnh mở lại ngay dưới profile mới (cùng hội thoại), phiên đang chạy đổi sau lượt hiện tại |
| `tunelo http <cổng>` / `tcp <cổng>` | Mở tunnel; inspector request ở `127.0.0.1:4040`, `tunelo watch` xem request |
| `tunelo kill <pid\|subdomain\|all>` | Đóng tunnel |
| `tunelo link <mã>` / `links list` / `links revoke <id>` | Liên kết máy với Localman |
| `tunelo config local-forward [on\|off\|block\|unblock] [cổng…]` | Cho Localman gửi request tới `localhost` của máy (mặc định bật) |
| `tunelo config mcp-local-writes [on\|off]` | Cho client MCP ngoài phiên của tunelo dùng tool ghi (mặc định tắt) |
| `tunelo mcp` | Server MCP (stdio): tool tunnel, Chat, Localman |
| `tunelo trust [thư mục]` / `untrust` / `trusted` | Thư mục được nạp cấu hình `.claude` của dự án; thiết bị đã ghép cũng tin được từ web (có ghi nhật ký), trừ thư mục nhạy cảm |
| `tunelo audit` | Nhật ký đồng ý |
| `tunelo run` | Chạy trong terminal để gỡ lỗi; từ chối khi đã có bản chạy nền |

`tunelo config mcp-local-writes on` chỉ chạy trong terminal thật và hỏi xác nhận (gõ `yes`). Chạy từ client AI, script hay pipe thì
bị từ chối. `off` luôn chạy được.

## Cập nhật

`tunelo update` đọc các release `tunelo-v*` của repo. Máy còn `hda` 0.2.x (tên cũ) chạy `hda update`: bản cầu nối `agent-v0.3.0`
chứa `tunelo` 2.0.0, và dịch vụ cũ tự chuyển sang `tunelo` khi khởi động lại (giữ máy, thiết bị đã ghép, subdomain, phiên).

Lối thoát: `hda` 0.2.x chỉ đọc 20 release mới nhất. Khi `agent-v0.3.0` trôi khỏi đó, `hda update` báo không có bản mới. Chạy lại
script cài ở trên. Script thấy `hda` thì chạy `tunelo migrate-from-hda`, thấy gói npm `tunelo` 1.x thì nhắc
`npm uninstall -g tunelo` (không tự gỡ).

## macOS cần phiên đăng nhập GUI

Bản chạy nền là LaunchAgent `com.hoandat.tunelo` trong phiên GUI của người dùng, và khoá máy nằm trong login Keychain. Mac không ai
đăng nhập (headless, tắt tự đăng nhập) không chạy được tiến trình nền, và qua SSH thì Keychain bị khoá. Bật tự đăng nhập, hoặc đăng
nhập GUI một lần sau mỗi lần khởi động máy.

## macOS: quyền Truy cập toàn bộ ổ đĩa (Full Disk Access)

Phiên làm trong Desktop, Documents, Downloads hoặc iCloud Drive cần tunelo có Full Disk Access; thiếu thì macOS chặn, hoặc hỏi bằng
hộp thoại trên máy mà không ai bấm nên phiên treo. Chỉ chủ máy cấp được: kéo `~/.local/bin/tunelo` vào danh sách ở Cài đặt hệ thống
› Quyền riêng tư & Bảo mật › Truy cập toàn bộ ổ đĩa, rồi bật công tắc.

- Script cài và `tunelo install` mở sẵn trang đó và một cửa sổ Finder chọn sẵn tunelo. `tunelo status` in các bước khi còn thiếu.
- Dịch vụ dò quyền mà không gây hộp thoại, báo cho thiết bị (`MachineInfo.needs_full_disk_access`; web hiện banner có nút mở lại
  trang cài đặt trên máy). Khi còn thiếu, nó kiểm lại vài giây một lần và báo ngay khi được cấp, không cần khởi động lại.
- Nhờ chữ ký Developer ID, quyền đã cấp giữ qua các lần `tunelo update`. Bản 2.0.2 trở về trước ký ad-hoc nên phải cấp lại một lần
  sau khi lên 2.0.3.

## Gỡ

1. Xoá máy ở AI Agent › Máy trong Chat (thu hồi máy và thiết bị đã ghép).
2. `tunelo logout`: thu hồi đăng nhập của máy trên IdP.
3. `tunelo uninstall`: dừng dịch vụ và bỏ khởi động lúc đăng nhập.
4. Xoá file chạy (`~/.local/bin/tunelo` hoặc `%LOCALAPPDATA%\tunelo`) và thư mục cấu hình (`~/.config/tunelo` hoặc
   `%APPDATA%\tunelo`; trên Windows khoá DPAPI nằm trong đó).
5. macOS: xoá khoá Keychain:
   `security delete-generic-password -s com.hoandat.tunelo -a machine-key` và
   `security delete-generic-password -s com.hoandat.tunelo -a session-key`.

Profile Claude nằm trong thư mục cấu hình (`claude-profiles/`). Xoá thư mục đó không đụng `~/.claude` của máy, nhưng đăng xuất từng
profile trước (`tunelo claude profiles remove <profile>`) để claude thu hồi phiên đăng nhập của nó.

## Phát triển

```sh
pnpm --filter @achoo254/tunelo-agent test        # vitest, tối đa 2 worker
pnpm --filter @achoo254/tunelo-agent typecheck
bun build --compile --target=bun-darwin-arm64 apps/agent/src/cli.ts --outfile dist/tunelo
```

Thử tay luôn đặt cả `HOME` và `TUNELO_HOME` tạm (thêm `TUNELO_KEYSTORE=file` để không đụng Keychain/DPAPI thật). Chỉ `TUNELO_HOME`
thôi thì tunelo vẫn đọc và chuyển phiên của CLI 1.x ở `~/.tunelo` thật.

Test cần Bun (`test/tunnels/forward-under-bun.test.ts`, `test/stream-holders.test.ts`) chạy khi có `bun` trên PATH hoặc
`TUNELO_TEST_BUN`; CI dùng đúng Bun của bản phát hành (`.github/actions/setup-bun`). Phần chỉ có trên hệ thật (DPAPI, junction,
`netstat`/`lsof`) ở `test/os-integration.test.ts`, CI chạy trên `windows-latest`.

Phát hành: xem đầu [`agent-release.yml`](../../.github/workflows/agent-release.yml) và
[`scripts/pin-release.ts`](scripts/pin-release.ts).
