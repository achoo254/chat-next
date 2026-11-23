# Tiến trình phụ Zalo

Adapter Zalo của Chat Bridge nói chuyện với Zalo qua một tiến trình phụ Node, `server/internal/bridge/adapters/zalo/sidecar/`, chạy thư viện [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (MIT, không chính thức, mô phỏng Zalo Web). Tài liệu này nói cách thư viện được đưa vào và giữ an toàn. Adapter Go (`server/internal/bridge/adapters/zalo`, chỉ nhận, tắt mặc định) chạy nó; cách dùng ở [`chat-bridge.md`](./chat-bridge.md#zalo-chỉ-nhận-tắt-mặc-định).

## Vì sao không cài từ npm

Phiên đăng nhập Zalo của một tài khoản thật là thứ cần bảo vệ. Cây phụ thuộc production của `zca-js` có 31 gói; mỗi gói bị chiếm quyền là một đường lấy phiên. Nên:

- **Chỉ có một tệp chạy được:** `dist/zalo-sidecar.cjs` (khoảng 1,1 MB, 10 gói) được dựng bằng `esbuild` từ các gói ghim trong `pnpm-lock.yaml` và **commit vào repo**. Trên máy chủ không có `node_modules`, không `npm install`, không đường cập nhật tự động.
- **`form-data` bị thay bằng một lớp giả** (bản đầu không tải tệp lên), bỏ 17 gói.
- **Dựng lại phải ra đúng tệp đã commit:** CI (`zalo-sidecar`) cài lại bằng `--frozen-lockfile`, dựng, rồi `git diff --exit-code -- dist` và kiểm SHA-256. Băm hiện tại ở `dist/zalo-sidecar.cjs.sha256`. Giấy phép của các gói trong tệp ở `dist/THIRD_PARTY_NOTICES.txt`.
- **Ghim và kiểm băm:** `zca-js@2.3.0`, `esbuild@0.27.7` (cùng bản với `apps/agent`); mọi `integrity` trong lockfile đã đối chiếu với kho npm lúc vendor (21/11/2026).

## Cách nâng phiên bản

1. Đổi phiên bản ở `package.json`, chạy `pnpm install` rồi `pnpm build` trong thư mục `sidecar/`.
2. **Đọc diff của `dist/zalo-sidecar.cjs`** (và rà lại các điều kiện bên dưới) trước khi commit. Diff không có người đọc thì không lên.
3. Cập nhật băm trong tài liệu rà soát (kho kế hoạch riêng).

## Điều kiện an toàn (từ lần rà soát độc lập 21/11/2026)

Điểm vào `src/entry.mjs` đã làm các việc này; mọi thay đổi phải giữ chúng:

- `new Zalo({ logging: false, checkUpdate: false })`: log mặc định in tên và uid ra `stdout` (kênh giao thức) và kiểm tra bản mới gọi `registry.npmjs.org` mỗi lần đăng nhập.
- **Lệch có chủ ý so với rà soát:** `selfListen: true` (rà soát khuyên `false`). Không bật thì tin chính chủ gửi từ điện thoại không bao giờ tới Chat.
- Lỗi đăng nhập chỉ ra ngoài dưới dạng mã (`src/login-failure.mjs`), không bao giờ là thông báo của thư viện (có thể chứa phản hồi thô của máy chủ).
- Luôn truyền hàm nhận QR; không có thì thư viện ghi `qr.png` vào thư mục hiện tại.
- **Bộ chặn đi ra trong tiến trình** (`src/egress-guard.mjs`, có test): mọi kết nối đi qua `net.Socket#connect`, chỉ cho phép `*.zalo.me`; từ chối IP trần và ổ cắm unix (`ws+unix:`). Thư viện lấy địa chỉ websocket và host API từ phản hồi của máy chủ mà không kiểm tra, nên lớp này cần thiết. Tên miền cho phép được in một lần ra `stderr` (`host <tên>`); đó là nguồn danh sách cho tường lửa.
- `stdout` chỉ để giao thức (một dòng JSON mỗi sự kiện); `stderr` chỉ có `host ...` và `blocked ...`, không có nội dung tin, cookie, imei, tên hay id.
- Tiến trình không ghi tệp, không sinh tiến trình con, không đọc biến môi trường; đóng `stdin` là dừng. Mô-đun đầu tiên `src/ws-env.mjs` tự đặt `WS_NO_BUFFER_UTIL=1` và `WS_NO_UTF_8_VALIDATE=1` trước khi `ws` chạy, vì sudo xoá môi trường (có test chạy bản đóng gói với môi trường rỗng: không lần nào thử nạp `bufferutil` hay `utf-8-validate`).

## Môi trường cách ly

Adapter Go chạy đúng `<ZALO_SUDO_PATH> -n -u <ZALO_SANDBOX_USER> -- <ZALO_NODE_PATH> <bundle>`, không thêm đối số nào, trong thư mục của bundle (tiến trình phụ không ghi tệp), với môi trường viết tay (`PATH` thư mục hệ thống, `TZ=UTC`, không thừa kế biến nào của server; sudo còn xoá môi trường lần nữa), trong nhóm tiến trình riêng. `stdout` không bao giờ vào log; `stderr` chỉ vào `slog` dưới dạng tên host (`host`) hoặc chữ "blocked", dòng khác chỉ ghi là có dòng lạ, không kèm nội dung. Dòng `stdout` dài quá 1 MiB thì dừng tiến trình.

**Đổi user bằng sudo:** `chat-api` chạy dưới user `chat` không có quyền đổi uid, và cấp `CAP_SETUID` cho nó là cho nó thành root được. Nên một quy tắc sudoers cho `chat` chạy **đúng một lệnh** (`node` và bundle, không đối số khác) dưới user cách ly, không mật khẩu. Server **không** cần `CAP_SETUID`, `CAP_SETGID` hay `CAP_CHOWN`. Chỉ bản Linux làm được; hệ khác Zalo không được đăng ký.

**Dừng:** đóng `stdin` (tiến trình phụ thoát khi gặp EOF), chờ 3 giây, gửi `SIGTERM` cho tiến trình `sudo`, chờ 3 giây nữa rồi thôi chờ và ghi log lỗi. `chat` không gửi tín hiệu được cho tiến trình của user cách ly, nhưng gửi được cho `sudo` (uid thực là `chat`); sudo chuyển `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGQUIT` cho lệnh khi tín hiệu đến từ **ngoài** nhóm tiến trình của lệnh, nên tiến trình được tạo trong nhóm riêng. `SIGKILL` không chuyển được (chỉ giết sudo, bỏ mồ côi tiến trình phụ), nên không dùng. Rủi ro còn lại: một tiến trình phụ bỏ qua cả EOF lẫn `SIGTERM` sẽ chạy tiếp. Không có `Pdeathsig` (kernel xoá nó khi chạy sudo, tệp set-user-ID); server chết thì đầu ghi `stdin` đóng và tiến trình phụ thoát. Đã đo trên sudo 1.9.9 (WSL): chuyển `SIGTERM` khi gửi từ nhóm khác và **không** chuyển khi gửi từ cùng nhóm; sau `SIGKILL` cho sudo, tiến trình phụ chạy tới khi `stdin` đóng.

**Kiểm lúc khởi động** (một điều sai thì Zalo không được đăng ký, log lỗi «Zalo is not offered» kèm lý do):

- `ZALO_SANDBOX_USER` tồn tại, uid và gid khác 0, uid khác uid của server.
- `ZALO_NODE_PATH` là đường dẫn tuyệt đối tới một tệp thực thi.
- `ZALO_SUDO_PATH` là đường dẫn tuyệt đối tới tệp của root có bit set-user-ID, và `sudo -n -u <user> -l -- <node> <bundle>` thoát 0: lệnh `-l` kèm lệnh chỉ thoát 0 khi đúng dòng lệnh đó (cùng đối số, không thêm, không bớt) được phép dưới user đó mà không cần mật khẩu; thiếu đối số, thừa đối số, user khác hay lệnh khác đều thoát 1 (đo trên sudo 1.9.9). Không chạy gì.
- Bundle: đường dẫn tuyệt đối, tệp thường (liên kết bị từ chối), không cho nhóm hay mọi người ghi, không thuộc và không ghi được bởi user cách ly; mọi thư mục từ thư mục chứa nó lên `/` không thuộc và không ghi được bởi user đó (thư mục ai cũng ghi được bị từ chối, kể cả có sticky bit).
- SHA-256 của bundle bằng giá trị trong `zalo-sidecar.cjs.sha256` cạnh nó (hoặc `ZALO_SIDECAR_SHA256`).

Điều kiện còn lại của máy chủ (chưa làm; phải xong trước khi đặt `ZALO_SIDECAR_BUNDLE` ở production): tạo user cách ly; quy tắc sudoers một lệnh như trên; tường lửa `iptables` + `ipset` theo user, làm mới theo DNS bằng timer, giữ địa chỉ cũ và cảnh báo khi tra DNS lỗi; lần đăng nhập đầu ở chế độ chỉ ghi log để học danh sách tên miền rồi khoá.

## Phân loại lỗi đăng nhập

`zca-js` 2.3.0 ném cùng một lớp lỗi (`ZaloApiError`, tên `ZcaApiError`) cho phiên bị từ chối và cho sự cố phía Zalo, nên tiến trình phụ đọc lỗi và chỉ gửi mã (`src/login-failure.mjs`, có test gắn với chuỗi trong bundle):

| Mã | Khi nào |
|---|---|
| `session_rejected` | `getLoginInfo` trả 200 nhưng dữ liệu không giải mã ra đối tượng («Đăng nhập thất bại»), thông tin đăng nhập thiếu khoá («Khởi tạo ngữ cảnh thất bại.»), hoặc `getLoginInfo` trả 401/403 |
| `zalo_unavailable` | `getLoginInfo`/`getServerInfo` trả mã HTTP lỗi khác, `Missing signkey`, lỗi mã hoá tham số |
| `network_error` | DNS, TCP, TLS, hết giờ, bộ chặn đi ra |
| `bad_session` | phiên đưa vào thiếu trường |
| `login_failed` | mọi lỗi khác |

**Chưa quan sát** trên tài khoản thật phản hồi của Zalo khi phiên hết hạn thật; `session_rejected` là hình dạng dự đoán từ mã nguồn. Vì vậy engine chỉ coi phiên là đã hết khi `session_rejected` lặp lại trong ít nhất một giờ (xem [`chat-bridge.md`](./chat-bridge.md#zalo-chỉ-nhận-tắt-mặc-định)). Khi gặp phiên hết hạn thật, ghi lại mã nhận được và chỉnh bảng trên.

## Giao thức stdio (phiên bản 4)

Mỗi dòng là một JSON. Lệnh vào: `login_qr` (kèm `listen:false` để dừng ở `account` mà không mở kênh nghe; adapter luôn gửi như vậy), `login_session` (kèm `session`), `stop`. Sự kiện ra: `ready` (kèm `protocol`), `qr`, `qr_scanned`, `qr_expired`, `qr_declined`, `logged_in` (kèm phiên, engine giữ), `account` (id tài khoản Zalo, 1-20 chữ số; id khác thì lỗi `no_account`), `message`, `event`, `listener`, `error` (chỉ mã, xem bảng trên). Bản 4 thêm hai lệnh có `id` (mã do engine đặt, câu trả lời mang lại đúng mã đó): `send` (kèm `to`, `text`) trả `sent` (`msgId`, `ts`) hoặc `send_error` (`code`, `zaloCode` khi có); `history` (kèm `peer`) trả `history` (`count`, `oldestTs`, `messages`) hoặc `history_error` (`code`). Xem [Gửi tin](#gửi-tin). Chi tiết ở đầu `src/entry.mjs`. Chưa có lệnh liệt kê hội thoại hay đăng xuất.

Lịch sử: bản 2 (21/11/2026) thêm `account` vì đăng nhập QR phải báo engine tài khoản nào vừa vào; bản 3 (21/11/2026) thêm `listen:false` và mã lỗi đăng nhập, kiểm id tài khoản; bản 4 (23/11/2026) thêm `send` và `history`, thôi chuyển `old_messages` thành `event` (lệnh `history` đọc nó). Adapter chỉ nhận đúng bản 4: bundle đi cùng commit với mã Go và băm được kiểm lúc khởi động, nên lệch bản chỉ xảy ra khi triển khai hỏng.

## Gửi tin

Chỉ chữ, chỉ chat 1-1 (`src/send.mjs`, có test chạy `zca-js` thật với `fetch` giả). `api.sendMessage({ msg }, to, ThreadType.User)` của `zca-js` 2.3.0 gửi đúng **một** yêu cầu `POST <zpwServiceMap.chat[0]>/api/message/sms`; host lấy từ bản đồ dịch vụ Zalo trả lúc đăng nhập (`zpw_service_map_v3`), không cố định trong mã. Bộ chặn đi ra không phải mở thêm: host đó phải thuộc `*.zalo.me`, nếu bản đồ trỏ ra ngoài thì lần gửi bị chặn và báo `network_error` (có test). Tường lửa thì khác: `hosts.conf` hiện chưa có host dịch vụ chat (tên dự kiến dạng `tt-chat<N>-wpa.chat.zalo.me`), nên lần gửi thật đầu tiên cần học tên đó (log `zalo-sandbox-blocked`, dòng `host` trên stderr) rồi thêm vào danh sách.

- Không gọi `sendSeenEvent`, `sendDeliveredEvent`, `sendTypingEvent`, `addReaction`, `findUser`, `getMultiUsersByPhones` (test đọc `src/entry.mjs`). Không gửi vào nhóm.
- `zca-js` tự đặt mã gửi `clientId: Date.now()` và không trả lại, nên `sent` không có `cliMsgId`; `ts` là đồng hồ của tiến trình phụ lúc Zalo trả lời.
- **Mã `send_error`:** chắc chắn không tạo tin: `rate_limited` (HTTP 429), `session_rejected` (HTTP 401/403), `refused` (Zalo trả mã lỗi riêng, kèm `zaloCode` dạng số, không kèm thông báo), `bad_request`, `not_logged_in`. Chưa rõ tin có được tạo không: `network_error`, `zalo_unavailable` (HTTP lỗi khác), `unclear` (gồm trả lời không có `msgId`). Mã riêng của Zalo cho «bị chặn», «quá nhanh» **chưa quan sát** trên tài khoản thật; khi gặp, ghi `zaloCode` vào đây.
- **Lịch sử:** `zca-js` 2.3.0 chỉ có `listener.requestOldMessages(ThreadType.User, null)`: xin qua websocket trang tin cũ mới nhất của **mọi** chat 1-1 (không lọc theo người), trang về sau dưới dạng sự kiện `old_messages` không mang mã yêu cầu. Nên mỗi lúc chỉ một yêu cầu (`busy`), chờ 10 giây (`timeout`), cần kênh nghe đang nối (`listener_down`); trang được cắt còn tin của một người (tối đa 50 tin mới nhất) và `oldestTs` của cả trang cho biết trang phủ về tới đâu. Cỡ trang do Zalo quyết; chưa đo trên tài khoản thật.
- Khử trùng khi gửi lại cùng `RandomID` nằm ở adapter Go (`send.go`, `sent_log.go`), xem [`chat-bridge.md`](./chat-bridge.md#zalo-chỉ-nhận-tắt-mặc-định).

## Rủi ro đã biết

Zalo cấm phần mềm bên thứ ba trong điều khoản (Điều 4.7, 14.2); tài khoản có thể bị hạn chế. Đã chấp nhận cho tài khoản chính của chủ (quyết định trong kho kế hoạch riêng). Zalo đổi giao thức thì thư viện vỡ cho tới khi nâng phiên bản và rà soát lại.

## Chuẩn bị máy chủ (đã làm trên máy dùng chung 21/11/2026, adapter vẫn tắt)

Thư mục `infra/chat/zalo-sandbox/`, cài bằng `bash setup-zalo-sandbox.sh` (root, chạy lại được):

- **User `zalo`** (hệ thống, không shell, không thư mục nhà): nơi tiến trình phụ chạy. `ZALO_SANDBOX_USER=zalo`.
- **Tường lửa chỉ cho user đó** (`zalo-sandboxctl`): một chuỗi `ZALO_OUT` nối từ `OUTPUT` bằng đúng một quy tắc `-m owner --uid-owner`, không đụng tới user khác. Cho phép DNS tới các bộ phân giải của máy và cổng 443 tới `ipset` `zalo-hosts`; mọi thứ khác bị từ chối và ghi log (`zalo-sandbox-blocked:`), kể cả IPv6. Quy tắc **không** nằm trong `/etc/sysconfig/iptables`: một quy tắc nhắc tới `ipset` không được nạp lúc khởi động trước khi tập có mặt, nếu không cả lần khôi phục sẽ hỏng. Dịch vụ `zalo-sandbox.service` tạo tập rồi mới dựng quy tắc.
- **Danh sách địa chỉ theo DNS** (`zalo-ipset-refresh`, hẹn giờ 5 phút, tên trong `/etc/zalo-sandbox/hosts.conf`): tra DNS lỗi thì **giữ địa chỉ cũ, báo, thoát mã 1**; địa chỉ chỉ bị bỏ sau 12 lần tra thành công liên tiếp không còn thấy; không bao giờ tự xoá trắng. Số liệu đẩy vào VictoriaMetrics và ba luật cảnh báo (`ZaloIpsetLookupFailing`, `ZaloIpsetRefreshStopped`, `ZaloIpsetEmpty`) nằm ở kho cấu hình Victoria; cảnh báo vào nhóm «Vận hành chat».
- **Chế độ:** mặc định `enforce`. `zalo-sandboxctl learn [phút]` mở cửa sổ học (443 tới mọi địa chỉ được cho phép và ghi log `zalo-sandbox-learn:`), rồi tự về `enforce` sau số phút đã chọn. Dùng đúng một lần, ngay trước lần đăng nhập đầu, để hoàn thiện `hosts.conf` từ các dòng `host <tên>` của tiến trình phụ và log; sau đó `zalo-sandboxctl enforce`.
- **Bản đóng gói:** `/opt/chat/zalo-sidecar/` (root, 0755), tệp 0644; `ZALO_SIDECAR_BUNDLE=/opt/chat/zalo-sidecar/zalo-sidecar.cjs`. Hiện chép tay từ bản đã commit (băm khớp `.sha256`); nâng bản thì chép lại, chưa nằm trong bước deploy.
- **Đã thử trên máy thật (user `zalo` chạy được tiến trình phụ và thoát khi đóng stdin; tới `chat.zalo.me:443` được; `example.com`, cổng 80, kho npm, IPv6 và ổ cắm unix đều bị chặn; root không bị ảnh hưởng).**

### Hạ quyền: sudo một lệnh (21/11/2026)
`chat-api` chạy dưới user `chat` (pm2 hạ quyền xuống `uid: chat`), không phải root, nên nó **không** tự đổi sang user `zalo` được, và cấp cho nó `CAP_SETUID` thì nếu nó bị chiếm, kẻ tấn công thành bất kỳ user nào kể cả root. Vì vậy dùng một quy tắc `sudoers` hẹp (`/etc/sudoers.d/zalo-sidecar`, mẫu ở `infra/chat/zalo-sandbox/zalo-sidecar.sudoers`, cài bởi `setup-zalo-sandbox.sh` sau khi `visudo` kiểm cú pháp): `chat` chỉ được chạy **đúng** `/opt/node22/bin/node /opt/chat/zalo-sidecar/zalo-sidecar.cjs` dưới user `zalo`, không mật khẩu, không đối số khác, không đặt môi trường (`env_reset` bật, `setenv` tắt). Đã thử trên máy thật: lệnh đó chạy dưới `zalo`; `id`, `sh`, thêm đối số (`--inspect`), tệp khác, đích `root`, và user khác `chat` đều bị từ chối. Runner Go khởi động bằng `sudo -n -u zalo -- <node> <bundle>`; không cần `CAP_SETUID`, `CAP_SETGID` hay `CAP_CHOWN`. Mỗi lần chạy `sudo` ghi vào log hệ thống.

