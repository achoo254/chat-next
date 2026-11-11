# Đặc tả khung terminal (phiên bản 1)

Nguồn duy nhất cho hai thứ: **khung terminal** (client ⟷ `tunelo-term-host`) và **giao thức điều khiển cục bộ** (agent ⟷ `tunelo-term-host`). Phase agent, web và daemon đều viết theo file này;
khi mã và file này lệch nhau thì sửa file này cùng lúc với mã.

Các số trong mục "Điều khiển luồng" lấy từ spike đo thật qua VPN lab (xem `plans/dattqh/reports/spike-261111-remote-terminal.md` ở repo gốc): không có cửa sổ ack thì echo p99 lên 1,7 giây khi đang in
dữ liệu lớn; cửa sổ 64 KB giữ p99 khoảng 45 ms.

## 1. Khái niệm

- **Phiên (session)**: một PTY do daemon giữ, id `u32` (daemon cấp, tăng dần, bắt đầu từ 1, không dùng lại trong một lần chạy daemon).
- **Kết nối (conn)**: một client đang nói chuyện với daemon, id `u32` do agent cấp. Một kết nối đi qua **đường thẳng** (WebRTC) hoặc **đường relay** (qua agent) hoặc cả hai lúc đổi đường.
  Daemon gửi trên đường thẳng khi đang nối, ngược lại trên relay. Kết nối gắn **khoá thiết bị** (`deviceKey`, 32 byte, base64url) đã ghép; dùng để thu hồi.
- **Offset đầu ra**: `u64` đếm byte đầu ra thô của PTY từ lúc mở phiên (trước mọi xử lý của terminal). Mọi khung đầu ra mang offset của byte đầu tiên; client ack theo offset.
- Số nguyên nhiều byte luôn **big-endian**. Văn bản luôn UTF-8.

## 2. Vận chuyển khung

| Đường | Cách mang khung |
|---|---|
| WebRTC | Client tạo hai data channel đều có thứ tự và tin cậy (mặc định của `createDataChannel`, không `negotiated`) **trước khi** tạo offer: `term-in` (client → daemon) và `term-out` (daemon → client). Mỗi message nhị phân là đúng **một** khung. Daemon chỉ đọc `term-in`, chỉ ghi `term-out`; channel khác nhãn bị bỏ qua. Đường thẳng chỉ coi là mở khi cả hai channel đã mở. |
| Relay | Mỗi khung là trường `data` của đúng một `TermData` trên kết nối E2E riêng cho terminal (agent chuyển nguyên vẹn qua socket điều khiển, xem mục 6). |

Kích thước tối đa mỗi khung (gồm header): **65536 byte**. `Input` tối đa 8192 byte dữ liệu mỗi khung.

## 3. Khung

Header chung: `type u8` · `session u32` (0 với khung cấp kết nối). Phần còn lại là dữ liệu theo loại.

### Client → daemon

| Loại | Tên | Dữ liệu |
|---|---|---|
| `0x01` | Hello | `version u8` (=1) · `caps u8` (=0). Khung đầu tiên client gửi; `session` = 0. |
| `0x10` | Input | byte bàn phím thô cho phiên. |
| `0x11` | Resize | `cols u16` · `rows u16` (mỗi số từ 1 đến 1000). |
| `0x12` | Attach | `lastOffset u64` (0 nếu chưa có gì). Đăng ký nhận đầu ra của phiên (xem mục 4). |
| `0x13` | Detach | không có. Ngừng nhận đầu ra của phiên; phiên vẫn chạy. |
| `0x14` | Ack | `offset u64`: số byte đầu ra client đã áp dụng (không giảm). |
| `0x15` | Ping | `clientMicros u64`; `session` = 0. |

### Daemon → client

| Loại | Tên | Dữ liệu |
|---|---|---|
| `0x81` | Hello | `version u8` · `maxFrame u32` (=65536). Trả lời `Hello`; `session` = 0. |
| `0x90` | Output | `offset u64` · byte đầu ra thô. |
| `0x91` | Snapshot | `offset u64` · `cols u16` · `rows u16` · `altScreen u8` (0/1) · chuỗi VT dựng lại màn hình (mục 4). `offset` là offset mà `Output` kế tiếp sẽ bắt đầu. |
| `0x92` | Exit | `code i32` (-1 nếu bị tín hiệu giết) · `signal u8` (0 nếu không). Gửi ngay sau khung `Output` cuối cùng của phiên (đầu ra còn bị window giữ thì đi trước). |
| `0x95` | Pong | `clientMicros u64` (nguyên giá trị của `Ping`); `session` = 0. |
| `0x9F` | Error | `code u16` · thông điệp UTF-8. `session` là phiên liên quan, 0 nếu lỗi cấp kết nối. |

Mã lỗi: `1` phiên không tồn tại · `2` quá hạn mức phiên · `3` khung sai · `4` phiên bản không hỗ trợ · `5` chưa Attach · `6` kết nối đã bị thu hồi.

Khung không biết (loại lạ) bị bỏ qua và không làm đứt kết nối; khung sai độ dài hoặc giá trị ngoài miền (`session` = 0 với khung của phiên, `session` ≠ 0 với `Hello`/`Ping`, kích thước ngoài 1–1000, `Input` quá 8192 byte) trả `Error 3`.
Khung nào khác `Hello` gửi trước `Hello` hợp lệ trả `Error 3`. `Input`, `Resize`, `Ack`, `Detach` cho phiên chưa `Attach` trả `Error 5`. `Ack` vượt quá byte đã gửi trả `Error 3`; `Ack` nhỏ hơn lần trước bị bỏ qua.
Sau `Error 6` daemon đóng kết nối; khung đến sau đó của kết nối ấy bị bỏ.

## 4. Mở lại phiên (reattach)

Client gửi `Attach{lastOffset}`. Daemon giữ vòng đệm byte thô tối đa **1 MiB mỗi phiên** (giá trị mặc định, cấu hình được, tối thiểu 256 KiB) và một emulator không đầu giữ trạng thái màn hình.

1. Nếu `lastOffset` > 0 và vòng đệm còn giữ byte từ `lastOffset` trở đi (kể cả `lastOffset` bằng offset hiện tại): gửi `Output` bắt đầu từ `lastOffset`, rồi tiếp tục luồng sống.
2. Ngược lại (kể cả `lastOffset` lớn hơn offset hiện tại): gửi `Snapshot`, rồi `Output` từ offset của nó.

Snapshot và các `Output` sau nó không bao giờ chồng lấn hay bỏ sót byte. Đổi đường giữa chừng (WebRTC ⟷ relay) dùng đúng quy tắc này: client gửi lại `Attach` với offset đã áp dụng.
`Attach` lại một phiên đang gắn thay trạng thái gắn cũ (offset, window) bằng trạng thái mới.

**Đổi đường không mất, không lặp byte** (đã kiểm bằng test relay → thẳng → relay → thẳng giữa luồng đầu ra, so băm với một client chỉ đi relay):
- Daemon gửi trên đường thẳng ngay khi cả hai channel mở (`conn_state direct`), và quay về relay ngay khi peer kết thúc (`conn_state relay`). Khung đã gửi trên đường cũ có thể còn đang tới, hoặc mất hẳn nếu đường cũ chết.
- Client **áp dụng `Output` theo offset**: giữ `applied` mỗi phiên; khung có `offset > applied` là chỗ hở thì bỏ (sẽ được gửi lại sau `Attach`); phần byte trước `applied` là trùng thì cắt; chỉ ack offset đã áp dụng. Quy tắc này áp dụng mọi lúc, không chỉ lúc đổi đường.
- Ngay khi đường mới dùng được, client gửi `Attach{applied}` **trên đường mới** cho mọi phiên đang gắn. Daemon phát lại từ đó (vòng đệm luôn còn giữ vì `applied` ≥ `ackedOffset` ≥ offset hiện tại − window).
- **Thứ tự phím**: hai đường có thể đảo thứ tự nhau. Khi chuyển từ relay còn sống sang đường thẳng, client gửi một `Ping` (giá trị riêng) trên relay sau khung cuối cùng của relay và chỉ gửi gì trên đường thẳng sau khi nhận đúng `Pong` đó (daemon xử lý khung relay theo thứ tự, nên mọi phím trước đó đã tới PTY); phím gõ trong lúc chờ (vài ms) được giữ lại rồi gửi trên đường thẳng. Khi đường thẳng chết, phím đang bay trên nó có thể mất (client không biết đã tới hay chưa); client không gửi lại.

Chi tiết `Snapshot`:
- `offset` là **ranh giới an toàn** gần nhất không lớn hơn offset hiện tại: emulator chỉ được nạp tới chỗ không nằm giữa một chuỗi điều khiển hay một ký tự UTF-8. Phần đuôi dở dang (tối đa 4 KiB) đến sau trong `Output` từ `offset`, nên chuỗi bị cắt giữa hai lần đọc PTY vẫn tới client nguyên vẹn.
- Chuỗi VT tự đủ: bắt đầu bằng `ESC c` (RIS), rồi `ESC[?1049h` nếu `altScreen` = 1, rồi `OSC 2` tiêu đề nếu có, rồi nội dung màn hình có thuộc tính, vị trí và trạng thái ẩn/hiện con trỏ, và các chế độ nhập (application cursor/keypad, bracketed paste, chuột). Client đổi cỡ về `cols`×`rows` rồi ghi nguyên chuỗi.
  Màn hình thường nằm dưới màn hình thay thế không được dựng lại (client thấy màn hình thường trống khi chương trình thoát màn hình thay thế).
- Nếu chuỗi đủ thuộc tính vượt một khung, daemon gửi bản rút gọn: chữ không màu của các dòng dưới cùng vừa khung, vị trí con trỏ và các chế độ nhập.
- Nếu byte mà client còn cần đã rời vòng đệm (chỉ xảy ra khi cấu hình vòng đệm sai), daemon gửi `Snapshot` mới để đồng bộ lại thay vì để hở.

## 5. Điều khiển luồng

- Daemon theo dõi cho từng (kết nối, phiên) `inflight = sentOffset − ackedOffset` và `outstanding = readOffset − ackedOffset` (`readOffset` là offset hiện tại của phiên, gồm cả byte đã đọc nhưng còn đang gom hoặc chờ ngân sách relay).
  - Daemon không bao giờ gửi quá `ackedOffset + window`, nên `inflight ≤ window`.
  - Khi `outstanding ≥ window` của bất kỳ kết nối nào đang gắn, daemon **ngừng đọc PTY** của phiên đó; kernel đầy bộ đệm nên chương trình bên trong chậm lại như terminal thật. Phiên không có kết nối nào gắn thì đọc tự do (vòng đệm ghi đè byte cũ).
- `window` khởi đầu **64 KiB**, giới hạn từ **16 KiB** đến **1 MiB**, và không vượt dung lượng vòng đệm trừ 128 KiB (chỗ cho byte đọc thêm sau khi window đầy; với vòng đệm mặc định 1 MiB thì window hiệu lực tối đa 896 KiB).
  Thiếu giới hạn này, byte đã đọc mà chưa gửi có thể rời vòng đệm và client phải nhận `Snapshot` giữa chừng.
- Thích ứng theo độ trễ, đo bằng `Ack` (daemon không thấy RTT của `Ping`, vì `Pong` chỉ về client): daemon ghi thời điểm gửi mỗi khung `Output`; khi một `Ack` kết thúc đúng ở cuối một khung và phủ thêm ≥ 16 KiB
  (tức là ack theo ngưỡng, không phải theo bộ hẹn 50 ms) thì `rtt = lúc nhận Ack − lúc gửi khung đó`. Daemon giữ `rttMin` (cửa sổ trượt 10 giây) và tính `queueDelay = rtt − rttMin`.
  Mỗi RTT tối đa một lần đổi: nếu `queueDelay` < 10 ms và `window` đã dùng hết (`inflight` chạm `window`) thì tăng 16 KiB; nếu `queueDelay` > 40 ms thì giảm một nửa (tối thiểu 16 KiB).
  Byte bị giữ vì gom hay vì ngân sách relay không tính là "dùng hết", nên window không phình khi nút thắt là ngân sách của chính daemon.
- `Ping`/`Pong` dùng cho client đo RTT để hiển thị nhãn và giữ kết nối: client gửi `Ping` mỗi 500 ms (mỗi 100 ms khi `inflight` ≥ nửa window).
- Client ack mỗi khi đã áp dụng thêm ≥ 16 KiB, và ít nhất mỗi 50 ms khi còn byte chưa ack. Offset ack luôn là cuối một khung đã áp dụng.
- **Gom đầu ra**: daemon đọc PTY vào bộ đệm 16 KiB, gửi ngay nếu (a) phiên vừa nhận `Input` trong 25 ms gần nhất (đường echo), (b) đầu ra còn lại sau `Attach`, (c) phiên đã kết thúc, hoặc (d) đã gom đủ 16 KiB; ngược lại chờ tối đa 4 ms để gom.
  Trên **đường relay**: gom tới 16 ms (50 ms khi ngân sách còn dưới một nửa) hoặc tới đủ một khung (65523 byte dữ liệu); đường echo (a)–(c) vẫn gửi ngay. Mọi khung `Output` trên relay của cả máy dùng chung một ngân sách
  200 khung/giây (thùng token, dồn tối đa 20); khung nào không có token thì chờ token kế tiếp. `Snapshot`, `Exit`, `Error`, `Pong`, `Hello` không tính vào ngân sách. Giới hạn của relay là 1000 tin/giây dùng chung với chat.
- **Ưu tiên phím**: mỗi vòng lặp xử lý hết `Input` đang chờ trước khi đọc đầu ra PTY. Phím được ghi vào PTY trên một luồng riêng nên một chương trình không đọc stdin không làm nghẽn phiên khác.
  Trên đường thẳng, luồng WebRTC của mỗi peer cũng xử lý datagram đến (phím) trước khung đầu ra đang chờ gửi.
- Window, ack và gom ở trên giống hệt nhau cho cả hai đường (cùng mã). Trên đường thẳng, bộ đệm gửi SCTP là 2 MiB (lớn hơn window tối đa) để window, không phải SCTP, quyết định lượng byte đang bay; không có ngân sách khung.

## 6. Giao thức điều khiển cục bộ (agent ⟷ daemon)

### Vận chuyển và xác thực

- POSIX: Unix domain socket `<thư mục cấu hình>/term-host/control.sock`, thư mục 0700, socket 0600; daemon kiểm UID đối tác (`SO_PEERCRED` hoặc `getpeereid`).
- Windows: named pipe có tên ngẫu nhiên ghi vào `<thư mục cấu hình>\term-host\control.json` (cùng `token`), tạo với `FILE_FLAG_FIRST_PIPE_INSTANCE`, ACL chỉ chủ tài khoản; client kiểm SID chủ tiến trình phía máy chủ.
- Cả hai: tệp `control.json` (0600, ghi nguyên tử mỗi lần daemon khởi động, xoá khi daemon thoát sạch) chứa `token` ngẫu nhiên (32 byte, hex), `pid`, `major`, `minor`, `daemonVersion`, và `socket` (POSIX, đường dẫn socket) hoặc `pipe` (Windows, `\\.\pipe\tunelo-term-host-<ngẫu nhiên>`).
  Lệnh đầu tiên phải là `hello` kèm `token` đúng trong vòng 10 giây; nếu không daemon trả lỗi `unauthorized` (sai `major` thì `version_mismatch`) rồi đóng kết nối. Lỗi không bao giờ nhắc lại token.
- Mỗi **thư mục cấu hình** (`TUNELO_HOME`) có đúng một daemon: khoá bằng `<thư mục cấu hình>/term-host/lock`. Binary thoát mã 3 khi thư mục đã có daemon khác giữ khoá.
  Thư mục cấu hình mặc định giống agent: `%APPDATA%\tunelo` trên Windows, `$XDG_CONFIG_HOME/tunelo` hoặc `~/.config/tunelo` nơi khác.
- Mỗi lúc chỉ có **một agent**: `hello` thành công của kết nối mới thay kết nối cũ (daemon đóng kết nối cũ). Agent ngừng đọc socket quá 10 giây thì bị đóng.
- Agent mất kết nối: các kết nối terminal chỉ đi qua relay của agent đó bị đóng (`reason` `agent_gone`), kết nối có đường thẳng giữ nguyên; phiên vẫn chạy.
- Daemon tự thoát khi không còn phiên và không còn kết nối terminal (kể cả chỗ chờ `grant`) trong 10 phút; kết nối của agent không tính. SIGTERM/SIGINT/SIGHUP (POSIX) hoặc Ctrl-C/Ctrl-Break/đóng console (Windows) dừng sạch như `shutdown`.

### Khung trên socket

`[length u32][kind u8][payload]`, `length` tính cả `kind` và `payload`, tối đa 1 MiB.

| `kind` | Nội dung |
|---|---|
| `0` | JSON UTF-8 (lệnh, trả lời, sự kiện). |
| `1` | Dữ liệu đường relay: `conn u32` · một khung terminal đúng mục 3. Hai chiều. |

### Phiên bản

`hello` mang `{major, minor}`. Cùng `major` thì tương thích; `minor` chỉ thêm trường mới. Daemon cũ còn phiên vẫn phục vụ agent mới cùng `major`.
Hiện tại: `major` 1, `minor` 1. `minor` 1 thêm trường `connections` vào kết quả `hello`; daemon luôn gửi trường này, agent nói `minor` 0 bỏ qua nó và vẫn chạy như cũ. Agent gặp daemon `minor` 0 (không có `connections`) thì không dọn kết nối mồ côi.

### Lệnh (agent → daemon)

Mọi lệnh có `id` (số nguyên) và `cmd`; trả lời `{id, ok: true, result}` hoặc `{id, ok: false, error: {code, message}}`.

| `cmd` | Tham số | Kết quả |
|---|---|---|
| `hello` | `major, minor, token, agentVersion` | `major, minor, daemonVersion, pid, sessions[], connections[]` (từ `minor` 1), `pendingAudit[]` |
| `open` | `cols, rows, shell?, args?, cwd?, env?` (`env` chỉ nhận `CLAUDE_CONFIG_DIR`) | `session` |
| `close` | `session` | `{}`; treo máy shell (SIGHUP shell và nhóm tiến trình tiền cảnh, sau 2 giây SIGKILL), gỡ phiên khi tiến trình đã thoát |
| `resize` | `session, cols, rows` | `{}` |
| `list` | không | `sessions[]` (`session, title, cols, rows, createdAt, attached, exited?`; `exited` là `{code, signal}` khi tiến trình đã thoát) |
| `grant` | `conn, deviceKey, expiresMs?` (mặc định 60000, 1–600000) | `{}`; tạo chỗ chờ cho kết nối `conn`, hết hạn nếu không có kết nối nào (`conn_state closed`, `reason` `expired`) |
| `signal` | `conn, kind` (`offer` \| `candidate` \| `end`), `sdp?` (bắt buộc với `offer`), `candidate?` (bắt buộc với `candidate`) | `{}`; phản hồi đến qua sự kiện `signal` (mục "Đường thẳng") |
| `relay_open` | `conn` | `{}`; đánh dấu kết nối nhận khung qua socket (`kind 1`) |
| `conn_close` | `conn` | `{}`; đóng kết nối (client đi, kết nối E2E đứt) |
| `revoke_device` | `deviceKey` | `{closed: n}`; thêm khoá vào danh sách thu hồi và đóng ngay mọi kết nối của thiết bị (kể cả chỗ chờ `grant`) |
| `set_revoked` | `deviceKeys[]` | `{closed: n}`; thay danh sách thu hồi, đóng kết nối của các khoá đó, từ chối `grant` mới của chúng |
| `ack_audit` | `upTo` | `{}` |
| `shutdown` | không | `{}` (trả sau khi xong); đóng mọi kết nối, rồi shell, rồi thoát |

Mã lỗi điều khiển: `bad_request`, `unauthorized`, `session_limit`, `no_such_session`, `no_such_conn`, `revoked`, `version_mismatch`, `internal`.

- Hạn mức **20 phiên** tính các phiên chưa đang đóng. Phiên đã thoát vẫn nằm trong `list` (có `exited`) tới khi `close`; khi đầy, `open` bỏ phiên đã thoát cũ nhất để lấy chỗ, không còn phiên đã thoát thì trả `session_limit`.
- `id` phiên tăng dần, không dùng lại trong một lần chạy daemon. Lệnh có `id` không phải số nguyên được trả lời với `id` = `null`.
- `signal`: `offer` không phải SDP hợp lệ có mục `m=application` trả `bad_request`; `conn` chưa `grant` trả `no_such_conn`. Chi tiết ở mục "Đường thẳng" dưới đây.
- `relay_open` khi đường thẳng đang mở trả sự kiện `conn_state` với `state` là đường đang dùng (`direct`).
- `grant` cho `conn` đang mở trả `bad_request`; `grant` lại một chỗ chờ thì làm mới hạn. Tối đa 256 kết nối (kể cả chỗ chờ).
- `hello.connections[]`: mọi kết nối daemon đang giữ (kể cả chỗ chờ `grant`), mỗi phần tử `{conn, deviceKey, state, createdAt}`. `state` theo `conn_state`: `direct` hoặc `relay` khi đã mở, `connecting` khi peer đang dựng hoặc `grant` còn chờ đường đầu tiên; `createdAt` là ms Unix lúc `grant`. Không có bí mật, SDP hay byte terminal.
  Kết nối chỉ đi relay đã bị đóng (`agent_gone`) khi kết nối điều khiển cũ mất, nên không có trong danh sách.
- `conn_state.reason` khi `closed`: `expired`, `closed` (`conn_close`), `revoked`, `agent_gone`, `transport_closed` (đường cuối cùng của kết nối mất: luồng ghi relay hỏng, hoặc đường thẳng kết thúc khi không có relay), `shutdown`.

### Sự kiện (daemon → agent)

| `event` | Trường |
|---|---|
| `signal` | `conn, kind` (`answer` \| `candidate` \| `end`), `sdp?`, `candidate?`, `reason?` (với `end`) |
| `conn_state` | `conn, state` (`connecting` \| `direct` \| `relay` \| `closed`), `rttMs?` (với `direct`), `reason?` (với `closed`) |
| `session_exit` | `session, code, signal` |
| `audit` | `seq, kind` (`open` \| `close` \| `denied`), `session?, conn?, deviceKey?, at` |

Sự kiện `audit` **không** mang nội dung gõ hay đầu ra. Daemon giữ các `audit` chưa được `ack_audit` và gửi lại trong kết quả `hello` (`pendingAudit`) để không mất sự kiện đóng khi agent tắt.
`seq` tăng dần từ 1 trong một lần chạy daemon; agent bỏ trùng theo `seq` (một sự kiện có thể vừa đến trực tiếp vừa nằm trong `pendingAudit`). Daemon giữ tối đa 4096 sự kiện chưa ack, quá thì bỏ cái cũ nhất.

- `open`: một kết nối `Attach` vào phiên (`session, conn, deviceKey`).
- `close`: kết nối gỡ khỏi phiên (`Detach`, kết nối đóng vì bất kỳ lý do gì, hoặc phiên bị gỡ) (`session, conn, deviceKey`).
- `denied`: `grant` của khoá đã thu hồi (`conn, deviceKey`).

Nhật ký của daemon (stderr) cũng không bao giờ chứa nội dung gõ, đầu ra hay token; chỉ có id, mã lỗi và trạng thái.

### Đường thẳng (WebRTC)

Trình duyệt (hoặc client không đầu) là bên **offer**, daemon **answer**. Mỗi `offer` tạo một peer mới (thư viện `str0m`, chứng chỉ DTLS mới mỗi peer); `offer` mới cho cùng `conn` thay peer cũ (trong lúc chờ, khung đi relay nếu có).

Trình tự sự kiện cho một `offer`:
1. `conn_state {state: connecting}`.
2. `signal {kind: answer, sdp}`: SDP answer đã chứa ứng viên host của daemon. Client đặt nó làm remote description.
3. `signal {kind: candidate, candidate}` (có thể không có, có thể nhiều): ứng viên tìm ra sau, hiện là srflx từ STUN. `candidate` là dòng `candidate:...` không có `a=`; client gọi `addIceCandidate({candidate, sdpMLineIndex: 0})` (SDP chỉ có một mục `m=application`).
4. `conn_state {state: direct}` khi `term-in` và `term-out` đều mở. Khi đo được RTT ICE lần đầu (khoảng 1 giây sau), daemon gửi lại **một lần** `conn_state {state: direct, rttMs}`.
5. Khi peer kết thúc: `signal {kind: end, reason}`, rồi `conn_state relay` nếu kết nối còn relay, hoặc `conn_state closed` (`reason` `transport_closed`) nếu kết nối đã mở mà không còn đường nào. Một `grant` chưa từng mở đường nào thì vẫn chờ (client có thể `relay_open`) tới khi hết hạn.

`signal end` của **agent** bỏ peer hiện tại, không có sự kiện `signal end` trả lại; trạng thái chuyển như bước 5. `signal candidate` của agent nhận một dòng `candidate:...` (chấp nhận tiền tố `a=`); chuỗi rỗng (hết ứng viên) và ứng viên mDNS `.local` bị bỏ qua.

`reason` của `signal end`: `closed` (thay bằng offer mới, đóng kết nối, thu hồi, tắt), `ice_disconnected` (đã nối rồi mất đồng thuận ICE), `channel_closed` (client đóng `term-in` hoặc `term-out`), `dtls_failed` (bắt tay DTLS lỗi, gồm chứng chỉ không khớp vân tay trong offer; agent ghi kiểm toán), `timeout` (hai channel chưa mở sau **20 giây**), `no_address` (không có địa chỉ cục bộ nào), `bad_offer` (thư viện WebRTC từ chối offer), `error`.

Địa chỉ và ứng viên của daemon:
- Liệt kê mọi giao diện đang bật (gồm VPN và Tailscale `100.64.0.0/10`, `fd7a:115c:a1e0::/48`); bỏ loopback (trừ khi bật cờ cho test: WebKit từ chối `127.0.0.1` và client thật không bao giờ ở cùng máy), IPv6 link-local `fe80::/10`, IPv4 link-local `169.254.0.0/16`, multicast, địa chỉ rỗng; tối đa 16 địa chỉ. Mỗi peer mở **một socket UDP cho mỗi địa chỉ** (cổng ngẫu nhiên), mỗi socket một luồng đọc.
- STUN: mỗi socket không phải loopback hỏi từng máy chủ STUN cùng họ địa chỉ (Binding RFC 5389, gửi lại sau 0,5 / 1,5 / 3,5 giây, bỏ sau 5,5 giây); địa chỉ ánh xạ khác địa chỉ cục bộ thì thành ứng viên srflx và được trickle. Danh sách máy chủ mặc định `tunnel.hoandat.com:3478`; đổi bằng cờ `--stun host:port[,host:port]` hoặc biến môi trường `TUNELO_TERM_STUN` (cờ thắng biến môi trường; chuỗi rỗng tắt STUN; tối đa 4 máy chủ; mục sai làm binary thoát mã 1). Không ghi cứng IP nào.
- ICE đầy đủ (không lite): daemon gửi kiểm tra kết nối **ra ngoài** ngay khi biết ứng viên của bên kia (từ SDP, trickle, hoặc peer-reflexive khi gói kiểm tra của trình duyệt tới). Trình duyệt che ứng viên host bằng mDNS nên daemon không cần ứng viên host của trình duyệt; nối qua ứng viên peer-reflexive. Tường lửa Windows chỉ cho gói trả lời của luồng đã gửi ra trước (spike), nên điều này là bắt buộc.

Thời hạn và đóng:
- Đồng thuận ICE: kiểm tra giữ đường mỗi tối đa 1,5 giây; cặp ứng viên không trả lời khoảng 10 giây (và quá 15 giây từ lần client kiểm tra gần nhất) thì ICE báo mất, daemon đóng peer (`ice_disconnected`). Đo trên Mac: client biến mất (không đóng, không gửi gì) thì `conn_state closed` sau khoảng 14 giây.
- **Daemon không bao giờ tự gỡ một client im lặng mà ICE còn sống** ở tầng ứng dụng (không có hạn chờ `Ping`): peer chết được ICE gỡ. Thoát khi rảnh không đổi.
- `revoke_device`, `set_revoked`, `conn_close`, `shutdown`: daemon gửi `Error 6` (với thu hồi) trên đường thẳng, chờ tối đa 250 ms cho khung đã gửi được client xác nhận, rồi gửi SCTP shutdown và DTLS close_notify; client thấy channel đóng. Đo trên Mac: dưới 1 giây (0,8 đến 205 ms, phần lớn là SACK trễ của SCTP).

### Windows

- `<thư mục cấu hình>\term-host` có DACL được bảo vệ chỉ cho tài khoản chạy daemon (`D:P(A;OICI;FA;;;<SID>)`, tương đương 0700, kế thừa cho file bên trong); `control.json` đặt DACL `D:P(A;;FA;;;<SID>)` trước khi ghi token (tương đương 0600).
- ConPTY gửi truy vấn vị trí con trỏ `ESC[6n` khi khởi động và không nhận phím cho tới khi được trả lời: daemon trả `ESC[1;1R` cho truy vấn đầu tiên và bỏ nó khỏi đầu ra (để terminal của client không trả lời lần nữa). Các truy vấn sau đi tới client như thường.
- Shell mặc định: `pwsh`, rồi `powershell`, rồi `cmd` (`COMSPEC`). POSIX: login shell theo `$SHELL`, rồi cơ sở dữ liệu người dùng, rồi `/bin/sh`. Mọi shell có `TERM=xterm-256color`, `COLORTERM=truecolor`, môi trường kế thừa của daemon.

## 7. Ghim vân tay DTLS

Trình duyệt tạo `offer` (chứng chỉ DTLS mới mỗi kết nối); SDP chỉ đến daemon qua kênh E2E đã xác thực của agent nên không ai chen giữa được. Daemon chỉ chấp nhận DTLS với đúng vân tay trong SDP đó
(đã là hành vi chuẩn của WebRTC) và trả `answer` có vân tay của nó, cũng qua E2E để client kiểm. Không có lớp mã hoá ứng dụng thêm trên data channel.
Vân tay không khớp thì peer kết thúc với `signal {kind: end, reason: dtls_failed}`, không channel nào mở, `grant` vẫn còn để client dùng relay (có test sửa vân tay trong SDP).

## 8. Kênh E2E thiết bị ⟷ agent (`remote.proto`)

Thiết bị (web, PWA, `tunelo term` sau này) nói với agent bằng các thân `Frame` dưới đây, niêm phong E2E như mọi khung khác. Agent chuyển chúng sang giao thức điều khiển ở mục 6.
Chỉ thêm, không đổi gì cũ: `PROTOCOL_VERSION` giữ nguyên; tính năng có từ `AGENT_VERSION` **2.4.0** và chỉ dùng khi `MachineInfo.terminal` là `AVAILABLE`.
Agent cũ gặp các thân này trả `Error` với `ERROR_REASON_UNSUPPORTED_REQUEST` như mọi khung lạ.

### Thân `Frame` (số trường 108 đến 117; 105 đến 107 đã thuộc cập nhật agent)

| Số | Thân | Chiều | Trả lời |
|---|---|---|---|
| 108 | `TermListRequest {}` | A → B | `TermListResult` |
| 109 | `TermOpen {cols=1, rows=2, cwd=3}` | A → B | `TermOpened`; lỗi `TERMINAL_SESSION_LIMIT`, `TERMINAL_UNAVAILABLE`, `FOLDER_NOT_FOUND` (subject là thư mục), `INVALID` khi cỡ ngoài 1–1000 |
| 110 | `TermClose {session=1}` | A → B | `TermClosed`; lỗi `TERMINAL_SESSION_NOT_FOUND` |
| 111 | `TermResize {session=1, cols=2, rows=3}` | A → B | `Ack`; lỗi `TERMINAL_SESSION_NOT_FOUND` |
| 112 | `TermSignal {link=1, kind=2, sdp=3, candidate=4, reason=5}` | hai chiều | A → B: `Ack` hoặc `Error` theo `id`; B → A không hỏi mà gửi |
| 113 | `TermData {link=1, data=2}` | hai chiều | không bao giờ trả lời |
| 114 | `TermListResult {sessions=1 (TermSessionInfo), max_sessions=2}` | B → A | |
| 115 | `TermOpened {session=1}` | B → A | |
| 116 | `TermClosed {session=1}` | B → A | |
| 117 | `TermStatus {link=1, path=2, rtt_ms=3 (float), reason=4}` | B → A, không hỏi | |

- `TermSessionInfo {session=1 (uint32), title=2, cols=3, rows=4, created_at=5 (int64, ms Unix), attached=6, exited=7, exit_code=8 (int32, -1 khi bị tín hiệu giết), exit_signal=9}`. `max_sessions` hiện là 20.
- `TermSignalKind`: `OFFER=1` (A → B), `ANSWER=2` (B → A), `CANDIDATE=3` (hai chiều, một dòng `candidate:...`), `END=4` (A → B: bỏ peer, relay giữ nguyên; B → A: peer đã kết thúc, `reason` theo mục 6 "Đường thẳng").
- `TermPath`: `CONNECTING=1`, `DIRECT=2`, `RELAY=3`, `CLOSED=4`. `DIRECT` có thể đến hai lần, lần hai có `rtt_ms` (0 là chưa đo).
- `MachineInfo.terminal = 23` (`TerminalAvailability`): `UNSPECIFIED=0` (agent cũ), `AVAILABLE=1`, `MISSING=2` (chưa có binary daemon), `INCOMPATIBLE=3` (daemon khác `major` đang chạy, hoặc máy không có trình giám sát; gợi ý chạy lại `tunelo install`). Agent gửi lại `MachineInfo` không hỏi khi giá trị đổi.
- `ErrorReason`: `TERMINAL_UNAVAILABLE=55`, `TERMINAL_SESSION_LIMIT=56`, `TERMINAL_SESSION_NOT_FOUND=57`. Thiết bị không còn được ghép nhận `ACCESS_DENIED`.

### Liên kết (link)

- Một **liên kết** là một client terminal của thiết bị (một trang). Thiết bị tự chọn `link` (`uint32` khác 0), **phạm vi trong một kết nối E2E**. Agent ánh xạ (kết nối E2E, `link`) sang một `conn` của daemon, duy nhất trên máy (bắt đầu từ một số ngẫu nhiên mỗi lần agent chạy, vì peer thẳng của lần chạy trước có thể còn sống), nên hai thiết bị hay hai trang không bao giờ đụng nhau.
- Liên kết được tạo ở `TermSignal{OFFER}` hoặc `TermData` đầu tiên mang `link` đó (agent `grant` với khoá thiết bị lấy từ phiên E2E, không lấy từ yêu cầu). Liên kết kết thúc khi kết nối E2E đóng, hoặc khi B gửi `TermStatus{CLOSED, reason}`. Sau đó cùng `link` là một liên kết mới: client bắt đầu lại bằng khung `Hello`.
- `TermSignal` và `TermData` của một liên kết phải đi trên **cùng một kết nối E2E**. Web nên mở một kết nối E2E thứ hai chỉ cho terminal (bộ đếm và hàng đợi riêng). `TermListRequest`, `TermOpen`, `TermClose`, `TermResize` không gắn liên kết và đi được trên kết nối nào cũng được.
- `TermSignal{CANDIDATE}` hay `{END}` cho `link` chưa có trả `Error` `NOT_FOUND`.
- Kết nối terminal phải gửi `Ping` E2E ít nhất mỗi 10 giây như kết nối chat (agent đóng kết nối im lặng 45 giây); khi đang dùng relay, `TermData` cũng tính là có hoạt động.

### `TermData` ⟷ khung relay của daemon

- A → B: `TermData.data` là đúng một khung terminal (5 đến 65 536 byte). Agent gửi nguyên vẹn thành khung `kind 1` `[conn u32][data]` trên socket điều khiển. `TermData` đầu tiên của liên kết làm agent `grant` rồi `relay_open`; các khung đến trong lúc đó được giữ (tối đa 256) và gửi theo đúng thứ tự.
- B → A: mỗi khung `kind 1` của `conn` thành một `TermData{link, data}` trên kết nối đã sở hữu liên kết.
- `TermData` **không đi qua hàng đợi tuần tự** của kết nối: agent mở khung ngay khi nhận và chuyển thẳng cho daemon, nên một yêu cầu chat chậm (`ThreadCreate`) không làm trễ phím (có test: echo dưới 100 ms khi một `ThreadCreate` đang treo trên cùng kết nối).
- Khung sai độ dài hay `link` = 0 chỉ đóng liên kết đó (`TermStatus{CLOSED, "bad_frame"}`, agent gửi `conn_close`); kết nối E2E và chat vẫn sống. Byte không mở được thành khung E2E thì đóng đúng kết nối E2E đó (như mọi kết nối).
- Ngân sách relay của **cả máy**: mọi `TermData` B → A dùng chung thùng token 200 khung/giây, dồn tối đa 40 (cộng với ngân sách 200 khung `Output`/giây của daemon ở mục 5). Khi hết token, hoặc socket của thiết bị còn trên 512 KiB chưa gửi, khung được giữ theo thứ tự rồi gửi sau; giữ quá 64 MiB thì liên kết đóng với `"overflow"`. Tín hiệu (`TermSignal`, `TermStatus`) không tính vào ngân sách.

### `TermStatus` từ `conn_state` của daemon

`connecting` → `CONNECTING`, `direct` → `DIRECT` (kèm `rttMs` nếu có), `relay` → `RELAY`, `closed` → `CLOSED` với `reason` của daemon (`expired`, `closed`, `revoked`, `agent_gone`, `transport_closed`, `shutdown`).
Agent thêm các `reason` của riêng nó: `bad_frame`, `overflow`, `unavailable` (daemon không chạy được hay mất giữa chừng), `revoked` (thiết bị không còn được ghép), `agent_gone` (agent mất socket điều khiển: liên kết chỉ có relay đóng; liên kết đang thẳng vẫn sống, relay của nó phải mở lại bằng `TermData` mới).
Khi agent khởi động lại, kết nối E2E của thiết bị đứt; peer thẳng của nó vẫn chạy trên data channel nhưng agent mới không còn biết liên kết đó. Client mở liên kết mới (relay hoặc offer mới) và `Attach` lại theo mục 4.
Peer cũ ấy bị agent mới đóng sau thời gian chờ (xem "Kết nối mồ côi" bên dưới), để một client im lặng không giữ window của phiên dùng chung (mục 5).

### Ghi chú cho client (rút ra khi viết client web)

- Daemon đóng kết nối khi đường thẳng đứt mà **chưa có đường relay nào mở** (`reason` `transport_closed`). Client mở liên kết relay ngay sau khi mở đường thẳng, không chờ tới lúc đường thẳng đứt.
- `conn_state direct` có thể đến nhiều hơn hai lần (ví dụ khi ICE chọn lại cặp ứng viên). Client xử lý mỗi lần là idempotent: chỉ cập nhật nhãn và `rttMs`.
- `Pong` của rào `Ping`/`Pong` khi đổi đường có thể quay về trên đường **kia**, không nhất thiết đường đã gửi `Ping`. Client khớp theo `clientMicros`, bất kể `Pong` đến bằng đường nào.

### Agent giám sát daemon

- Binary: `TUNELO_TERM_HOST_BIN`, rồi `<thư mục cấu hình>/term-host/bin/current/tunelo-term-host[.exe]`, rồi thư mục chứa binary agent. Bản mới được đặt sẵn ở `term-host/bin/next/` (bước tải của phase phát hành); agent chuyển `next` → `current` chỉ khi không có daemon nào chạy (trước khi khởi động daemon), nên cập nhật không cắt shell đang mở.
- Đơn vị giám sát riêng, agent ghi khi dùng terminal lần đầu (máy đã cài không cần cài lại) và chỉ ghi lại khi không có daemon chạy:
  - macOS: LaunchAgent `com.hoandat.tunelo.term-host`, `KeepAlive {SuccessfulExit: false}` (chạy lại sau khi sập, không chạy lại sau khi thoát sạch), `ProcessType Interactive`; khởi động bằng `launchctl kickstart`.
  - Linux: `~/.config/systemd/user/tunelo-term-host.service`, `Restart=on-failure`, `RestartPreventExitStatus=3`, `KillMode=mixed`, không có `[Install]` (agent `systemctl --user start` khi cần).
  - Windows: giá trị `tunelo-term-host` trong `HKCU\...\Run` chạy `run-term-host.vbs` → vòng `run-term-host.cmd` (khởi động qua WMI như vòng của agent); vòng dừng khi daemon thoát mã 0 hoặc 3, hoặc có tệp `stop-term-host`.
  - Nhật ký daemon: `<thư mục cấu hình>/term-host.log`. Đơn vị của agent không đổi.
- `tunelo stop` không đụng daemon. `tunelo uninstall` dừng agent, gửi `shutdown`, chờ daemon thoát (quá hạn thì SIGTERM rồi SIGKILL theo `pid` của `control.json`), gỡ đơn vị, và in số phiên còn mở nếu có.
- Sau mỗi lần nối: `hello` → `set_revoked` (khoá đầy đủ 32 byte trong danh sách thu hồi của `config.json`) → mới nhận `grant`. Thu hồi một thiết bị (`tunelo devices revoke` với tiền tố khoá, hoặc từ web): agent tìm khoá đầy đủ trong danh sách thu hồi và kết nối đang sống rồi gửi `revoke_device`.
- **Kết nối mồ côi**: sau mỗi `hello` thành công (khởi động hay nối lại), mọi kết nối trong `hello.connections` mà lần chạy này của agent **không giữ** là mồ côi. Agent giữ một kết nối khi nó đang định tuyến tới một liên kết, hoặc lệnh `grant` của nó đang chờ trả lời; kết nối do lần chạy này cấp và còn sống không bao giờ là mồ côi, kể cả qua nhiều lần nối lại.
  Sau **30 giây** (thời gian chờ để client kịp mở liên kết mới), agent gửi `conn_close` cho từng kết nối vẫn còn mồ côi; kết nối đã tự đóng trong lúc chờ (`conn_state closed`) hoặc vừa được lần chạy này cấp lại cùng id thì bỏ qua. Mỗi `hello` mới thay danh sách mồ côi và đặt lại thời gian chờ; không có kết nối điều khiển lúc hết giờ thì `hello` kế tiếp xét lại.
  Việc này không đụng phiên: PTY vẫn chạy, client `Attach` lại với offset đã áp dụng (mục 4). Dòng nhật ký đồng ý `close session <s> conn <c>` của kết nối bị đóng đến từ sự kiện `audit` của daemon như mọi lần đóng khác.
- Windows: agent (Bun/Node) **không kiểm SID** của tiến trình phía máy chủ named pipe như mục 6 mô tả, vì không có API cho việc này; agent dựa vào tên pipe ngẫu nhiên chỉ nằm trong `control.json` có DACL chỉ chủ tài khoản.

### Nhật ký đồng ý (audit)

Agent là nơi ghi duy nhất, một hành động `terminal`, chi tiết trong `detail`, không bao giờ có nội dung gõ hay đầu ra:
`open session <s> conn <c>`, `close session <s> conn <c>`, `denied (revoked) conn <c>` (daemon từ chối), `denied (not paired)` (agent từ chối), `dtls_failed conn <c>` (sự kiện `signal end` lý do `dtls_failed`).
Sự kiện `audit` của daemon được ghi một lần theo `seq` (đặt lại khi `pid` daemon đổi), kể cả `pendingAudit` trong kết quả `hello`, rồi `ack_audit`. Agent sập giữa lúc ghi và lúc ack thì có thể ghi trùng một dòng.

## 9. Kiểm tra tuân thủ

Daemon đi kèm **client không đầu** (không trình duyệt) cài đặt đúng file này; bộ kiểm thử tích hợp và bộ đo độ trễ của phase nghiệm thu dùng client đó. `tunelo term` sau này chỉ là client thứ hai trên cùng đặc tả.
