# ADR 0014: Tunelo — một tiến trình máy cho Chat, Localman và tunnel

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-09
- Bổ sung cho [ADR 0013](./0013-remote-machines.md). Thay phần mã cài của ADR đó: máy giờ đăng ký theo tài khoản.

## Bối cảnh

Trên máy người dùng từng có hai chương trình: tiến trình nền của Máy của tôi (repo này) và CLI Tunelo 1.x (gói npm của
localman-next: tunnel, inspector, portal, MCP). Mỗi cái đăng nhập riêng. Thêm máy vào Chat cần mã cài, Localman không gọi được
`localhost` của máy, và claude chỉ dùng được một tài khoản mỗi máy.

## Quyết định

### Một tiến trình, tên Tunelo

- Tiến trình nền của Máy của tôi là `tunelo` 2.0.0 (`apps/agent`). Nó nhận toàn bộ CLI Tunelo 1.11: `http`, `tcp`, `kill`, `watch`, `link`/`links`,
  `mcp`, `config`, `login`/`logout`/`whoami`. Bun single-file, ký minisign, phát hành qua GitHub Releases (không npm).
- Không còn portal web: `tunelo http` chỉ giữ inspector request trên `127.0.0.1` và `tunelo watch`. Phía web của Tunelo chỉ còn trang
  giới thiệu trên tunelo-server (localman-next).
- Gói npm `tunelo` có bản 1.12 cuối: `tunelo update` của nó chạy script cài 2.x rồi gọi thẳng binary mới.
- `@tunelo/client`, `@tunelo/shared` là thư viện ở localman-next, cài qua git tag. tunelo-server ở lại localman-next.

### Một lần đăng nhập

- `tunelo login` dùng device flow của client `tunelo-agent` trên auth-next. Grant có ba tài nguyên: tunnel, Chat
  (`https://chat.<miền>/mcp`), Localman. Mọi request tới token endpoint, kể cả lúc poll, mang `resource`.
- Chỉ một refresh token, niêm phong bằng khoá trong Keychain (macOS), DPAPI (Windows) hoặc tệp 0600 trong thư mục cấu hình
  (Linux, nên chỉ quyền thư mục bảo vệ nó; ADR 0013) (`keystore.ts`). Chỉ dịch vụ làm mới
  token, dưới khoá file, và đọc lại sau khi giữ khoá. Access token ngắn hạn, theo từng tài nguyên.
- Không route nào (socket điều khiển, HTTP cục bộ, MCP) trả token thô. Dịch vụ tự gắn Bearer.
- `tunelo whoami` hiện trạng thái từng app. Lỗi của Chat hay Localman chỉ đổi dòng của app đó, không làm hỏng tunnel.

### Máy theo tài khoản

- Không còn mã cài. `tunelo install` đăng nhập trước, rồi gọi `RegisterMachine` với access token của chủ (`aud` là MCP của Chat,
  scope `machines:write`). Config chỉ đổi sau khi đăng nhập thành công.
- `machines.claimed_at` là lúc máy được gắn với tài khoản (migration `0035_machine_claimed_at.sql`). Chủ máy được tìm qua
  `machines.user_id` → `users.idp_sub`, không lưu bản sao. Máy cài bằng mã trước đây được dịch vụ gắn bằng `ClaimMachine` khi máy đã đăng nhập.
- Máy đã claim chỉ được liệt kê với tunnel máy mà Tunelo giữ cho đúng tài khoản đó. Heartbeat từ tunnel của tài khoản khác bị ghi là
  sống nhưng không có tunnel, kèm `tunnel_refused`.
- Tài khoản chưa từng mở Chat: `RegisterMachine` tạo người dùng tạm với `profile_pending` (tên giữ chỗ, không tìm được theo username
  hay tìm kiếm), theo hạn mức đăng ký web. Lần đăng nhập web đầu tiên điền hồ sơ từ IdP và xoá cờ.
- Tối đa 20 máy chưa thu hồi mỗi tài khoản, cùng hạn mức với máy Localman.
- Ghép thiết bị vẫn đầu-cuối như ADR 0013: trình duyệt cài máy được tin qua bí mật đi qua stdin của `tunelo install`, thiết bị khác ghép bằng mã Authenticator; server không bảo lãnh thiết bị và không giữ bí mật ghép nào.
- Máy tự liên kết với Localman sau `tunelo login` (`POST /api/links/self`). Token liên kết giao cho Localman, tunelo không lưu.

### Profile Claude

- Mỗi profile là một thư mục `claude-profiles/<id>/home` trong thư mục cấu hình, truyền cho claude bằng `CLAUDE_CONFIG_DIR`. Mặc
  định là `~/.claude` của máy.
- Profile được chọn là profile của cả máy: mọi phiên chuyển theo. Lý do: người dùng đổi profile vì hết hạn mức hoặc muốn để dành
  tài khoản cũ, nên đổi từng phiên là thừa (cách của Orca).
  - Phiên đã tạm tắt: lần mở sau dùng profile mới.
  - Phiên đang mở và rảnh: đóng tiến trình claude rồi mở lại ngay bằng resume cùng session id dưới profile mới. Model, effort, chế độ
    quyền, thư mục giữ nguyên; MCP của tunelo nhận vé mới.
  - Quyền "cho phép cả phiên" do tunelo nhớ theo phiên (luật allow, cú pháp của claude, trong `meta.json` của thread), không phụ
    thuộc tiến trình claude. Mỗi lần phiên mở lại (đổi profile, tự tạm tắt, khởi động lại dịch vụ) tunelo trao lại qua
    `allowedTools`. Chỉ luật allow, không bao giờ đổi chế độ quyền hay thêm thư mục. Không bao giờ nhớ tool ghi của MCP tunelo
    hay luật cho cả server MCP tunelo, và thao tác nhạy cảm không được "cả phiên" từ đầu. Chuyển sang AI khác thì xoá.
  - Phiên đang chạy giữa lượt (kể cả đang chờ duyệt quyền): không bị ngắt, chuyển khi lượt kết thúc. `ThreadInfo` báo
    `profile_switch_pending` kèm tài khoản sẽ chuyển sang.
  - Resume chạy được dưới profile khác vì `projects/` (nơi claude lưu hội thoại) là thư mục dùng chung.
- Mỗi lần đổi profile máy, mỗi phiên chuyển xong, mỗi lần đọc lại hạn mức, máy gửi `MachineProfile` (danh sách profile, profile
  máy, profile từng phiên) tới mọi thiết bị đang kết nối, không cần thiết bị hỏi. Đổi từ thiết bị nào hay từ
  `tunelo claude profiles select` trên máy đều như nhau. Hạn mức profile mới được đọc lại ngay (tối đa 1 lần/30 giây mỗi profile).
- Phiên hết hạn mức (claude báo `rate_limit`) mà máy có profile khác đã đăng nhập và còn hạn mức: `ThreadInfo.profile_suggestion`
  gợi ý profile còn nhiều nhất (phần trăm còn lại theo cửa sổ chặt hơn). Chỉ là gợi ý; máy không tự đổi.
- Profile dùng chung dữ liệu với `~/.claude` (`projects`, `todos`, `plans`, … liên kết bằng symlink hoặc junction). Chỉ đăng nhập
  là riêng. `settings.json` và `keybindings.json` được chép lại mỗi lần mở phiên, vì claude ghi file bằng cách đổi tên nên link bị cắt.
- Tài khoản lấy từ `claude auth status --json`. tunelo không đọc token Claude. Trùng email + tổ chức với profile có sẵn thì bị từ chối.
- Hạn mức 5 giờ và tuần lấy từ claude, kèm giờ cập nhật. Profile hết đăng nhập hiện "Cần đăng nhập lại" và không chọn được.
- Xoá profile: đăng xuất trước, xoá link như link, không bao giờ đụng file trong `~/.claude`. Đăng xuất lỗi thì từ chối xoá; chỉ
  `tunelo claude profiles remove <id> --force` trên máy xoá cưỡng bức.
- `profiles.json` hỏng thì được giữ nguyên, chép một bản `.corrupt-<ts>`, mọi thao tác báo lỗi rõ.

### Đăng nhập Claude từ xa

- Thiết bị bắt đầu đăng nhập qua kênh E2E. Máy chạy `claude auth login --claudeai` không TTY, với `BROWSER` là lệnh không làm gì,
  rồi gửi URL đăng nhập về thiết bị. Người dùng mở URL, dán code, code đi qua E2E vào stdin của claude.
- Code không lưu, không log. Env của tiến trình đăng nhập bỏ `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_*`.
- Mỗi lúc chỉ một lần đăng nhập. Lần đăng nhập hết hạn sau 10 phút. Huỷ, hết hạn hay code sai đều dừng tiến trình claude.
- Đăng nhập không TTY hỏng: web hướng dẫn chạy `tunelo claude profiles add` ngay trên máy.

### MCP trong phiên claude

Chi tiết ở ADR 0013, mục "MCP của tunelo trong phiên claude". Tóm tắt:

- Phiên claude do tunelo mở có MCP `tunelo` với tool tunnel, Chat, Localman. claude không thấy token.
- Vé phiên (`TUNELO_MCP_TICKET`) chỉ là định danh, không phải bí mật. Tool ghi của phiên có vé chỉ chạy khi dịch vụ tiêu được một
  lần cấp duyệt dùng một lần. Lần cấp đó sinh ra khi người dùng duyệt thẻ trên thiết bị. Ngoại lệ duy nhất: phiên ở
  `bypassPermissions`, chế độ chỉ có khi cấu hình claude của chính máy khởi động ở đó.
- Lời gọi không vé (claude chạy thẳng trên máy, tiến trình khác, Bash trong phiên) chỉ được đọc. Chủ máy bật tool ghi cho chúng
  bằng `tunelo config mcp-local-writes on`. Lệnh này chỉ chạy khi stdin và stdout là terminal và người dùng gõ `yes`. Bash của
  client AI hay script không có terminal nên bị từ chối. `off` luôn chạy được. Đây là một bước chặn model tự bật, không phải tường
  chắn mã của cùng user: mã đó vẫn tự ghi được file cờ, hoặc giả terminal bằng `script`.
- Rủi ro prompt injection: nội dung claude đọc từ Chat, Localman hay file dự án có thể dụ claude gửi tin hoặc gửi request tới
  `localhost`. Ở default, acceptEdits, plan và auto, thẻ duyệt và lần cấp chặn việc đó, nhưng người dùng phải đọc thẻ (người nhận,
  nội dung, URL). Ở `bypassPermissions` không có gì chặn. Người dùng chấp nhận rủi ro này khi tự đặt máy ở chế độ đó.

### Localman gọi localhost của máy

- Một tunnel máy mang cả kênh E2E lẫn đường `/.tunelo/forward`. Không có tunnel riêng thứ hai.
- tunelo-server chỉ cho token liên kết của chủ máy qua, bỏ mọi header `tunelo-*` client gửi, rồi gắn
  `tunelo-forward-granted: 1` và `tunelo-local-port`.
- Máy chỉ phục vụ đường forward khi đủ bốn điều kiện:
  - server báo tính năng `local-forward`;
  - Host là host của chính tunnel máy (chặn DNS rebinding);
  - `tunelo-forward-granted` đúng bằng `1`;
  - chuyển tiếp đang bật.
- Request đi tới `127.0.0.1:<port>`, rồi `[::1]:<port>` khi bên kia không trả lời, với Host `localhost:<port>`. Không tra DNS.
  `Location` chỉ được viết lại khi trỏ về chính app. Header `tunelo-*` bị bỏ ở cả hai chiều.
- Danh sách chặn (`forward-deny-ports.ts`):
  - danh sách chung (Docker, debug, cơ sở dữ liệu, trang quản trị);
  - mọi cổng của tunelo;
  - cổng IDE của Claude Code (máy và mọi profile);
  - cổng debug trên dòng lệnh và `NODE_OPTIONS` của tiến trình đang chạy;
  - cổng người dùng thêm bằng `tunelo config local-forward block <cổng…>`.
  Lần đọc tiến trình lỗi thì giữ lần đọc tốt gần nhất. Chưa đọc được lần nào thì chặn các cổng debug phổ biến.
- Giới hạn: thân request 50 MB (vượt thì 413 trước khi tới app), response 100 MB, mỗi lần chuyển tiếp 120 giây. Người gọi bỏ đi thì
  request tới app bị huỷ ngay.
- Bật mặc định sau `tunelo login`. Tắt bằng `tunelo config local-forward off` hoặc công tắc trên trang máy trong Chat (qua E2E).
  Mỗi lần đổi được ghi vào nhật ký đồng ý.
- Nhật ký: mỗi request một dòng trong `agent.log` (giờ, cổng, method, path không query, status). Không ghi header, thân hay query.
- Thứ tự deploy: tunelo-server có cửa kiểm `/.tunelo/forward` phải chạy trước khi tunelo nào bật chuyển tiếp.

### Cập nhật tunelo từ trang máy trong Chat

Từ 2.3.0, thiết bị đã ghép cập nhật được tunelo của máy ngay trên trang máy, không cần ngồi trước máy chạy `tunelo update`.

- Máy tự tìm bản `tunelo-v*` mới ngay khi chạy và mỗi 6 giờ, báo qua `MachineInfo.agent_update` (`supported`, `latest_version`, `updating`). Nút "Kiểm tra bản mới" gửi `AgentUpdateCheck`.
- `AgentUpdateStart` được trả `Ack` ngay; máy tải, kiểm chữ ký minisign với khoá nằm sẵn trong binary đang chạy (đúng đường của `tunelo update`), thay file rồi thoát cho trình giám sát khởi động bản mới. Từng bước gửi tới mọi thiết bị đang nối bằng `AgentUpdateProgress` (đang tải kèm phần trăm, kiểm tra chữ ký, cài, khởi động lại, lỗi kèm lý do). Kết nối rớt khi khởi động lại; thiết bị tự nối lại và thấy bản mới.
- Chỉ máy có thể tự thay file và có thứ khởi động lại nó mới cập nhật từ xa: file binary đã build, chạy dưới launchd (macOS), systemd (Linux) hoặc vòng lặp `run-agent.cmd` (Windows). Còn lại `supported=false` và trang chỉ chỉ cách chạy `tunelo update` trên máy.
- Mỗi lần bắt đầu cập nhật ghi một dòng `agent_update` (kèm phiên bản) vào nhật ký đồng ý. Phiên đang chạy trên máy có thể bị ngắt khi khởi động lại; trang hỏi lại trước khi cập nhật nếu máy đang mở phiên.
- Không đổi `MinAgentVersion`: field mới đều tuỳ chọn, máy cũ không gửi `agent_update` thì trang chỉ nhắc chạy `tunelo update` trên máy một lần để lên 2.3.0.

## Hệ quả

- Thư mục cấu hình tunelo chỉ có một refresh token hoandat, đã niêm phong. Ngoài `claude-profiles/*/home` (kho riêng của claude),
  không file nào của tunelo chứa token Claude, code đăng nhập hay JWT (`test/no-secret-leak.test.ts`).
- Dọn sau nghiệm thu và ít nhất 14 ngày: bỏ `CreateInstallCode` và bảng mã cài, nâng `MinAgentVersion` lên `2.0.0`.
- CI chạy test agent dưới Bun của bản phát hành và phần chỉ có trên Windows (DPAPI, junction, `netstat`) trên `windows-latest`.
  Job `typescript` chạy toàn bộ test agent trên Linux của CI, gồm test dịch vụ systemd bằng host giả; systemd thật được kiểm trên máy
  lab (ADR 0013, "Kiểm trên Linux").
