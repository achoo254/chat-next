# ADR 0012: Endpoint MCP cho công cụ AI

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-25
- Bổ sung cho [ADR 0006](./0006-sign-in-and-chat-sessions.md): thêm một cách xác thực thứ ba (access token của IdP) và một ngoại lệ có kiểm soát cho quy tắc "đăng nhập IdP trong 10 phút gần nhất".

## Bối cảnh

Người dùng muốn cho công cụ AI (Claude Code và các client MCP khác) đọc, gửi tin nhắn và quản lý bot của mình, kể cả webhook của bot, như Localman MCP đã làm cho Localman. App chat chỉ có phiên riêng (cookie web, bearer native), không nhận access token của IdP. Đặt webhook, cấp lại token bot và xoá bot cần một lần đăng nhập IdP trong 10 phút gần nhất, điều mà token MCP sống lâu và tự làm mới không chứng minh được.

## Quyết định

### Endpoint và xác thực

- `https://chat.<domain>/mcp`, MCP Streamable HTTP không trạng thái (Go SDK `github.com/modelcontextprotocol/go-sdk`), trả JSON, mỗi request một message JSON-RPC (batch bị từ chối), tối đa 1 MiB.
- Chỉ nhận `Authorization: Bearer` với access token của IdP: JWT ES256, `typ: at+jwt`, `iss` là `OIDC_ISSUER`, `aud` chứa `CHAT_PUBLIC_URL/mcp`, chưa hết hạn, có `sub` và `client_id`. Xác minh offline bằng JWKS của IdP (`auth.IdP.VerifyAccessToken`); không dùng cookie, không gọi IdP ở mỗi request.
- Protected Resource Metadata (RFC 9728) ở `/.well-known/oauth-protected-resource` và `/.well-known/oauth-protected-resource/mcp`: `authorization_servers` là IdP, `scopes_supported` là năm scope dưới đây. Client MCP tự đăng ký (DCR) ở IdP rồi xin token với `resource=https://chat.<domain>/mcp`; phía IdP xem `auth-next/docs/integration-guide.md` mục 9.
- Thiếu token: 401 kèm `WWW-Authenticate` trỏ tới metadata và bốn scope cơ bản. Token sai: 401 `invalid_token`. Gọi tool thiếu scope: 403 `insufficient_scope` kèm scope cần xin (step-up); bước đọc trước này từ chối body không phải đúng một object JSON (400), và mỗi tool vẫn tự kiểm scope của nó (kiểm chính, trả lỗi tool `insufficient_scope`). Request có `Origin` lạ: 403. Mỗi tài khoản IdP tối đa 120 request một phút.
- `sub` của token là `idp_sub` của người dùng chat. Tài khoản chưa từng đăng nhập chat (chưa có người dùng) nhận lỗi `chat_account_required` ở mỗi tool; tài khoản đang chờ xoá nhận `account_pending_deletion` như ở `/rpc`.

### Scope và tool

| Scope | Tool |
|---|---|
| `chat:read` | `get_me`, `list_chats`, `get_chat`, `get_chat_members`, `get_messages`, `search_messages`, `search_users`, `resolve_username`, `get_users`; tin nhắn: `get_pinned_messages`, `get_message_reactions`, `get_message_readers`; nhóm: `get_invite_links`, `get_forum_topics`; danh bạ: `get_contacts`, `get_blocked_users`, `get_common_chats`; webhook đến: `list_incoming_hooks`, `get_incoming_hook`, `get_incoming_hook_stats`, `list_incoming_hook_dead_letters`, `get_incoming_hook_audit` |
| `chat:write` | `send_message`, `start_private_chat`, `edit_message`, `delete_messages`, `mark_read`, `set_reaction`; tin nhắn: `forward_messages`, `copy_message`, `pin_message`, `unpin_message`, `unpin_all_messages`; nhóm và kênh: `create_group`, `create_channel`, `add_members`, `remove_member`, `update_chat_info`, `leave_chat`, `export_invite_link`, `revoke_invite_link`, `create_forum_topic`, `edit_forum_topic`, `set_admin`, `set_member_permissions`; danh sách chat của chính người dùng: `set_dialog_mute`, `set_dialog_pinned`, `set_dialog_unread_mark`; danh bạ: `add_contact`, `delete_contact`, `block_user`, `unblock_user`; webhook đến: `update_incoming_hook`, `set_incoming_hook_enabled`, và hai bước: `create_incoming_hook`, `rotate_incoming_hook_secret`, `revoke_previous_hook_secret`, `take_over_incoming_hook`, `delete_incoming_hook` |
| `bots:read` | `list_bots`, `get_bot_delivery`, `list_bot_dead_letters` |
| `bots:write` | `create_bot`, `update_bot`, `retry_bot_dead_letters`, `discard_bot_dead_letters` |
| `bots:admin` | `set_bot_webhook`, `delete_bot_webhook`, `reset_bot_token`, `delete_bot` |

- Tool gọi chính các handler của `/rpc` trong cùng tiến trình (`rpc.InProcess`, `rpc.Invoke`), với phiên dựng từ người dùng của token. Kiểm thành viên, quyền sở hữu bot, hạn mức, validate và hợp đồng id (ADR 0001) vì thế giống hệt app; MCP không đọc hay sửa được gì mà người dùng không làm được trong app.
- Webhook đến (`IntegrationsService`) dùng `chat:read`/`chat:write` chứ không có scope riêng: handler chỉ cho admin của nhóm hay kênh, như trong app. Tool trả URL bí mật (tạo, xoay vòng, tiếp quản), làm URL ngừng chạy (thu hồi URL cũ, xoá) đi hai bước với `confirm_token` như `bots:admin` (mục dưới); bản xem trước không bao giờ chứa URL. Các tool này không cần đăng nhập IdP gần đây vì `/rpc` cũng không đòi.
- Không có tool `DeleteChat`: xoá nhóm hay kênh cho mọi thành viên không hoàn tác được, mà `chat:write` không có cảnh báo riêng lúc cấp quyền; người dùng xoá trong app. Ngoài phạm vi MCP: đăng nhập, push, realtime, cấu hình, góp ý, quyền riêng tư và xoá tài khoản, Mini App và inline, kiểm duyệt, tải media.
- Kết quả là JSON của message protobuf (tên trường theo proto, id 64-bit xuất thành số). Lỗi là kết quả tool `{"error":{"code","message"}}` với mã Connect như `/rpc`.

### Ngoại lệ cho `bots:admin`

Bốn tool `bots:admin` thay quy tắc "đăng nhập IdP trong 10 phút" bằng hai lớp:

1. Scope `bots:admin` không bao giờ được cấp ngầm: client DCR phải khai nó lúc đăng ký, xin nó (thường qua step-up khi gọi tool), và trang consent của IdP hiện cảnh báo đỏ riêng cho nó (giống `credentials:write` của Localman).
2. Mỗi lần gọi đi hai bước: lần đầu không thay đổi gì, trả bản xem trước (bot, URL webhook hiện tại và mới, hệ quả) cùng `confirm_token`; lần hai gửi lại đúng các tham số kèm `confirm_token`. Token là HMAC (khoá dẫn từ `SESSION_KEY` bằng HKDF) gắn với người dùng, tên tool và toàn bộ tham số, sống 5 phút, dùng một lần (danh sách đã dùng giữ trong bộ nhớ của tiến trình api).

Lần gọi đã xác nhận chạy handler `/rpc` với `AuthTime` là lúc xác nhận, nên `ResetBotToken` (kèm gỡ webhook), `DeleteBot` và `SetBotWebhook` giữ nguyên logic của app.

## Lý do

- Dùng lại handler `/rpc` giữ một nguồn sự thật cho quyền và giới hạn; MCP chỉ là lớp chuyển đổi mỏng.
- Token JWT gắn audience cho phép xác minh offline như mọi resource server khác của IdP, IdP chậm hay sập không chặn MCP đang chạy (token sống 15 phút).
- Quy tắc 10 phút bảo vệ trước phiên bị đánh cắp; với MCP, lớp tương đương là người dùng tự duyệt `bots:admin` trên trang consent có cảnh báo và từng thao tác phải qua bản xem trước. Người dùng chọn phương án này (25/10/2026) thay vì chỉ cho xem webhook hoặc buộc kết nối lại MCP mỗi 10 phút.

## Hệ quả

- Công cụ AI được cấp `chat:read` đọc được nội dung các cuộc trò chuyện của người dùng và gửi chúng tới nhà cung cấp AI do người dùng chọn; trang consent của IdP ghi rõ quyền đọc tin nhắn và đánh dấu client là ứng dụng bên ngoài, người dùng thu hồi ở `/account` của IdP (token đang có còn hiệu lực tối đa 15 phút).
- Prompt injection vào công cụ AI đã có `bots:admin` vẫn có thể đổi webhook nếu công cụ tự gửi bước xác nhận mà không hỏi người dùng; giới hạn này được chấp nhận cùng với cảnh báo đỏ lúc cấp quyền.
- Hoạt động qua MCP không tính là phiên đang dùng cho việc tự xoá tài khoản không hoạt động.
- Hạn mức và `confirm_token` nằm trong bộ nhớ tiến trình: hợp với một tiến trình api; khi chạy nhiều tiến trình cần chuyển sang kho dùng chung (Redis) như `ratelimit` đã dự kiến.

## Cách thay đổi

- Thêm tool: thêm vào `server/internal/chatmcp/tools_*.go` với scope phù hợp, gọi qua `rpc.InProcess` (service chưa có trong đó thì thêm vào `rpc.NewInProcess`); tool ghi mới thuộc scope sẵn có không cần đổi scope ở IdP, nhưng câu mô tả scope trên trang consent (`auth-next/src/i18n/messages/*/consent.ts`) nên theo kịp.
- Thêm scope: khai ở IdP trước (`auth-next/src/oidc/resources.ts`, `CHAT_MCP_SCOPES`, câu trên consent), deploy IdP, rồi mới dùng ở chat.
- Đổi đường dẫn `/mcp` hay domain: đổi resource ở IdP (`tenant-resources.ts`) cùng lúc; client MCP đã kết nối phải kết nối lại.

Nguồn: `server/internal/chatmcp/`, `server/internal/auth/access_token.go`, `server/internal/rpc/in_process.go`, test `server/internal/api/mcp_test.go`.
