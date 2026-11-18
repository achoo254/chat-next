# Chat Bridge: vận hành

Bridge chạy trong chính process `chat-api` (không có process hay app pm2 mới). Hướng dẫn người dùng: [`integrations/chat-bridge.md`](../integrations/chat-bridge.md); quyết định: [ADR 0022](../adr/0022-chat-bridge.md).

## Bật và tắt

Tắt mặc định. Bật bằng `/opt/chat/.env`:

```
BRIDGE_ENABLED=true
TELEGRAM_API_ID=<số>
TELEGRAM_API_HASH=<chuỗi 32 ký tự>
```

rồi `pm2 startOrReload /opt/chat/infra/ecosystem.config.cjs --only chat-api --update-env`. `TELEGRAM_API_ID` và `TELEGRAM_API_HASH` phải đặt cùng nhau (thiếu một thì server không khởi động); không đặt cả hai thì Bridge chạy nhưng không có ứng dụng nào để kết nối. `BridgeService` trả `bridge_disabled` khi cờ tắt. Env nằm trên iCloud `ENV production/chat-next/telegram-api.env`, không bao giờ trong repo.

Gửi từ Chat không có cờ riêng: mỗi chat tự bật bằng `external_chats.direction` (`both`), chat mới mặc định `both`. **Tắt khẩn cấp việc gửi** mà vẫn giữ đồng bộ đọc:

```sql
UPDATE external_chats SET direction = 'in';
UPDATE external_outbox SET status = 'cancelled' WHERE status IN ('pending', 'sending', 'failed', 'unknown');
```

(chạy sau khi sao lưu DB; tin đã sang Telegram giữ nguyên ở đó). Gỡ `BRIDGE_ENABLED` thì cả đồng bộ lẫn gửi dừng.

**Hoàn tác** là gỡ `BRIDGE_ENABLED` (hoặc đặt `false`) và reload: loop dừng, phiên Telegram còn lại trong DB nhưng không ai dùng. Dữ liệu đã nhập giữ nguyên (chat chỉ đọc); muốn xoá thì ngắt kết nối kèm xoá chat ở Cài đặt, hoặc xoá tài khoản.

## Dữ liệu

Migration `0044_external_outbox.sql` thêm bảng `external_outbox` (hàng đợi gửi, không chứa nội dung tin: engine đọc tin theo `chat_id`, `seq` lúc gửi). Migration `0042_chat_bridge.sql` chỉ thêm: bảng `external_accounts`, `external_chats`, `external_users`, `external_messages`, `external_tombstones`, `external_logouts`, cột `users.external_source` và trigger xoá tài khoản. Binary trước chạy được trên schema mới. Không có chiều xuống cần chạy khi rollback code (xem [Hoàn tác](#bật-và-tắt)); `activate-release.sh` sao lưu DB trước khi migrate. Danh mục dữ liệu: [`privacy/data-inventory.md`](../privacy/data-inventory.md).

## Khoá

Phiên Telegram niêm phong bằng `SESSION_KEY` (nhãn riêng, AAD gắn id tài khoản, chủ và ứng dụng). Xoay khoá theo [`key-rotation.md`](./key-rotation.md): `reseal` in dòng `resealed bridge account secrets`; secret không mở được (`unreadable`) thì tài khoản đó phải đăng nhập lại.

## Theo dõi

Log có `component=bridge` kèm `external_account_id` và `source`; không có số điện thoại, mã, khoá phiên hay nội dung tin (khoá `phone`, `session`, `auth_key`, `phone_code_hash`, `message_text` bị che). Lỗi gần nhất của từng tài khoản (tối đa 512 ký tự) hiện ở trang Kết nối ứng dụng. Trạng thái tài khoản (`active`, `needs_login`, `stopped`):

```sql
SELECT id, owner_id, source, status, last_error, lease_until FROM external_accounts;
SELECT account_id, external_chat_id, chat_id, history_window, backfill_done FROM external_chats;
SELECT count(*) FROM external_logouts;   -- đăng xuất đang chờ của tài khoản đã xoá
```

- Hàng đợi gửi (mỗi chat một hàng, theo thứ tự): xem việc đang chờ hoặc hỏng bằng
  ```sql
  SELECT status, op, count(*), max(attempts) FROM external_outbox GROUP BY status, op;
  SELECT chat_id, seq, op, status, attempts, last_error, updated_at FROM external_outbox
    WHERE status IN ('failed', 'unknown') ORDER BY id DESC LIMIT 20;
  ```
  Trạng thái: `pending` (chờ lượt hoặc chờ thử lại), `sending` (đang gửi), `sent`, `failed` (Telegram từ chối hoặc hết 10 lần thử: người dùng thấy và chọn gửi lại hay xoá), `unknown` (đang gửi dở quá 10 phút trước khi server chạy lại; chỉ người dùng quyết), `cancelled`. Một dòng kẹt `sending` hơn 10 phút tự thành `unknown`.
- Gửi cách nhau tối thiểu 0,7 giây mỗi tài khoản; FloodWait và SLOWMODE làm cả tài khoản dừng gửi đúng số giây được báo. Phiên bị thu hồi giữ nguyên hàng đợi, đăng nhập lại là gửi tiếp.
- Một tài khoản chỉ nối từ một process nhờ `lease_holder`/`lease_until` (hết hạn sau 1 phút không gia hạn).
- Mất kết nối: engine nối lại sau 1 s, gấp đôi tới 5 phút; tin sửa, xoá và tin đến lúc tắt về từ trạng thái update đã lưu.
- FloodWait của Telegram: engine chờ đúng số giây rồi tiếp tục. Giữa hai lần gọi lịch sử có nghỉ 300 ms.
- `differenceTooLong` (tắt quá lâu): engine nhập lại cửa sổ lịch sử của các chat đã đồng bộ (tin đã có được bỏ qua).
- Telegram báo phiên bị thu hồi: tài khoản sang `needs_login`, người dùng đăng nhập lại ở Cài đặt.
