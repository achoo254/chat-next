# tunelo

Tiến trình máy của hệ sinh thái hoandat: tunnel tới `localhost` (CLI Tunelo), AI Agent trong Chat (chat với AI cài trên máy từ
thiết bị khác, mã hoá đầu-cuối: Claude Code hoặc Antigravity), Localman gọi `localhost` của máy, MCP `tunelo` cho Claude Code. Thiết kế:
[ADR 0013](../../docs/adr/0013-remote-machines.md), [ADR 0014](../../docs/adr/0014-tunelo-machine-agent.md).

Chạy trên macOS (arm64, x64), Windows x64 và Linux x64, arm64 (glibc, có systemd; từ 2.2.0). Một file chạy do Bun build, ký minisign, phát hành ở GitHub Releases của repo này
(tag `tunelo-v<version>`) dưới dạng file nén mỗi nền tảng ([`scripts/package-release.sh`](scripts/package-release.sh)). Không có gói npm. Từ 2.0.3, bản macOS còn được ký Developer ID (team `AM5C55N339`, identifier
`com.hoandat.tunelo`, hardened runtime) và notarize trong `agent-release.yml`.

## Cài

AI Agent › Máy › Thêm máy trong Chat hiện một lệnh cố định, không tham số, theo hệ điều hành của trình duyệt (bốn tab):

```sh
# macOS và Linux (x86_64/amd64, aarch64/arm64)
curl -fsSL https://chat.hoandat.com/agent/install.sh | sh
```

```powershell
# Windows PowerShell
irm https://chat.hoandat.com/agent/install.ps1 | iex
```

```bat
:: Windows cmd
powershell -NoProfile -c "irm https://chat.hoandat.com/agent/install.ps1 | iex"
```

Script tải file nén của bản đã ghim (`tunelo-<os>-<arch>.tar.gz`, Windows `tunelo-windows-x64.zip`), kiểm SHA-256, và kiểm chữ
ký minisign của file nén và của từng file trong đó nếu máy có `minisign`. Rồi nó cài `tunelo` và `tunelo-term-host` (tiến trình
Rust giữ terminal, [đặc tả](../../docs/terminal-wire.md)) và chạy `tunelo login`: trình duyệt mở trang đồng ý của auth-next, bấm
"Đồng ý" là máy đăng nhập, chạy nền, tự vào danh sách máy (và liên kết Localman), trang "Thêm máy" tự chuyển "đã kết nối". Trang
đồng ý chỉ nhận mã điền sẵn khi trình duyệt cùng IP với máy; cài qua SSH hay máy không có trình duyệt thì mở link in trong terminal
ở thiết bị khác và gõ mã đang hiện. Thông báo theo ngôn ngữ của hệ điều hành. Chạy lại lệnh cài là cách cập nhật khi `tunelo update`
không dùng được.

File chạy nằm ở `~/.local/bin/tunelo` (macOS, Linux) hoặc `%LOCALAPPDATA%\tunelo\tunelo.exe` (Windows). Thư mục cấu hình là
`~/.config/tunelo` trên macOS và Linux (hoặc `$XDG_CONFIG_HOME/tunelo` khi có biến này), `%APPDATA%\tunelo` trên Windows; biến
`TUNELO_HOME` đổi được ([`config.ts`](src/config.ts)). Script ghi PATH vào `~/.zprofile` (và `~/.bash_profile` nếu có) trên macOS,
vào `~/.profile`, `~/.bashrc` (nếu có) và `~/.zshrc` (nếu shell là zsh) trên Linux; Windows thêm `%LOCALAPPDATA%\tunelo` vào PATH
của người dùng. Alpine và bản musl khác bị từ chối.

Máy đã có bản term-host do `tunelo update` đặt trong `<thư mục cấu hình>/term-host/bin/current/` thì bản mới được đặt sẵn ở
`term-host/bin/next/`. Tunelo chuyển sang bản mới khi không còn terminal nào mở. Nếu mọi terminal đang mở đều là AI của một phiên
đã nghỉ ít nhất 10 phút, tunelo cũng chuyển ngay, rồi mở lại từng AI tiếp tục đúng cuộc trò chuyện cũ. Giấy phép các thư viện của nó:
[`docs/term-host-licenses.md`](../../docs/term-host-licenses.md).

Windows, tuỳ chọn: terminal nối thẳng cần UDP vào. Không có quy tắc tường lửa thì kết nối thử chiều ra trước, không được thì đi qua
relay (vẫn dùng được, chậm hơn); Windows có thể hiện hộp thoại tường lửa lần đầu. Muốn mở sẵn, chạy một lần trong PowerShell
**Run as administrator** của chính tài khoản cài tunelo (tài khoản quản trị khác thì ghi đường dẫn đầy đủ thay cho biến môi trường):

```powershell
foreach ($p in "$env:LOCALAPPDATA\tunelo\tunelo-term-host.exe", "$env:APPDATA\tunelo\term-host\bin\current\tunelo-term-host.exe") {
  netsh advfirewall firewall add rule name="tunelo terminal" dir=in action=allow protocol=UDP program="$p" enable=yes profile=private,public
}
# Gỡ: netsh advfirewall firewall delete rule name="tunelo terminal"
```

Binary Windows chưa ký mã (Authenticode), nên SmartScreen hay Defender có thể báo "nhà phát hành không xác định"; ký mã Windows
nằm ngoài phạm vi hiện tại.

## Lệnh

`tunelo --help` chỉ hiện hai nhóm ([`src/cli-help.ts`](src/cli-help.ts)); cờ và mô tả của từng lệnh: `tunelo <lệnh> --help`.

| Lệnh | Việc |
|---|---|
| `tunelo login` | Đăng nhập một lần cho tunnel, Chat và Localman, cài dịch vụ nền, đợi máy vào AI Agent rồi báo đã kết nối. Chạy lại khi đã kết nối thì chỉ kiểm |
| `tunelo logout` [`--force`] | Gỡ máy khỏi tài khoản (Chat, liên kết Localman), dừng dịch vụ nền, xoá đăng nhập; giữ binary và khoá máy, nên `login` lại giữ mục máy cũ. Mất mạng thì không đổi gì, trừ khi có `--force` |
| `tunelo status` [`--json`] | Phiên bản, tài khoản, trạng thái tunnel/Chat/Localman, dịch vụ nền, máy trong AI Agent, số thiết bị tin cậy, tunnel đang chạy; thoát 1 khi dịch vụ không chạy |
| `tunelo update` (`--check`, `--rollback`) | Cài bản ký mới nhất rồi khởi động lại (cũng làm được từ trang máy trong Chat). Tải file nén, kiểm SHA-256 và chữ ký minisign của file nén và của từng file trong đó rồi mới thay. `--rollback` đưa về bản mà lần `update` trước đã thay (kiểm lại chữ ký), terminal đang mở giữ nguyên |
| `tunelo uninstall` | `logout` (mất mạng thì cảnh báo và đi tiếp), rồi gỡ dịch vụ nền, thư mục cấu hình, mục Keychain, dòng PATH và binary (mục "Gỡ") |
| `tunelo logs` [`-n <số dòng>`] [`-f`] | Log của dịch vụ (`agent.log` trong thư mục cấu hình) |
| `tunelo http <cổng>…` / `tcp <cổng>` | Mở tunnel; inspector request ở `127.0.0.1:4040` |
| `tunelo kill <pid\|subdomain\|all>` | Đóng tunnel |
| `tunelo watch [đích]` | Xem request của tunnel |
| `tunelo config` (`--show`, `-s`, `-k`) | Cấu hình mặc định của tunnel |

Lệnh ẩn khỏi help nhưng vẫn chạy:

- Của dịch vụ: `start`, `stop` (bật, tắt bản chạy nền; nó tự chạy lúc đăng nhập máy), `run` (chạy trong terminal để gỡ lỗi; từ chối
  khi đã có bản chạy nền), `mcp` (server MCP stdio, xem ADR 0013), `disk-access`.
- Chỉ người ngồi trước máy được đổi, cố ý không có trên web để AI không tự bật: `trust [thư mục]` / `untrust` / `trusted` (thư mục
  được nạp cấu hình `.claude` của dự án; thư mục thường cũng bật được từ web, có ghi nhật ký), `config local-forward
  [on|off|block|unblock] [cổng…]` (cho Localman gửi request tới `localhost` của máy, mặc định bật), `config mcp-local-writes
  [on|off]` (cho client MCP ngoài phiên của tunelo dùng tool ghi, mặc định tắt; `on` chỉ chạy trong terminal thật và hỏi xác nhận
  gõ `yes`, chạy từ client AI, script hay pipe thì bị từ chối; `off` luôn chạy được). Claude chạy các lệnh này luôn bị hỏi như lệnh
  nhạy cảm ([`src/safety/sensitive-paths.ts`](src/safety/sensitive-paths.ts)).

Thiết bị (trình duyệt, app điện thoại) không ghép với máy: mọi thiết bị đã đăng nhập cùng tài khoản tự đăng ký khoá khi vào khu Máy,
và máy tin các khoá Chat liệt kê. Xem, thu hồi thiết bị: "Thiết bị của tài khoản" ở trang Quản lý máy trong Chat. Mô hình tin cậy,
đánh đổi và biện pháp bù: [ADR 0013](../../docs/adr/0013-remote-machines.md), mục "Tài khoản là gốc tin cậy". Nhật ký đồng ý, bí
mật đã lưu, trình duyệt của máy, tài khoản AI và số liệu sử dụng xem và quản lý trên trang máy trong Chat.

## Cập nhật

`tunelo update` đọc các release `tunelo-v*` của repo.

Có gì ở 3.3.3: không phải chờ đóng hết terminal mới dùng được `tunelo-term-host` mới tải về. Khi mọi terminal đang mở đều là AI
của một phiên đã nghỉ ít nhất 10 phút, tunelo chuyển sang bản mới rồi mở lại từng AI, nối tiếp đúng cuộc trò chuyện cũ. Còn
shell thường đang mở hoặc AI đang chạy thì vẫn chờ như trước.

Có gì ở 3.3.1: phiên Claude chạy trong terminal của máy vẫn báo "đang chạy" khi model nghĩ lâu mà chưa ghi gì (cột AI Agent
hiện biểu tượng đang chạy riêng của từng AI). Terminal mở lại từ thiết bị (đổi tab, Trò chuyện ⟷ Terminal, tải lại trang) cuộn
lên được: `tunelo-term-host` giữ 500 dòng lịch sử và gửi kèm những dòng mới nhất vừa một khung.

Có gì ở 3.1.0: AI của phiên viết thông điệp commit từ phần đã stage (nút trong Source Control; chỉ AI nào khai báo được mới
viết, không có AI mặc định; tệp bí mật chỉ gửi tên). Phiên chưa mở trên máy (chạy ở terminal, đang chờ tin đầu) vẫn có danh sách
lệnh `/` và skill trong chat: tunelo hỏi AI danh sách của thư mục mà không gửi tin nào, theo đúng tài khoản và chế độ nạp cấu hình
dự án của phiên.

Có gì ở 3.0.0: tài khoản là gốc tin cậy (không còn ghép thiết bị, mã Authenticator hay khoá thiết bị trong lệnh cài), lệnh cài một
dòng không tham số, `tunelo login` làm hết việc đăng ký máy, cây lệnh gọn (`logout` gỡ máy khỏi tài khoản, `uninstall` gỡ hẳn),
release chỉ còn file nén. Giao thức lên 3 và Chat chỉ nhận `tunelo` 3.0.0 trở lên: máy 2.x không tự cập nhật lên được, chạy lại lệnh
cài trên trang Máy của Chat.

Có gì ở 2.7.1: gửi ảnh vào terminal của phiên. Thiết bị tải ảnh lên qua kênh mã hoá như file đính kèm của tin nhắn, rồi
`AttachmentSave` lưu nó vào `.tunelo-attachments/<ngày>/` trong thư mục của phiên (cùng kiểm thư mục nhạy cảm, đường dẫn và
`.git/info/exclude` như file của tin nhắn) và trả đường dẫn tuyệt đối để thiết bị gõ vào terminal cho AI đọc.

Có gì ở 2.7.0:

- **Thống kê sử dụng**: tunelo đọc transcript của Claude Code trên máy thành sổ số liệu theo tháng (chỉ số đếm rời transcript,
  khử trùng toàn máy, ghi lại phiên nào do app mở). Thiết bị đọc báo cáo qua kênh mã hoá; luật (context dài, nhiều lượt, việc
  máy móc trên model mạnh nhất, phiên nặng subagent) gửi tối đa một thông báo mỗi luật mỗi phiên. Màn "Sử dụng" trên web xem và
  xoá sổ.
- **Cấu hình dự án theo thư mục**: mỗi thư mục có một mức bật/tắt cấu hình `.claude` (skill, lệnh, hook, quyền) cho phiên chat,
  mặc định tắt, ghi vào nhật ký đồng ý; phiên terminal chạy CLI với nguồn cài đặt của chính nó.
- **Trình duyệt file và source control** cho thư mục làm việc, giới hạn trong thư mục, lọc file bí mật, chặn cấu hình git nguy
  hiểm.
- Terminal: menu phiên hiện thư mục của phiên; thư mục đã mất thì không còn báo phiên đang chạy.
- Nâng `ws`, `zod`, `fast-uri` (vá lỗi phân tích URI).

Có gì ở 2.6.1: chỉ tăng số phiên bản; bản phát hành giờ kiểm danh tính chữ ký macOS trước khi ra, để quyền Toàn quyền truy cập ổ đĩa giữ nguyên qua các lần cập nhật (dùng làm bản thử xác nhận điều đó).

Có gì ở 2.6.0:

- **Dự án báo git remote và nhánh**: mỗi dự án gửi kèm `remote.origin.url` (bỏ mật khẩu; với http(s) bỏ cả tên người dùng, nơi
  token hay nằm) và nhánh đang checkout, để Chat nhận ra cùng một repo trên nhiều máy. Đọc bằng `git config`/`git` chỉ đọc, không
  chạy chương trình nào của repo.
- **Terminal theo phiên**: một phiên AI mở được ngay trong terminal của máy (CLI của chính phiên đó); thiết bị chỉ nêu phiên, còn
  chạy gì do tunelo chọn. Hai thiết bị mở cùng lúc dùng chung một terminal; thoát CLI thì chat gõ tiếp được.
- **Đường dẫn cho quyền Full Disk Access**: khi còn thiếu quyền, máy gửi kèm đường dẫn tệp chạy của tunelo
  (`MachineInfo.agent_binary`) để banner trên web chỉ đúng tệp cần kéo vào danh sách.

Script cài thấy gói npm `tunelo` 1.x thì nhắc `npm uninstall -g tunelo` (không tự gỡ).

## AI hỗ trợ và tài khoản AI

AI Agent không có AI mặc định: mỗi phiên, dự án và yêu cầu liệt kê phiên phải nêu AI (`provider`), thiếu thì máy từ chối
(`ERROR_REASON_PROVIDER_REQUIRED`). Mỗi AI là một adapter trong [`src/providers/`](src/providers/) theo hợp đồng
[`types.ts`](src/providers/types.ts) (`AgentProvider`, `AccountsFacet`); lõi và web chỉ đọc capability, không rẽ nhánh theo id.
Bộ test hợp đồng ([`test/provider-contract.test.ts`](test/provider-contract.test.ts)) chạy cho mọi adapter.

- **Claude Code**: `claude` của máy qua Agent SDK. Nhiều tài khoản: mỗi tài khoản một thư mục `CLAUDE_CONFIG_DIR` ở
  `ai-accounts/claude/<id>/home`, đăng nhập từ thiết bị bằng cách dán mã.
- **Antigravity**: `agy` của máy (1.5.2 trở lên) qua `agy acp` ([client ACP dùng chung](src/providers/acp/)). Một tiến trình
  `agy acp` phục vụ mọi phiên; chế độ quyền và model lấy từ agy. Cài đặt `toolPermission: "always-proceed"` của agy
  (`~/.gemini/antigravity-cli/settings.json`) chạy mọi công cụ không hỏi, nên phiên của máy đó là toàn quyền (`full-access`) và
  thiết bị không chọn chế độ khác được; muốn được hỏi thì đổi cài đặt đó trong agy. tunelo chỉ đọc cài đặt của agy, không ghi.
  "Luôn cho phép" chỉ nhớ trong phiên ở phía tunelo, agy không nhận "always". Phiên Antigravity có MCP `tunelo` (công cụ tên
  `mcp_tunelo_<tool>`): lệnh ghi luôn hiện thẻ duyệt, không "cho phép cả phiên"; phiên toàn quyền chạy lệnh ghi như bypass của
  Claude. Ở chế độ `auto`/`accept-edits` agy có thể gọi công cụ MCP không hỏi, khi đó lệnh ghi bị dịch vụ từ chối vì chưa duyệt.
  Mật khẩu đã lưu trong lệnh shell của agy chưa có. Thông điệp commit chạy `agy --sandbox` với mọi công cụ bị chặn; hook toàn cục của công cụ khác trong
  `~/.gemini/config/hooks.json` vẫn chạy (agy không tắt được cho một lần chạy). tunelo không cài hook nào vào agy.
  Xoá một phiên Antigravity đưa `brain/<id>` và `conversations/<id>.db` của hội thoại đó (trong `~/.gemini/antigravity-cli`) vào
  Thùng rác của máy, như phiên Claude; thiếu hai đường dẫn này agy không còn liệt kê hội thoại.
- **Tài khoản AI** (trang "Tài khoản AI" của máy): mỗi AI một danh sách và một lựa chọn riêng; đổi tài khoản của AI này không
  đụng phiên AI khác. Tất cả ghi trong `ai-accounts/ai-accounts.json` (không chứa credential).
  - Antigravity lưu đăng nhập trong Keychain chung của người dùng (`gemini`/`antigravity`), nên đổi tài khoản là ghi đăng nhập
    đã lưu vào đó qua `security -i` (giá trị dạng hex, không đi qua dòng lệnh), đọc lại để kiểm, sai thì đặt lại bản cũ. Bản lưu
    nằm ở `ai-accounts/antigravity/vault.json` (0600, mỗi đăng nhập được bọc bằng khoá của tunelo). Thêm tài khoản: đăng nhập
    bằng `agy` trên máy rồi bấm "Lưu tài khoản đang đăng nhập". Đổi bị từ chối khi đang có lượt Antigravity chạy hoặc `agy`
    mở trong terminal (agy tự ghi lại token khi làm mới); phiên rảnh của tunelo tự mở lại trên tài khoản mới. Chỉ macOS.

## Phiên Claude Code hai chiều giữa Chat và máy

Phiên AI Agent là phiên Claude Code bình thường của máy, không phải bản sao:

- **Mở trong Chat, làm tiếp trên máy.** tunelo chạy `claude` của máy qua Agent SDK, ở đúng thư mục đã chọn và với thư mục
  Claude của máy (profile mặc định không đổi `CLAUDE_CONFIG_DIR`; profile khác dùng chung `projects/` qua link). Bản ghi nằm ở
  `~/.claude/projects/<thư mục mã hoá>/<session id>.jsonl` (`entrypoint: sdk-ts`), nên trên máy chỉ cần `cd` vào thư mục đó và
  chạy `claude --resume` (hoặc `claude --resume <session id>`).
- **Mở trên máy, làm tiếp trong Chat.** Hộp thoại Phiên mới › tab "Phiên có sẵn trên máy" liệt kê các phiên trong
  `projects/` của thư mục Claude của máy và của mọi profile (Terminal, IDE, Claude Desktop, Chat), nhóm theo thư mục,
  có tìm kiếm và phân trang. Mở một phiên: lịch sử (tin người dùng, trả lời, tool, diff) hiện ngay; tin nhắn đầu tiên resume
  đúng session id trong thư mục của nó. Thư mục nhạy cảm và cấu hình `.claude` của dự án hỏi đồng ý như phiên mới (thư mục đã
  bật cấu hình dự án thì không hỏi, xem dưới).
- **Lượt gõ trên máy sau đó** (`claude --resume` trong Terminal) hiện trong Chat khi mở lại phiên hoặc gửi tin tiếp; phiên đang
  mở trong tunelo được mở lại để Claude đọc cả phần đó.
- **Mở hai nơi cùng lúc:** phiên "có vẻ đang mở ở nơi khác" khi bản ghi vừa đổi trong 60 giây (lâu hơn thế, khi một `claude`
  đang giữ phiên mà tool chưa có kết quả, tối đa 10 phút, hoặc model chưa trả lời yêu cầu cuối cùng, tối đa 30 phút: lúc model
  nghĩ lâu bản ghi không đổi; cột AI Agent hiện biểu tượng "đang chạy" theo từng AI), khi một `claude` đang chạy ghi
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
đầu từ một tin người dùng. Nội dung bản ghi chỉ đi tới thiết bị của tài khoản qua kênh mã hoá đầu cuối; tunelo không đọc token Claude.

Phiên đang xem trên một thiết bị theo sát lượt gõ ở terminal (tunelo 2.2.1 trở lên): máy đọc lại nhật ký mỗi 1,5 giây và gửi phần mới, thay vì chỉ
khi mở phiên hay gửi tin. Máy chạy bản cũ chỉ thấy lượt mới khi mở lại phiên: chạy `tunelo update`.

## Đăng nhập khi điều khiển từ xa: bí mật (2.0.8)

Trong phiên tunelo mở, Claude xin mật khẩu/token bằng tool MCP `request_secret(name, purpose, origin)`. Claude chỉ nhận **tham
chiếu** (`secret://…`), không bao giờ nhận giá trị.

- Máy đã lưu bí mật cho đúng (origin, name): trả tham chiếu ngay. Chưa có: mọi thiết bị đang kết nối hiện thẻ "Claude cần thông tin
  đăng nhập" phía trên ô nhập, **ngoài transcript** (không vào lịch sử phiên, không vào journal), phiên hiện "Cần bạn" và có thể
  đẩy thông báo. Người dùng nhập ở một thiết bị; giá trị đi một khung E2E tới máy, trình duyệt xoá khỏi ô nhập ngay khi gửi. Chờ tối
  đa 5 phút; từ chối/hết hạn/phiên dừng thì Claude nhận lỗi nói rõ.
- "Lưu cho lần sau" (mặc định bật): niêm phong bằng khoá trong Keychain/DPAPI (Linux: tệp 0600, xem mục Linux), cùng origin và tên (chuyển sang trang khác thì không
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
- Trang cài đặt máy có "Bí mật đã lưu" (trang, tên, lần dùng cuối, nút xoá). Nhật ký đồng ý ghi
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
- Nút "Xoá hồ sơ trình duyệt" trên trang máy xoá hồ sơ (đăng xuất mọi trang).

## Màn hình của máy qua Chia sẻ màn hình của macOS (2.0.13)

Chỉ có trên macOS. Cho các hộp thoại của hệ điều hành mà trình duyệt không thấy (sheet passkey, hộp mật khẩu Keychain).

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
- Trang máy có nút "Xoá hồ sơ trình duyệt" (có xác nhận, ghi `browser_clear`).
- `request_takeover(…, os_dialog: true)`: Claude báo hộp thoại hệ điều hành đang chờ; thẻ trên web đưa "Điều khiển toàn màn hình"
  lên đầu.

## Bảng phải của workspace: Explorer và Source Control (2.7.0)

Thiết bị xem tệp và git của một workspace (một dự án của máy) qua kênh mã hoá đầu cuối: các yêu cầu `Ws*` trong
[`remote.proto`](../../proto/remote/v1/remote.proto) (mục "a workspace's files and git"), mã ở `src/workspace/`.

- **Chỉ theo mã dự án**: thiết bị gửi `workspace_id` (id dự án của máy), không bao giờ gửi đường dẫn tuyệt đối. Đường dẫn
  tương đối được giải `realpath` rồi phải nằm trong thư mục thật của dự án: `..`, đường dẫn tuyệt đối, symlink ra ngoài, vòng
  symlink, tên giả dạng `..` (ký tự Unicode trông giống) đều bị từ chối hoặc không ra khỏi thư mục. Symlink ra ngoài vẫn hiện
  nhưng không mở được; thiết bị, socket, pipe không hiện, không đọc.
- **Tệp bí mật** (dotenv trừ mẫu `.env.example`…, khoá `*.pem`/`*.key`/`id_*`, `.npmrc`, `.netrc`, `credentials`, nội bộ `.git`,
  `.ssh`, `.aws`, `*.tfstate`, `.vault-token`…; so tên sau khi bỏ ký tự vô hình và không phân biệt hoa thường) không liệt kê,
  không đọc, không tìm, kể cả khi bật "hiện tệp ẩn"; trong Source Control vẫn hiện tên nhưng không có diff (kể cả khi là tên cũ
  của tệp đổi tên). Thư mục nhạy cảm của máy (`~/.ssh`, cấu hình tunelo…) cũng bị chặn trong mọi lệnh đọc, và tệp có nhiều hơn
  một hard link không được xem. Stage hoặc commit tệp bí mật cần thiết bị nêu đúng tên tệp đó (`confirm_sensitive`).
- **Chỉ ở thư mục gốc của repo**: git chỉ chạy khi workspace là thư mục gốc của repo (`ERROR_REASON_WORKSPACE_NOT_REPOSITORY_ROOT`
  nếu là thư mục con của repo lớn hơn; Explorer vẫn xem được, không có dấu git); repo đặt `core.worktree` bị từ chối.
- **Explorer (chỉ đọc)**: trang thư mục tối đa 2000 mục (mặc định 500), con trỏ theo tên, thư mục trước rồi tên tự nhiên; thư
  mục quá 100 000 mục thì từ chối. Cờ gitignore lấy bằng `git check-ignore` cho đúng các mục đang trả; dấu U/A/M từ
  `git status`. Xem tệp: văn bản ≤ 1 MiB, ảnh ≤ 5 MiB (SVG coi là văn bản), còn lại chỉ kích thước. Tìm tên: `git ls-files`
  (ngoài git thì đi cây tối đa 100 000 mục, bỏ `node_modules`), mọi từ phải khớp, tối đa 500. Tìm nội dung: `git grep`
  (không cần ripgrep), tối đa 2000 kết quả, 15 giây, bỏ tệp nhị phân và tệp > 5 MiB.
- **Theo dõi thay đổi** chỉ khi có thiết bị đang xem (`WsWatch`): `fs.watch` đệ quy, gom 125 ms (tối đa 1 giây), bỏ
  `node_modules`, `dist`, `build`…; đọc lại `git status` sau thay đổi, cách nhau ít nhất 3 giây, và 60 giây một lần dù không
  có sự kiện; chỉ báo `git` khi trạng thái thật sự khác. Trên Linux (watch đệ quy sẽ giữ watch cho mọi thư mục, kể cả
  `node_modules`) hoặc khi hệ điều hành từ chối, tunelo chuyển hẳn sang đọc `git status` mỗi 10 giây và báo `polling` cho thiết bị.
- **Source Control**: status (porcelain v2, tối đa 1000 mục, số dòng +/−), stage/unstage, huỷ thay đổi (thiết bị phải gửi
  `confirm`; tệp chưa theo dõi vào Thùng rác của hệ điều hành theo lô 100, không xoá hẳn; symlink thì chuyển chính link, không
  bao giờ chuyển thứ nó trỏ tới; mục bị đổi giữa lúc liệt kê và lúc chuyển thì không chuyển gì; chỉ khôi phục tệp đã theo dõi sau
  khi Thùng rác nhận hết), commit (**không chạy git hook**: `--no-verify` và `core.hooksPath` trỏ vào một thư mục rỗng tuyệt đối
  của tunelo; **không ký**: repo bật ký commit thì bị từ chối, `ERROR_REASON_GIT_COMMIT_SIGNING`; HEAD tách rời cần
  `allow_detached`), nhánh (danh sách, đổi, tạo), fetch, pull chỉ fast-forward, push không bao giờ force (nhánh chưa có upstream
  thì đẩy lên cùng tên ở origin và đặt upstream; repo dùng Git LFS thì chạy `git lfs pre-push` trước, máy thiếu git-lfs thì từ
  chối `ERROR_REASON_GIT_LFS_MISSING`). Commit, checkout và pull bị từ chối khi đang dở merge, rebase, cherry-pick, revert hay
  bisect (`ERROR_REASON_GIT_OPERATION_IN_PROGRESS`). Log phân trang, "committed on
  branch" so với `origin/HEAD` (rồi `origin/main`, `origin/master`, `main`, `master`), và URL trang tạo PR/MR của GitHub hoặc
  GitLab (chỉ https, không kèm thông tin đăng nhập).
- **AI viết thông điệp commit (3.1.0)**: thiết bị gửi `WsGitCommitMessage` kèm id của AI (`provider`), lấy từ AI của phiên.
  Không có AI mặc định: chỉ AI nào có `TextWriter` (khả năng `commit_message` trong `MachineInfo.providers`) mới viết được. Lúc
  này mới có Claude, chạy `claude -p` từ thư mục home, không công cụ, không nguồn cài đặt (không hook, không `.claude`, không
  CLAUDE.md của dự án), không MCP, không lệnh slash, không lưu phiên, bằng tài khoản đang chọn trên máy, model `haiku`, tối đa
  120 giây. AI chỉ đọc danh sách tệp đã stage và patch đã stage (tối đa 200 000 ký tự chia đều theo tệp); tệp bí mật chỉ có tên,
  không có nội dung. Không commit gì và không ghi nhật ký. Không có gì để đọc thì trả `ERROR_REASON_NOTHING_STAGED`.
- **git không bao giờ chạy chương trình do repo chọn và không bao giờ hỏi**: không shell, mọi lệnh có hết giờ và trần đầu ra,
  `GIT_TERMINAL_PROMPT=0`, askpass không trả gì, ssh `BatchMode`, chỉ https/ssh. Trước mỗi lệnh, tunelo đọc cấu hình **của
  chính repo** (phạm vi local/worktree; cấu hình global/system của người dùng vẫn dùng): `credential.helper`, `core.sshCommand`,
  `gpg.*.program`, `filter.*`, `diff.*.textconv`/`command`, `merge.*.driver`, `remote.*.uploadpack`… Lệnh đọc chạy với các
  chương trình đó bị tắt; lệnh ghi hoặc mạng bị từ chối, nêu tên khoá (`ERROR_REASON_GIT_UNSAFE_CONFIG`), để người dùng chạy
  trong terminal. Lệnh mạng còn bị từ chối khi repo tự đặt proxy, chứng chỉ, tắt `sslVerify`, `curloptResolve` hay
  `extraHeader`. Sau lệnh ghi/mạng, cấu hình được đọc lại: repo bị thêm khoá nguy hiểm trong lúc chạy thì báo lỗi. Thiếu đăng
  nhập khi fetch/pull/push trả `ERROR_REASON_GIT_NEEDS_CREDENTIALS` ngay, không treo. git chạy trong nhóm tiến trình riêng: hết
  giờ thì dừng cả git lẫn helper nó mở (remote helper, ssh), mạng chậm dưới 1000 byte/giây trong 30 giây thì dừng; khoá ghi của
  workspace luôn được trả, và nếu dừng cứng để lại `.git/index.lock` thì lỗi nói rõ. Lỗi gửi về thiết bị không bao giờ chứa
  đường dẫn tuyệt đối của máy.
- **Nhật ký đồng ý**: `git_stage`, `git_unstage`, `git_discard` (số tệp khôi phục và số tệp vào Thùng rác), `git_commit`,
  `git_checkout`, `git_branch_create`, `git_pull`, `git_push` ghi thư mục workspace, mã workspace và số tệp; không bao giờ ghi
  đường dẫn tệp, nội dung, tên nhánh hay thông điệp commit. Mỗi workspace chỉ một lệnh git ghi tại một thời điểm
  (`ERROR_REASON_GIT_BUSY`).

## Cấu hình `.claude` của dự án trong phiên chat

Phiên chat chỉ nạp cấu hình của người dùng (`settingSources: ['user']`) cho tới khi thư mục được bật cấu hình dự án. Bật một lần
cho một thư mục từ thiết bị (`ProjectConfigSet`, mức `FULL`): máy nhớ trong `<thư mục config tunelo>/data/project-config.json`
(0600), áp cho thư mục đó và mọi thư mục con (thư mục gần nhất được đặt thắng), cho phiên mới, phiên mở lại (resume) và phiên mở
từ "Phiên có sẵn trên máy", không cần tick từng phiên. `FULL` nạp cả settings, hook, luật quyền, skill, lệnh và `CLAUDE.md` của
dự án, như một thư mục đã tin trong terminal. Phiên rảnh đang mở ở đó đóng lại và mở tiếp (cùng hội thoại) ở tin nhắn sau; phiên
đang chạy giữ mức cũ tới lúc đó. `ThreadSummary.project_config` cho thiết bị biết phiên đang chạy với mức nào (để hiện "chưa nạp
skill của dự án" và nút bật). Nhật ký đồng ý ghi `project_settings` với thiết bị, thư mục và `level:full`/`level:off`. Thư mục
nhạy cảm chỉ bật được trên máy (`tunelo trust`). Tick "Nạp cấu hình .claude" từng phiên (`Consent.project_settings`) vẫn chạy
cho thiết bị cũ ở thư mục chưa đặt mức; thư mục đã tắt (`OFF`) thì tắt cả phiên mở bằng tick đó, từ lượt kế tiếp của phiên.

Không có mức "chỉ skill và lệnh": Claude Code nạp cấu hình dự án nguyên khối, và skill của dự án tự mang hook và `allowed-tools`
trong front matter, có hiệu lực khi skill chạy kể cả khi chỉ nạp riêng skill (thử với `claude` thật:
`TUNELO_REAL_CLAUDE=1 pnpm exec vitest run test/project-config-real-claude.test.ts`).

Terminal của phiên (mở phiên trong terminal) chạy `claude` với nguồn cài đặt mặc định của CLI (người dùng, dự án, local; không
`--setting-sources`): skill và lệnh của dự án hiện như ở mọi terminal, sau hộp thoại tin thư mục của chính CLI.

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
  Windows dùng Recycle Bin, Linux `gio trash` (máy thiếu `gio` thì báo lỗi rõ); Thùng rác từ chối thì không xoá gì. Phiên đang chạy một lượt: web hỏi "Dừng và
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

- Script cài và `tunelo login` mở sẵn trang đó và một cửa sổ Finder chọn sẵn tunelo. `tunelo status` và log của dịch vụ in các
  bước khi còn thiếu (không mở gì, nên cũng không nói là đã mở).
- Dịch vụ dò quyền mà không gây hộp thoại, báo cho thiết bị (`MachineInfo.needs_full_disk_access`; web hiện banner có nút mở lại
  trang cài đặt trên máy). Khi còn thiếu, nó kiểm lại vài giây một lần và báo ngay khi được cấp, không cần khởi động lại.
- Nhờ chữ ký Developer ID, quyền đã cấp giữ qua các lần `tunelo update`. Bản 2.0.2 trở về trước ký ad-hoc nên phải cấp lại một lần
  sau khi lên 2.0.3.

## Linux: dịch vụ systemd của người dùng (2.2.0)

Cần Linux dùng glibc (Ubuntu, Debian, Fedora…; Alpine/musl chưa hỗ trợ) chạy systemd, có `systemctl`. Tiến trình terminal `tunelo-term-host` build trên Ubuntu 22.04 nên cần glibc 2.35 trở lên (Ubuntu 22.04+, Debian 12+, Fedora gần đây); máy cũ hơn vẫn chạy agent nhưng không có terminal (quyết định 11/11/2026, Jev 0,93). Mã:
[`src/systemd-service.ts`](src/systemd-service.ts).

- Bản chạy nền là **user unit** `~/.config/systemd/user/tunelo.service` (chạy `tunelo run`, `Restart=always`, `RestartSec=10`,
  luôn đặt `TUNELO_HOME`, PATH là `%h/.local/bin:/usr/local/bin:/usr/bin:/bin` cộng các thư mục PATH lúc cài, log ghi tiếp vào
  `agent.log`). Không cần root, tunelo không bao giờ tự gọi `sudo`. `tunelo update` thay file chạy rồi để `Restart=always` chạy lại.
- `tunelo login` kiểm máy chạy được dịch vụ **trước khi** đăng nhập. Không có systemd (container, WSL không bật systemd) hoặc
  không tới được phiên systemd của người dùng (shell SSH/`su`/`sudo` thiếu `XDG_RUNTIME_DIR`) thì báo kèm cách xử lý, rồi chỉ đăng
  nhập cho tunnel (máy không vào AI Agent).
- User unit chỉ chạy khi người dùng đang đăng nhập, trừ khi bật **linger**. tunelo thử `loginctl enable-linger` không cần mật khẩu;
  không được thì vẫn cài và chạy, rồi in lệnh để chủ máy chạy một lần: `sudo loginctl enable-linger <user>`.
- `tunelo stop` / `start` (lệnh ẩn) / `uninstall` dừng, bật, gỡ unit thật (máy chưa cài thì `stop`/`start` báo lỗi rõ).
- Kiểm: `tunelo status`, `systemctl --user status tunelo`, `journalctl --user -u tunelo` (sự kiện của systemd), log của tunelo ở
  `agent.log` (`tunelo logs -f`).
- `claude` phải cài cho **chính người dùng chạy tunelo** (thường ở `~/.local/bin`, đã có trong PATH của unit). `claude` cài riêng cho
  root (link `/usr/local/bin/claude` trỏ vào `/root/.local`) thì người dùng khác không chạy được, tunelo không thấy provider.
- Kho khoá: Linux không có Keychain/DPAPI, nên khoá máy và khoá niêm phong là tệp 0600 trong thư mục cấu hình (không dùng
  libsecret/secret-service). Giới hạn: ai đọc được thư mục cấu hình là đọc được khoá máy, mở được token và bí mật đã lưu.
- Khác macOS: không có Chia sẻ màn hình của máy, không có Full Disk Access (trạng thái dịch vụ ghi `fullDiskAccess: not-applicable`).
  Trình duyệt của máy tìm Chrome/Chromium như hệ khác. Thùng rác dùng `gio trash`. Cổng đang nghe (cho chuyển tiếp `localhost` của
  Localman) đọc bằng `lsof`, máy thiếu `lsof` thì dùng `ss -Hltnp`.

## Gỡ

- Chỉ gỡ máy khỏi tài khoản: `tunelo logout` (hoặc xoá máy ở trang Quản lý máy trong Chat). Máy biến khỏi AI Agent, grant
  `tunelo-agent` của máy ở IdP bị thu hồi; `tunelo login` lại (chủ bấm Đồng ý) là quay về, giữ mục máy cũ.
- Gỡ hẳn: `tunelo uninstall` ([`src/commands/uninstall.ts`](src/commands/uninstall.ts)). Nó chạy `logout` (mất mạng thì cảnh báo và
  đi tiếp; khi đó xoá máy trên web), rồi xoá:
  - dịch vụ nền và tiến trình terminal cùng unit của chúng: macOS LaunchAgent `com.hoandat.tunelo` và
    `com.hoandat.tunelo.term-host` (trong `~/Library/LaunchAgents/`); Linux user unit `~/.config/systemd/user/tunelo.service` và `tunelo-term-host.service`;
    Windows giá trị `tunelo` và `tunelo-term-host` dưới `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` và các tệp `run-agent.*`;
  - mục Keychain `com.hoandat.tunelo` (`machine-key`, `session-key`) trên macOS; trên Windows (DPAPI) và Linux khoá là tệp trong thư
    mục cấu hình;
  - thư mục cấu hình đang dùng (`~/.config/tunelo`, hoặc `$XDG_CONFIG_HOME/tunelo`, hoặc `TUNELO_HOME`); trên macOS thêm
    `~/Library/Application Support/tunelo` nếu có;
  - macOS, Linux: `~/.local/bin/tunelo`, `~/.local/bin/tunelo-term-host` và các bản `*.old*` cạnh chúng; dòng
    `export PATH="$HOME/.local/bin:$PATH"` trong `.zprofile`, `.bash_profile`, `.profile`, `.bashrc`, `.zshrc` chỉ khi
    `~/.local/bin` đã trống (thư mục dùng chung với công cụ khác);
  - Windows: bỏ `%LOCALAPPDATA%\tunelo` khỏi PATH của người dùng, rồi một tiến trình tách rời xoá `%APPDATA%\tunelo` và
    `%LOCALAPPDATA%\tunelo` vài giây sau khi `tunelo` thoát (Windows không xoá được tệp đang chạy).

Tài khoản AI nằm trong thư mục cấu hình (`ai-accounts/`, và `claude-profiles/` của bản trước 3.3), nên `uninstall` xoá luôn
chúng mà không đăng xuất từng tài khoản; xoá tài khoản Claude trên trang "Tài khoản AI" trước để claude thu hồi phiên đăng nhập
của nó. `~/.claude`, `~/.gemini` và mục Keychain của agy không bị đụng (agy giữ đăng nhập đang dùng lúc gỡ).

### Lên bản có tài khoản AI theo từng AI

Bản này không đọc dữ liệu của bản cũ và không chạy với web bản cũ. Trên máy đang có tunelo cũ: chạy `tunelo uninstall` của bản
cũ, chạy lại lệnh cài ở mục [Cài](#cài), `tunelo login`, rồi đăng nhập lại các tài khoản Claude trên trang "Tài khoản AI".

## Phát triển

```sh
pnpm --filter @achoo254/tunelo-agent test        # vitest, tối đa 2 worker
pnpm --filter @achoo254/tunelo-agent typecheck
bun build --compile --target=bun-darwin-arm64 apps/agent/src/cli.ts --outfile dist/tunelo
```

Thử tay luôn đặt cả `HOME` và `TUNELO_HOME` tạm (thêm `TUNELO_KEYSTORE=file` để không đụng Keychain/DPAPI thật). Chỉ `TUNELO_HOME`
thôi thì tunelo vẫn đọc và chuyển phiên của CLI 1.x ở `~/.tunelo` thật.

Test cần Bun (`test/tunnels/forward-under-bun.test.ts`, `test/stream-holders.test.ts`) chạy khi có `bun` trên PATH hoặc
`TUNELO_TEST_BUN`; CI dùng đúng Bun của bản phát hành (`.github/actions/setup-bun`). Job `typescript` chạy toàn bộ test agent trên Linux, gồm
`test/systemd-service.test.ts` (dịch vụ systemd qua host giả, không chạm systemd thật). Phần chỉ có trên hệ thật (DPAPI, junction,
`netstat`/`lsof`) ở `test/os-integration.test.ts`, CI chạy trên `windows-latest`.

Phát hành: xem đầu [`agent-release.yml`](../../.github/workflows/agent-release.yml) và
[`scripts/pin-release.ts`](scripts/pin-release.ts).
