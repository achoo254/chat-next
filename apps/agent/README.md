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
| `tunelo secrets list` / `remove <id>` | Bí mật đăng nhập đã lưu cho Claude (trang, tên, lần dùng cuối; không bao giờ in giá trị) |
| `tunelo browser status` / `close` / `clear` (cũng xoá được từ trang máy trên web) | Trình duyệt riêng của tunelo cho Claude: trình duyệt nào, hồ sơ ở đâu, có đang chạy; đóng (giữ đăng nhập); `clear` xoá hồ sơ (đăng xuất mọi trang, ghi nhật ký) |
| `tunelo audit` | Nhật ký đồng ý |
| `tunelo run` | Chạy trong terminal để gỡ lỗi; từ chối khi đã có bản chạy nền |

`tunelo config mcp-local-writes on` chỉ chạy trong terminal thật và hỏi xác nhận (gõ `yes`). Chạy từ client AI, script hay pipe thì
bị từ chối. `off` luôn chạy được.

## Cập nhật

`tunelo update` đọc các release `tunelo-v*` của repo. Máy còn `hda` 0.2.x (tên cũ) chạy `hda update`: bản cầu nối `agent-v0.3.0`
chứa `tunelo` 2.0.0, và dịch vụ cũ tự chuyển sang `tunelo` khi khởi động lại (giữ máy, thiết bị đã ghép, subdomain, phiên).

Máy đã gỡ trên web rồi thêm lại (cài lại bằng lệnh của "Thêm máy") mà Chat thấy không có tunnel, ô mã ghép bị khoá: `tunelo` 2.0.13
trở về trước xin relay cái tên subdomain của lần thêm trước, relay từ chối và máy ở yên ngoài mạng. Từ 2.0.14 tunnel không xin tên
nào (relay tự suy từ tài khoản và số máy); chạy `tunelo update` là máy lên mạng lại.

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
- **Tên phiên** (2.0.9): theo tên Claude đặt cho phiên, hoặc tên người dùng đặt bằng `/rename` trên máy; cập nhật sau mỗi lượt và
  khi mở lại phiên. Nút + của dự án mở phiên trống (chưa gửi gì); tin nhắn đầu tiên chạy Claude và làm tên tạm.

Đọc ít: danh sách chỉ đọc đầu file (thư mục, câu hỏi đầu) và cuối file (tiêu đề), giữ theo kích thước và giờ sửa; số tin
đếm một lần cho các phiên đang hiện (tối đa 256 MB mỗi lần hỏi) rồi chỉ đếm phần thêm. Mở một phiên dài chỉ đọc 8 MB cuối, bắt
đầu từ một tin người dùng. Nội dung bản ghi chỉ đi tới thiết bị đã ghép qua kênh mã hoá đầu cuối; tunelo không đọc token Claude.

## Đăng nhập khi điều khiển từ xa: bí mật (2.0.8)

Trong phiên tunelo mở, Claude xin mật khẩu/token bằng tool MCP `request_secret(name, purpose, origin)`. Claude chỉ nhận **tham
chiếu** (`secret://…`), không bao giờ nhận giá trị.

- Máy đã lưu bí mật cho đúng (origin, name): trả tham chiếu ngay. Chưa có: mọi thiết bị đang kết nối hiện thẻ "Claude cần thông tin
  đăng nhập" phía trên ô nhập, **ngoài transcript** (không vào lịch sử phiên, không vào journal), phiên hiện "Cần bạn" và có thể
  đẩy thông báo. Người dùng nhập ở một thiết bị; giá trị đi một khung E2E tới máy, trình duyệt xoá khỏi ô nhập ngay khi gửi. Chờ tối
  đa 5 phút; từ chối/hết hạn/phiên dừng thì Claude nhận lỗi nói rõ.
- "Lưu cho lần sau" (mặc định bật): niêm phong bằng khoá trong Keychain/DPAPI, cùng origin và tên (chuyển sang trang khác thì không
  mở được), ghi vào `secrets.json` (0600) trong thư mục cấu hình. Bỏ chọn: chỉ giữ trong bộ nhớ cho phiên đó.
- `fill_secret(ref, selector?, cdp_url?)`: tunelo điền vào ô của một trang **cùng origin** trong trình duyệt Claude điều khiển, qua
  Chrome DevTools Protocol (trình duyệt mở bằng `--remote-debugging-port`; tunelo tự tìm cổng từ tiến trình đang chạy và
  `DevToolsActivePort`, hoặc nhận `cdp_url` loopback). Trang tự kiểm lại origin của nó trong cùng đoạn script điền, nên trang vừa
  chuyển đi nơi khác không bị điền. Trình duyệt chạy qua pipe (mặc định của Playwright) thì không gắn được: lỗi nói rõ để Claude
  dùng cách env.
- Lệnh Bash: Claude viết `$TUNELO_SECRET_<NAME>`. Lệnh dùng bí mật luôn hiện thẻ duyệt (trừ `bypassPermissions`); duyệt xong tunelo
  ghi giá trị vào một file 0600 mà loader `CLAUDE_ENV_FILE` của phiên nạp trước lệnh, rồi làm rỗng file khi lệnh xong/lỗi. Giá trị
  không có trong nội dung lệnh, argv hay transcript.
- Che: hook PostToolUse thay output mọi tool trước khi Claude đọc (giá trị, base64, base64url, URL-encode, JSON-escape thành
  `[hidden]`; giá trị dưới 3 ký tự không che), sự kiện gửi web/journal, kết quả tool MCP, log đều qua cùng bộ che.
- Trang cài đặt máy có "Bí mật đã lưu" (trang, tên, lần dùng cuối, nút xoá); `tunelo secrets list|remove`. Nhật ký đồng ý ghi
  `secret_add` / `secret_use` (fill hoặc env) / `secret_remove`, không bao giờ ghi giá trị. Máy cũ hơn 2.0.8: web ẩn cả hai.
- Giới hạn: bảo vệ khỏi lộ tình cờ và khỏi lưu vào lịch sử, không chống được một phiên cố ý xấu (Claude điều khiển trình duyệt
  có thể đọc lại ô đã điền, lệnh được duyệt có thể gửi biến đi nơi khác). Vì vậy lệnh dùng bí mật luôn hỏi.

## Trình duyệt của máy: điều khiển từ xa và passkey (2.0.12)

Phiên tunelo mở có thêm 3 tool MCP. Không tool nào trả hình của trang hay thứ người dùng gõ.

- `open_browser(url?)`: mở (hoặc dùng lại) **hồ sơ Chrome riêng của tunelo** (`browser-profile/` trong thư mục cấu hình, 0700), tách
  khỏi hồ sơ Chrome của người dùng; đăng nhập (cookie) trong đó được giữ giữa các phiên. Chrome mở với cổng debug ngẫu nhiên trên
  127.0.0.1 (`--remote-debugging-port=0`), trả `{ cdp_url, ws_endpoint, tab, tabs, headless }` để Claude dùng Playwright
  `chromium.connectOverCDP(cdp_url)` (dùng `browser.contexts()[0]`), và `fill_secret` tự tìm ra nó. Tìm Chrome, Chromium, Edge, Brave
  (hoặc `TUNELO_BROWSER`). Không có màn hình (không ai đăng nhập desktop) thì chạy headless. macOS: hồ sơ dùng keychain giả
  (`--use-mock-keychain`) để Chrome không bao giờ hỏi Keychain trên máy không người; cookie vì vậy chỉ được bảo vệ bằng quyền thư mục.
  Cửa sổ bị che hay ẩn vẫn vẽ và nhận thao tác (`--disable-backgrounding-occluded-windows`…). tunelo dừng thì Chrome đóng theo.
- `request_takeover(reason, url?)`: Claude dừng; mọi thiết bị hiện thẻ "Cần bạn thao tác trên trình duyệt của máy" (ngoài transcript,
  phiên hiện "Cần bạn"). "Mở trình duyệt" hiện tab trực tiếp: máy chỉ bật screencast (`Page.startScreencast`, JPEG chất lượng 60,
  tối đa 1600 px, tối đa 10 hình/giây, bỏ hình khi kết nối của thiết bị đang nghẽn) **khi có thiết bị đang xem** và trang web đang
  hiện; người dùng click, kéo, cuộn, gõ (`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`), đổi tab, thanh địa chỉ chỉ
  đọc. Điện thoại: toàn màn hình, chạm = click, một ngón = cuộn trang, hai ngón = phóng to hình, nút "Bàn phím". Ô đang gõ là ô mật
  khẩu thì web báo và ô nhập của điện thoại thành ô mật khẩu (bàn phím không học). "Trả lại cho Claude" kết thúc: Claude nhận URL,
  tiêu đề, số tab (và `passkey_requests` nếu có), không có hình. Thao tác chỉ được nhận khi takeover đang mở; không ai thao tác 10
  phút thì tự kết thúc và Claude nhận lỗi. Hình và thao tác chỉ đi qua kênh E2E, không lưu, không ghi log, không vào journal.
  Nhật ký đồng ý ghi `browser_control` (thiết bị, site) khi trả lại.
- Trang máy có "Trình duyệt của máy" và nút "Xem trình duyệt của máy" khi hồ sơ đang chạy (takeover của chính người dùng).
- `virtual_authenticator(enable)`: passkey ảo (CDP WebAuthn, CTAP2, có xác minh người dùng) cho mọi tab kể cả tab mở sau, dùng cho
  test E2E app của người dùng; passkey tạo ra chỉ ở trong bộ nhớ, mọi tab dùng chung, mất khi tắt hoặc đóng trình duyệt.
- Phát hiện passkey thật: mỗi trang được tiêm script bọc `navigator.credentials.create/get` (bỏ qua passkey autofill
  `mediation: "conditional"`). Trang đòi passkey khi không bật passkey ảo: web hiện "Trang cần passkey" (mở điều khiển từ xa, chọn
  cách khác, hoặc chờ ở máy), và Claude nhận thông báo kèm kết quả tool kế tiếp (hook PostToolUse). Hộp thoại passkey của hệ điều
  hành vẫn cần người ở máy.
- `tunelo browser clear` xoá hồ sơ (đăng xuất mọi trang); Claude chạy lệnh `tunelo browser …` luôn bị hỏi như lệnh nhạy cảm.

## Màn hình của máy qua Chia sẻ màn hình của macOS (2.0.13)

Cho các hộp thoại của hệ điều hành mà trình duyệt không thấy (sheet passkey, hộp mật khẩu Keychain).

- tunelo **không bao giờ** bật hay đổi cài đặt hệ thống. Thiết bị hỏi trạng thái (`ScreenShareStatusRequest`): có dịch vụ VNC trả lời
  trên `127.0.0.1:5900` không (đọc lời chào `RFB `), có nghe ngoài loopback không (`netstat -an -p tcp`), tường lửa có bật và chặn
  mọi kết nối đến không (`socketfilterfw --getglobalstate`, `--getblockall`). Chưa bật: web hướng dẫn 2 bước (Cài đặt hệ thống →
  Cài đặt chung → Chia sẻ → Chia sẻ màn hình; chỉ cho tài khoản của mình). Mở ra mạng: web cảnh báo, không tự sửa.
- Chỉ khi người dùng bấm "Điều khiển toàn màn hình", tunelo mở **một** luồng TCP tới `127.0.0.1:5900` và chuyển byte hai chiều qua
  kênh E2E sẵn có (`ScreenShareData`, tối đa 256 KiB mỗi khung, tạm dừng đọc khi kết nối thiết bị nghẽn). Một phiên một lúc; hết
  khi thiết bị đóng, 10 phút không có gì từ thiết bị (web cũng tự đóng sau 10 phút không thao tác), dịch vụ đóng, link thiết bị
  đóng, hoặc tunelo dừng. Nhật ký đồng ý ghi `screen_share`; log chỉ có "opened by …"/"closed (…)", không nội dung.
- Xác thực VNC của Apple (ARD, kiểu 30) diễn ra giữa noVNC trên thiết bị và dịch vụ của Apple: tên và mật khẩu Mac chỉ đi qua tunelo
  dưới dạng byte mã hoá, tunelo không đọc, không lưu, không log.
- Web dùng noVNC 1.7.0 (MPL-2.0, mã nguồn <https://github.com/novnc/noVNC>), nạp lười; một file được vá, xem
  [`patches/README.md`](../../patches/README.md).
- Trang máy có nút "Xoá hồ sơ trình duyệt" (cùng việc với `tunelo browser clear`, có xác nhận, ghi `browser_clear`).
- `request_takeover(…, os_dialog: true)`: Claude báo hộp thoại hệ điều hành đang chờ; thẻ trên web đưa "Điều khiển toàn màn hình"
  lên đầu.

## Dự án (2.0.7)

Cột AI Agent nhóm phiên theo máy → dự án → phiên; phiên ngoài mọi dự án nằm ở "Khác". Danh sách dự án lưu trên máy trong
`config.json` của tunelo (ghi nguyên tử): id, tên, thư mục, ghim, thứ tự, cài đặt mặc định cho phiên mới (model, chế độ quyền,
nạp `.claude` của dự án). Mọi thay đổi gửi ngay tới mọi thiết bị đang kết nối.

- **Thêm**: chọn thư mục có sẵn (thư mục nhạy cảm phải đồng ý, ghi nhật ký `project_add`); **clone** từ git (chỉ `https://` hoặc
  ssh, không kèm mật khẩu/token; có tiến trình và huỷ, huỷ hay lỗi thì xoá đúng thư mục clone vừa tạo); **tạo mới** một thư mục
  (+ `git init`). Clone và tạo mới không bao giờ ghi vào thư mục đã tồn tại hay thư mục nhạy cảm; tên thư mục chỉ là một phần
  đường dẫn.
- Mọi lệnh git của tunelo tắt chương trình do repo tự đặt (`core.fsmonitor`, hooks qua `core.hooksPath`), clone không dùng
  template hook và chỉ cho giao thức https/ssh, không hỏi mật khẩu (`GIT_TERMINAL_PROMPT=0`, ssh `BatchMode`).
- Trạng thái git mỗi dự án (nhánh, số file đổi, ahead/behind) đọc bằng `git status --porcelain=v2`, giữ 1 phút và đọc lại khi một
  phiên trong dự án xong lượt. Dự án mất thư mục hiện "Thư mục không còn trên máy".
- Nút **+** của dự án mở phiên ngay với cài đặt mặc định và câu đầu gợi ý; menu dự án: phiên mới (tuỳ chỉnh), đổi tên, ghim,
  chuyển lên/xuống, cài đặt, **gỡ** (chỉ bỏ khỏi danh sách, thư mục giữ nguyên). Gợi ý "Thêm làm dự án?" lấy từ thư mục đã có
  phiên (của tunelo và `~/.claude/projects`). Máy cũ hơn 2.0.7: web giữ cột như cũ.

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
