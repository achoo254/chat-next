# Tiến trình phụ Zalo

Adapter Zalo của Chat Bridge nói chuyện với Zalo qua một tiến trình phụ Node, `server/internal/bridge/adapters/zalo/sidecar/`, chạy thư viện [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (MIT, không chính thức, mô phỏng Zalo Web). Tài liệu này nói cách thư viện được đưa vào và giữ an toàn. Adapter Go dùng nó chưa viết xong.

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
- Luôn truyền hàm nhận QR; không có thì thư viện ghi `qr.png` vào thư mục hiện tại.
- **Bộ chặn đi ra trong tiến trình** (`src/egress-guard.mjs`, có test): mọi kết nối đi qua `net.Socket#connect`, chỉ cho phép `*.zalo.me`; từ chối IP trần và ổ cắm unix (`ws+unix:`). Thư viện lấy địa chỉ websocket và host API từ phản hồi của máy chủ mà không kiểm tra, nên lớp này cần thiết. Tên miền cho phép được in một lần ra `stderr` (`host <tên>`); đó là nguồn danh sách cho tường lửa.
- `stdout` chỉ để giao thức (một dòng JSON mỗi sự kiện); `stderr` chỉ có `host ...` và `blocked ...`, không có nội dung tin, cookie, imei, tên hay id.
- Tiến trình không ghi tệp, không sinh tiến trình con, không đọc biến môi trường; đóng `stdin` là dừng.

Điều kiện của môi trường chạy (do engine và máy chủ bảo đảm, chưa làm): user hệ điều hành riêng không đọc được DSN hay khoá SecretBox; môi trường sạch (`WS_NO_BUFFER_UTIL=1`, `WS_NO_UTF_8_VALIDATE=1`, không `NODE_OPTIONS`); chỉ đọc tệp đóng gói; tường lửa `iptables` + `ipset` theo user, làm mới theo DNS bằng timer, giữ địa chỉ cũ và cảnh báo khi tra DNS lỗi; lần đăng nhập đầu ở chế độ chỉ ghi log để học danh sách tên miền rồi khoá.

## Giao thức stdio (phiên bản 1)

Mỗi dòng là một JSON. Lệnh vào: `login_qr`, `login_session` (kèm `session`), `stop`. Sự kiện ra: `ready`, `qr`, `qr_scanned`, `qr_expired`, `qr_declined`, `logged_in` (kèm phiên, engine giữ), `message`, `event`, `listener`, `error` (đã lọc, không có phản hồi thô). Chi tiết ở đầu `src/entry.mjs`. Chưa có lệnh gửi tin.

## Rủi ro đã biết

Zalo cấm phần mềm bên thứ ba trong điều khoản (Điều 4.7, 14.2); tài khoản có thể bị hạn chế. Đã chấp nhận cho tài khoản chính của chủ (quyết định trong kho kế hoạch riêng). Zalo đổi giao thức thì thư viện vỡ cho tới khi nâng phiên bản và rà soát lại.
