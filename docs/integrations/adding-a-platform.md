# Thêm một nền tảng chat vào Chat Bridge

Hướng dẫn cho người viết adapter của một nền tảng khác (Zalo, Slack, Discord, Matrix…). Mô hình nằm ở [ADR 0023](../adr/0023-chat-bridge-feature-model.md); ở đây là các bước và checklist.

## Cần viết gì

Một adapter là một thư mục `server/internal/bridge/adapters/<tên>/` cài các interface của `server/internal/bridge/adapter.go`, rồi thêm vào bảng adapter ở nơi dựng server. **Không sửa engine, bảng cơ sở dữ liệu hay giao diện.** Giao diện đọc danh sách tính năng từ adapter nên tự có bảng đúng.

1. **`bridge.Adapter` (bắt buộc):** `Name`, `Capabilities`, `Login`, `Logout`, `ListConversations`, `Backfill`, `Subscribe`, `FetchMedia`. `Name` là khoá của mọi dòng `external_*`, không đổi sau khi phát hành.
2. **Khai báo tính năng bằng `bridge.Featured`:** `Features() map[feature.Feature]feature.Support`, với `In` là đọc được thay đổi của nền tảng và `Out` là Chat thay đổi được nền tảng. Tính năng không có thì **không ghi vào bản đồ** (đừng ghi cả hai `false`). Adapter không cài `Featured` thì tính năng được suy từ `Capabilities` và các interface cài (cho adapter cũ).
3. **Cài interface của từng tính năng khai báo:**

| Tính năng | `In` cần | `Out` cần |
|---|---|---|
| `messages` | `Backfill`, `Subscribe` (sự kiện `Message`, `Edit`, `Delete`) | `bridge.Sender` (`SendMessage` idempotent theo `RandomID`, `EditMessage`, `DeleteMessages`) và `CapSend` |
| `pins` | `bridge.PinReader.ListPinned`, sự kiện `Pin` | `bridge.Pinner.PinMessage` và `bridge.Sender` |
| `topics` | `bridge.TopicReader.ListTopics`, sự kiện `Topic`, `Conversation.Forum`, `Message.Topic` | `bridge.Pinner.PinTopic` (hiện chỉ ghim topic) |
| `read` | sự kiện `Read` (người kia đã đọc) và `Seen` (chủ đọc ở thiết bị khác) | `bridge.ReadWriter.MarkRead` |
| `dialog` | `bridge.DialogReader`, sự kiện trạng thái hội thoại | `bridge.DialogWriter` (tắt tiếng, ghim hội thoại, đánh dấu chưa đọc) |
| `info` | `bridge.InfoReader` | `bridge.InfoWriter` (tên, mô tả) và `bridge.TopicWriter` cho sửa topic |
| `members` | `bridge.MemberReader` (cả quyền riêng từng người) | `bridge.MemberWriter` (xoá, admin), `bridge.MemberAdder`, `bridge.PermWriter` |
| `invites` | `bridge.InviteManager.ListInvites` | `CreateInvite`, `RevokeInvite` |
| `lifecycle` | không có | `bridge.GroupLifecycle` (`LeaveGroup`, `DeleteGroup`) |
| `alerts` | không cần interface: Chat báo cho tin mới của `messages` khi tính năng này nhận | không có |

`Capabilities` phải khớp: `CapSend` đúng khi `messages.Out`, `CapPins` đúng khi có ghim, `CapTopics` đúng khi `topics.In`. Bộ kiểm hợp đồng bắt chỗ lệch.

## Quy tắc mọi tính năng phải theo

- **Idempotent:** làm lại điều đã đúng là thành công, không lỗi (ghim cái đã ghim, bỏ ghim cái chưa ghim). Engine gọi lại khi không chắc lần trước đã tới.
- **Lỗi có phân loại:** thiếu quyền, bị chặn, kênh không cho → bọc `bridge.ErrNotAllowed`; quá hạn sửa → `ErrEditExpired`; tệp quá lớn → `ErrTooLarge`; bị giới hạn tốc độ → `*bridge.RateLimitError{RetryAfter}`; phiên bị thu hồi → `ErrSessionRevoked`. Mọi lỗi khác được thử lại có giới hạn.
- **Id ngoài là chuỗi mờ.** Lõi không phân tích id tin, hội thoại hay topic.
- **Mọi thay đổi vào Chat là đặt trạng thái**, nên sự kiện vọng lại từ chính thay đổi Chat vừa gửi không tạo thay đổi thứ hai. Nếu nền tảng đẩy lại cả sự kiện do bạn gửi, bình thường; nếu không đẩy, cũng bình thường.
- **Không in nội dung tin, tên người hay token vào log.**
- **Tính năng R3 (thành viên, link mời, rời và xoá nhóm):** engine lo xác nhận, nhật ký, hạn mức và đọc lại để trả về khi bị từ chối; adapter chỉ làm việc và phân loại lỗi (`ErrNotAllowed` cho thiếu quyền, người không cho thêm, v.v.).

## Chạy bộ kiểm hợp đồng

```go
func TestMyAppConformance(t *testing.T) {
	contracttest.Run(t, func(t *testing.T) contracttest.Subject {
		// Adapter bắt buộc. Account, Conversation và MessageIDs (mới nhất trước,
		// ít nhất ba) cho các nhóm cần một nền tảng thật hoặc giả.
		return contracttest.Subject{Adapter: myAdapter}
	})
}
```

- Nhóm **declaration** không cần tài khoản: kiểm lời khai khớp với interface và `Capabilities`. Chạy được trong CI.
- Nhóm **messages** và **pins** cần một hội thoại thật hoặc giả; chạy khi `Subject` có `Conversation` và `MessageIDs`, và chỉ chạy phần adapter khai báo.
- `contracttest.NewFake(tên)` là nền tảng giả: `.Support(feature, feature.Support{In, Out})` đổi bộ tính năng để thử engine với một nền tảng khác Telegram mà không viết adapter.

## Checklist trước khi phát hành

- [ ] `Features()` chỉ khai báo những gì chạy thật; bộ kiểm declaration pass.
- [ ] Bài thử trực tiếp (kiểu `*_live_test.go`, chạy tay, cổng bằng biến môi trường) cho từng tính năng và có ghi kết quả vào plan.
- [ ] Giới hạn tốc độ và lỗi quyền được dịch đúng loại lỗi.
- [ ] Phiên đăng nhập được niêm phong bằng `SecretBox`, không lưu mật khẩu hay mã.
- [ ] Hàng nghiệm thu mới trong `docs/acceptance.md` và mục trong `docs/integrations/chat-bridge.md` cho nền tảng.
