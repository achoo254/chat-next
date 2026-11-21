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
- Tiến trình không ghi tệp, không sinh tiến trình con, không đọc biến môi trường; đóng `stdin` là dừng.

## Môi trường cách ly

Adapter Go chạy `<ZALO_NODE_PATH> <bundle>` với môi trường viết tay (`PATH` thư mục hệ thống, `HOME` là thư mục làm việc, `TZ=UTC`, `WS_NO_BUFFER_UTIL=1`, `WS_NO_UTF_8_VALIDATE=1`, không thừa kế biến nào của server), nhóm tiến trình riêng, dừng bằng đóng `stdin` rồi giết cả nhóm sau 3 giây. Trên Linux thêm `Pdeathsig` (giết tiến trình phụ khi server chết; tín hiệu gắn với luồng hệ điều hành đã khởi động nó, Go hiếm khi bỏ luồng, nếu có thì tiến trình phụ chết sớm và được khởi động lại). `stdout` không bao giờ vào log; `stderr` chỉ vào `slog` dưới dạng tên host (`host`) hoặc chữ "blocked", dòng khác chỉ ghi là có dòng lạ, không kèm nội dung. Dòng `stdout` dài quá 1 MiB thì dừng tiến trình.

**Đổi user (làm trong Go, không dùng sudo hay systemd-run):** tiến trình phụ chạy dưới `ZALO_SANDBOX_USER` bằng `SysProcAttr.Credential` (uid và gid chính của user đó, **không** nhóm phụ). Thư mục làm việc do server tạo trong thư mục tạm, chuyển chủ sang user đó với quyền `0700`, khi tiến trình thoát thì lấy lại chủ rồi xoá. Server cần `CAP_SETUID`, `CAP_SETGID` và `CAP_CHOWN` (hoặc chạy bằng root); thiếu thì mỗi lần khởi động tiến trình phụ lỗi và engine thử lại. Chỉ bản Linux làm được; hệ khác Zalo không được đăng ký.

**Kiểm lúc khởi động** (một điều sai thì Zalo không được đăng ký, log lỗi «Zalo is not offered» kèm lý do):

- `ZALO_SANDBOX_USER` tồn tại, uid và gid khác 0, uid khác uid của server.
- `ZALO_NODE_PATH` là đường dẫn tuyệt đối tới một tệp thực thi.
- Bundle: đường dẫn tuyệt đối, tệp thường (liên kết bị từ chối), không cho nhóm hay mọi người ghi, không thuộc và không ghi được bởi user cách ly; mọi thư mục từ thư mục chứa nó lên `/` không thuộc và không ghi được bởi user đó (thư mục ai cũng ghi được bị từ chối, kể cả có sticky bit).
- SHA-256 của bundle bằng giá trị trong `zalo-sidecar.cjs.sha256` cạnh nó (hoặc `ZALO_SIDECAR_SHA256`).

Điều kiện còn lại của máy chủ (chưa làm; phải xong trước khi đặt `ZALO_SIDECAR_BUNDLE` ở production): tạo user cách ly; cấp quyền cho server như trên; tường lửa `iptables` + `ipset` theo user, làm mới theo DNS bằng timer, giữ địa chỉ cũ và cảnh báo khi tra DNS lỗi; lần đăng nhập đầu ở chế độ chỉ ghi log để học danh sách tên miền rồi khoá.

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

## Giao thức stdio (phiên bản 3)

Mỗi dòng là một JSON. Lệnh vào: `login_qr` (kèm `listen:false` để dừng ở `account` mà không mở kênh nghe; adapter luôn gửi như vậy), `login_session` (kèm `session`), `stop`. Sự kiện ra: `ready` (kèm `protocol`), `qr`, `qr_scanned`, `qr_expired`, `qr_declined`, `logged_in` (kèm phiên, engine giữ), `account` (id tài khoản Zalo, 1-20 chữ số; id khác thì lỗi `no_account`), `message`, `event`, `listener`, `error` (chỉ mã, xem bảng trên). Chi tiết ở đầu `src/entry.mjs`. Chưa có lệnh gửi tin, lấy lịch sử, liệt kê hội thoại hay đăng xuất.

Lịch sử: bản 2 (21/11/2026) thêm `account` vì đăng nhập QR phải báo engine tài khoản nào vừa vào; bản 3 (21/11/2026) thêm `listen:false` và mã lỗi đăng nhập, kiểm id tài khoản. Adapter chỉ nhận đúng bản 3: bundle đi cùng commit với mã Go và băm được kiểm lúc khởi động, nên lệch bản chỉ xảy ra khi triển khai hỏng.

## Rủi ro đã biết

Zalo cấm phần mềm bên thứ ba trong điều khoản (Điều 4.7, 14.2); tài khoản có thể bị hạn chế. Đã chấp nhận cho tài khoản chính của chủ (quyết định trong kho kế hoạch riêng). Zalo đổi giao thức thì thư viện vỡ cho tới khi nâng phiên bản và rà soát lại.
