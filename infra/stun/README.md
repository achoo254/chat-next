# STUN trên máy chủ dùng chung

Dịch vụ `stun-responder` (mã ở [`apps/stun`](../../apps/stun)) trả lời yêu cầu STUN Binding trên UDP 3478 để trình duyệt và `tunelo-term-host` biết địa chỉ công khai của mình
(ứng viên `srflx` của ICE). Địa chỉ dùng: `stun:tunnel.hoandat.com:3478`, trùng mặc định `DEFAULT_STUN` của `apps/term-host/src/nic.rs`. `tunnel.hoandat.com` là bản ghi DNS-only
trỏ thẳng vào máy chủ gốc nên không cần đổi DNS.

Phạm vi cố ý hẹp: chỉ Binding, trả đúng một thuộc tính XOR-MAPPED-ADDRESS; không TURN, không xác thực, không trả lỗi, không lưu gì. Gói không hợp lệ bị bỏ im lặng.
Mỗi địa chỉ nguồn được trả tối đa 20 lần mỗi giây; bảng theo dõi nguồn có trần 65 536 mục (vài MB) nên luồng giả mạo nguồn không làm phình bộ nhớ.
Chỉ dùng thư viện chuẩn của Rust; binary tĩnh musl khoảng 350 KB.

## Thành phần trên máy chủ

| Thứ | Chi tiết |
|---|---|
| Người dùng `stun` | Người dùng hệ thống, không home, shell `nologin` |
| `/usr/local/bin/stun-responder` | root:root 755 |
| `/etc/systemd/system/stun-responder.service` | Chạy dưới `stun`, nghe `0.0.0.0:3478/udp`, sandbox systemd (không capability, `ProtectSystem=strict`, `MemoryMax=32M`, `TasksMax=4`) |
| Log | journald, `journalctl -u stun-responder`: một dòng khi khởi động, một dòng tổng kết mỗi giờ (số đã trả lời, bị giới hạn, bị bỏ) |

Tường lửa: script **không đổi gì**, chỉ in trạng thái (firewalld, chính sách INPUT của iptables, luật nào nhắc tới UDP hoặc 3478). Dịch vụ chỉ nhận được gói từ Internet khi
tường lửa máy chủ và nhà cung cấp để UDP 3478 đi vào.

## Triển khai

**Bình thường: chạy workflow `stun-deploy`** (`gh workflow run stun-deploy.yml`, rồi `gh run watch`). Đây là ngoại lệ duy
nhất của quy tắc deploy mỗi lần push (`docs/deploy-standard.md` của workspace `hoandat-app`), vì stun ít đổi và không có
app phía sau. Workflow build binary musl x86_64 trên CI, upload bằng user `chat-deploy` vào
`/opt/chat/incoming/stun-<id>` rồi chạy `sudo /usr/local/sbin/stun-activate-incoming <id>`
([`activate-incoming.sh`](activate-incoming.sh): `flock` trên `/run/stun-activate.lock`, kiểm bundle, rồi
`install-on-server.sh` như dưới). Cài lệnh đó một lần bằng root: `install -m 755 infra/stun/activate-incoming.sh
/usr/local/sbin/stun-activate-incoming`; sudoers của `chat-deploy` có sẵn dòng cho nó (`infra/chat/setup-deploy-user.sh`).

**Dự phòng khi CI hỏng:** chạy trên máy dev (không build trên máy chủ). Script từ chối cây chưa sạch và commit chưa lên
`origin/main`, rồi đi qua cùng `stun-activate-incoming`. Cần `cargo` có target `x86_64-unknown-linux-musl` (hoặc `aarch64-…` theo máy chủ) và, ngoài Linux, `cargo-zigbuild` + `zig`.

```bash
SSH_TARGET=<user>@<SERVER_65_IP> SSH_OPTS="-i <key> -p <SSH_PORT> -o IdentitiesOnly=yes" bash infra/stun/deploy.sh
# hoặc qua công cụ SSH của lab (lệnh từ xa là đối số cuối, stdin được chuyển tiếp):
REMOTE_SHELL="<đường dẫn>/lab-ssh.sh 65" bash infra/stun/deploy.sh
```

Script hỏi kiến trúc máy chủ (`uname -m`), build vào thư mục tạm (đặt `TMPDIR` để chọn chỗ, xoá khi xong), gửi binary, unit và
[`install-on-server.sh`](install-on-server.sh) qua một phiên SSH. Phía máy chủ: từ chối nếu UDP 3478 đã bị chương trình khác giữ, tạo người dùng `stun` nếu chưa có,
chạy thử `--version`, cài, `enable` + `restart`, rồi in trạng thái dịch vụ, cổng, tường lửa và `free -m` trước/sau. Chạy lại an toàn (chỉ khởi động lại chính dịch vụ này).
`STUN_BIN=<binary linux có sẵn>` để bỏ bước build.

## Kiểm tra

```bash
python3 infra/stun/stun-probe.py                       # mặc định tunnel.hoandat.com:3478, 8 yêu cầu
python3 infra/stun/stun-probe.py 127.0.0.1:3478 --count 3
```

In địa chỉ được ánh xạ và thời gian khứ hồi từng yêu cầu. Địa chỉ in ra phải trùng địa chỉ công khai mà một dịch vụ HTTPS bên ngoài thấy từ cùng máy.

## Quay lui

```bash
systemctl disable --now stun-responder
rm -f /usr/local/bin/stun-responder /etc/systemd/system/stun-responder.service
systemctl daemon-reload
userdel stun   # tuỳ chọn
```

Không có bản ghi DNS hay luật tường lửa nào cần hoàn tác.
