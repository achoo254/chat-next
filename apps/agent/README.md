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

## Phiên Claude Code hai chiều giữa Chat và máy

Phiên AI Agent là phiên Claude Code bình thường của máy, không phải bản sao:

- **Mở trong Chat, làm tiếp trên máy.** tunelo chạy `claude` của máy qua Agent SDK, ở đúng thư mục đã chọn và với thư mục
  Claude của máy (profile mặc định không đổi `CLAUDE_CONFIG_DIR`; profile khác dùng chung `projects/` qua link). Bản ghi nằm ở
  `~/.claude/projects/<thư mục mã hoá>/<session id>.jsonl` (`entrypoint: sdk-ts`), nên trên máy chỉ cần `cd` vào thư mục đó và
  chạy `claude --resume` (hoặc `claude --resume <session id>`).
- **Mở trên máy, làm tiếp trong Chat.** Hộp thoại Phiên mới › tab "Phiên có sẵn trên máy" liệt kê các phiên trong
  `projects/` của thư mục Claude của máy và của mọi profile (Terminal, IDE, Claude Desktop, Chat), nhóm theo thư mục,
  có tìm kiếm và phân trang. Mở một phiên: lịch sử (tin người dùng, trả lời, tool, diff) hiện ngay; tin nhắn đầu tiên resume
  đúng session id trong thư mục của nó. Thư mục nhạy cảm và cấu hình `.claude` của dự án hỏi đồng ý như phiên mới.
- **Lượt gõ trên máy sau đó** (`claude --resume` trong Terminal) hiện trong Chat khi mở lại phiên hoặc gửi tin tiếp; phiên đang
  mở trong tunelo được mở lại để Claude đọc cả phần đó.
- **Mở hai nơi cùng lúc:** phiên "có vẻ đang mở ở nơi khác" khi bản ghi vừa đổi trong 60 giây, khi một `claude` đang chạy ghi
  nó trong `sessions/<pid>.json` của thư mục Claude mà tunelo biết, hoặc khi một tiến trình `claude` đang chạy (bất kể ai mở,
  kể cả với `CLAUDE_CONFIG_DIR` riêng) làm việc trong thư mục của phiên và phiên đổi sau lúc tiến trình bắt đầu (phiên mới
  nhất, mỗi tiến trình một phiên; `--resume <id>` trên dòng lệnh thì đúng phiên đó). macOS/Linux đọc bằng `ps` và `lsof`
  (thư mục làm việc, giờ bắt đầu), giữ 5 giây; Windows chỉ dùng hai cách đầu. tunelo không đọc thư mục cấu hình của ứng dụng
  nào khác. Web hỏi lại trước khi mở. Giới hạn: lượt gõ trên máy trong lúc Chat đang chạy một lượt của cùng phiên không được
  đọc vào.

Đọc ít: danh sách chỉ đọc đầu file (thư mục, câu hỏi đầu) và cuối file (tiêu đề), giữ theo kích thước và giờ sửa; số tin
đếm một lần cho các phiên đang hiện (tối đa 256 MB mỗi lần hỏi) rồi chỉ đếm phần thêm. Mở một phiên dài chỉ đọc 8 MB cuối, bắt
đầu từ một tin người dùng. Nội dung bản ghi chỉ đi tới thiết bị đã ghép qua kênh mã hoá đầu cuối; tunelo không đọc token Claude.

## Lưu trữ và xoá phiên (2.0.6)

Menu ⋮ của phiên (và của dòng phiên ở cột trái: rê chuột, nhấn giữ trên điện thoại) có "Lưu trữ" và "Xoá phiên".

- **Lưu trữ** chỉ ẩn phiên khỏi danh sách trên mọi thiết bị (bộ lọc "Đã lưu trữ" để mở lại hay bỏ lưu trữ); không đụng file nào.
- **Xoá phiên** dừng tiến trình `claude` của phiên, chuyển vào **Thùng rác của hệ điều hành** (không xoá vĩnh viễn): bản ghi
  `<thư mục Claude>/projects/<thư mục>/<session id>.jsonl` và thư mục `<session id>/` bên cạnh của mọi phiên AI thread đó đã chạy,
  cùng đúng các tệp mà tin nhắn của thread đã lưu trong `.tunelo-attachments/` (tệp thường, không link, không nhạy cảm). Sau đó
  xoá journal của tunelo, ghi nhật ký đồng ý (`delete_session`) và báo mọi thiết bị. macOS dùng `trashItemAtURL` (như Finder),
  Windows dùng Recycle Bin, Linux `gio trash`; Thùng rác từ chối thì không xoá gì. Phiên đang chạy một lượt: web hỏi "Dừng và
  xoá". Phiên có vẻ đang mở ở nơi khác (đổi sau lần cuối tunelo ghi): web cảnh báo trước khi xoá. Máy cũ hơn 2.0.6: web ẩn mục.

## Ảnh và tệp đính kèm (2.0.5)

Ô nhập của phiên nhận tệp bằng nút đính kèm (điện thoại có thêm chụp ảnh), dán, hoặc kéo thả vào bất kỳ đâu trong phiên. Tệp đi
từng khúc 512 KB qua kênh mã hoá đầu cuối, không qua server Chat, ngay khi được thêm; có tiến trình, huỷ, thử lại.

- **Ảnh** PNG, JPEG, GIF, WebP (nhận theo byte của tệp) tới 3,75 MB đi thẳng cho Claude dạng ảnh. Ảnh lớn hơn, cạnh trên
  8000 px hay định dạng khác (HEIC…) được trình duyệt thu nhỏ trước. tunelo giữ ảnh cùng phiên trong thư mục dữ liệu của nó để
  thiết bị xem lại trong lịch sử (tải lại qua kênh mã hoá khi xem).
- **Tệp khác** lưu trong thư mục của phiên ở `.tunelo-attachments/<yyyy-mm-dd>/<tên>`; tin nhắn gửi Claude kèm đường dẫn tương
  đối. Tên tệp chỉ giữ phần cuối, bỏ ký tự hệ điều hành cấm, trùng thì thêm `(2)`. Thư mục đính kèm là link ra ngoài, hay đích
  nhạy cảm, đều bị từ chối. Trong repo git, `.tunelo-attachments/` được thêm vào `.git/info/exclude` (không sửa `.gitignore`).
- Giới hạn: 25 MB mỗi tệp, 10 tệp và 50 MB mỗi tin; tệp tải lên mà không gửi bị xoá sau một giờ. Máy cũ hơn 2.0.5 không nhận tệp:
  web ẩn nút đính kèm, dán hay kéo thả thì nhắc `tunelo update`.

## macOS cần phiên đăng nhập GUI

Bản chạy nền là LaunchAgent `com.hoandat.tunelo` trong phiên GUI của người dùng, và khoá máy nằm trong login Keychain. Mac không ai
đăng nhập (headless, tắt tự đăng nhập) không chạy được tiến trình nền, và qua SSH thì Keychain bị khoá. Bật tự đăng nhập, hoặc đăng
nhập GUI một lần sau mỗi lần khởi động máy.

## macOS: quyền Truy cập toàn bộ ổ đĩa (Full Disk Access)

Phiên làm trong Desktop, Documents, Downloads hoặc iCloud Drive cần tunelo có Full Disk Access; thiếu thì macOS chặn, hoặc hỏi bằng
hộp thoại trên máy mà không ai bấm nên phiên treo. Chỉ chủ máy cấp được: kéo `~/.local/bin/tunelo` vào danh sách ở Cài đặt hệ thống
› Quyền riêng tư & Bảo mật › Truy cập toàn bộ ổ đĩa, rồi bật công tắc.

- Script cài và `tunelo install` mở sẵn trang đó và một cửa sổ Finder chọn sẵn tunelo. `tunelo status` và log của dịch vụ in các
  bước khi còn thiếu (không mở gì, nên cũng không nói là đã mở).
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
