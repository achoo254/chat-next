# ADR 0010: Tenant theo domain

- Trạng thái: Đã chấp nhận
- Ngày: 2026-10-14

## Bối cảnh

Hệ sinh thái hoandat có tenant theo domain (ADR 0006 của `hoandat-auth`): người dùng của domain `<d>` đăng nhập ở `https://auth.<d>`, và dữ liệu của họ tách khỏi `hoandat.com`. Tenant chính là `hoandat.com`; tenant đầu tiên ngoài nó là `inetdev.io.vn`. App chat phải phục vụ các tenant này từ v1. Thêm `tenant_id` sau khi đã có dữ liệu thì phải migrate mọi bảng, nên đây là contract dữ liệu phải chốt từ đầu. Nội dung bên thứ ba (Mini App, file tải lên) không được chạy cùng site với app, nếu không request từ nội dung đó sẽ mang cookie của app.

## Quyết định

### Host

`<d>` là domain của tenant, với tenant chính là `hoandat.com`.

| Host | Việc |
|---|---|
| `chat.<d>` | Web app, RPC, WebSocket, callback OIDC, back-channel logout, deep link `/b/<username>`, Bot API ở `/bot/v1/`, incoming webhook ở `/hook/` |
| `b<bot_id>.{{miniapp_domain}}` | Origin riêng cho từng Mini App |
| `{{media_domain}}` | Media |

- Bot API và incoming webhook là đường dẫn trên `chat.<d>`, không có host riêng (quyết định 2026-10-15): Universal SSL miễn phí của Cloudflare chỉ phủ một cấp dưới `<d>`, nên host hai cấp như `bot.chat.<d>` được proxy sẽ lỗi TLS.
- Host của tenant nằm trong `chat.<d>` và `*.chat.<d>` (một cấp), cùng quy ước với `localman.<d>` và `*.localman.<d>` của hệ sinh thái, nên dùng chung cơ chế cấp chứng chỉ theo tenant.
- Mini App và media nằm trên domain đăng ký riêng, dùng chung cho mọi tenant, cố ý không nằm dưới `<d>`. `bot_id` duy nhất trên toàn hệ thống nên origin Mini App không trùng giữa các tenant.
- `{{media_domain}}` không dùng cookie; token tải xuống mang `tenant_id` và chủ thể, và edge từ chối token của tenant bị đình chỉ.

### Dữ liệu

- `tenant_id` có từ migration đầu tiên trên `users`, `chats`, `bots`, `incoming_hooks`, `invite_links` và mọi chỉ mục unique liên quan: `(tenant_id, idp_sub)`, `(tenant_id, username)`, invite link, username của bot.
- Không có chat, tin, bot hay tìm kiếm xuyên tenant. Thêm thành viên khác tenant bị từ chối ngay trong truy vấn kiểm quyền. Tài liệu tìm kiếm mang `tenant_id` và mọi truy vấn lọc thêm theo tenant của người gọi, làm lớp phòng thủ thứ hai.

### Chọn tenant

- Tenant được chọn theo Host ở lớp ngoài cùng, trước mọi handler. Host lạ, tenant bị đình chỉ, hoặc tenant chưa bật chat ở trang `/admin` của IdP đều nhận `421`.
- Gateway WebSocket đòi tenant của phiên trùng tenant suy từ Host. Incoming webhook gọi tới host của tenant khác trả 404.
- Web không có bước chọn tenant vì Host đã quyết định. Mobile và desktop là một bản app cho mọi tenant: mặc định `chat.hoandat.com`, và "Đăng nhập bằng domain khác" nhận `<d>` để dùng `chat.<d>`. Push mang `tenant_id` để mở đúng DB và chat.

### Tra cứu tenant qua IdP

- Backend tra tenant, discovery và JWKS qua API nội bộ của IdP (`/internal/tenants/lookup?host=`, `/internal/tenants/<id>`, cùng JWKS và discovery theo tenant), xác thực bằng Basic credentials riêng của vai `chat`. Khi chạy chung server với IdP, API này đi qua loopback.
- Kết quả được cache theo tenant, dùng bản cũ khi IdP lỗi, chỉ cache âm khi IdP trả 404. Backend không phân giải `auth.<d>` qua DNS công khai của tenant.
- Tenant chính `hoandat.com` được cấu hình tĩnh và không cần IdP lúc chạy.
- Secret của client `chat-web` cho mỗi tenant tự tính bằng `base64url(HMAC-SHA256(<khoá app chat-web>, tenantId))`, giống Localman và Tunelo. Khoá app do IdP suy ra và giao một lần; nó nằm trong secret store, không vào repo hay log.

### Bật chat cho một tenant

Một tenant chỉ được phục vụ khi chủ tenant bật chat ở `/admin` của IdP và thêm bản ghi DNS A cho `chat.<d>` và `*.chat.<d>` (DNS-only). Chứng chỉ được cấp qua hàng đợi provisioner của hệ sinh thái; nginx chọn chứng chỉ theo SNI.

## Lý do

- Chọn tenant theo Host khớp với cách IdP và các app khác trong hệ sinh thái đã làm, nên người dùng của `<d>` thấy mọi app dưới cùng domain của họ.
- `tenant_id` ngay từ đầu rẻ hơn rất nhiều so với migrate về sau, và cho phép mọi truy vấn kiểm quyền lọc tenant trong cùng câu SQL.
- Domain của tenant do người khác giữ DNS; tin DNS công khai cho discovery và JWKS là để người giữ DNS giả IdP.
- Cùng registrable domain với `chat.<d>` là same-site, nên request từ Mini App hay file media sẽ mang cookie `SameSite` của app. Domain đăng ký riêng cắt đường đó.
- Suy secret bằng HMAC cho phép tenant mới chạy mà không cần cấu hình tay ở cả hai phía.
- `421` nói đúng nghĩa: request tới sai server cho Host đó, không phải lỗi xác thực.

## Hệ quả

- Mọi bảng mới có danh tính hoặc chỉ mục unique theo người dùng phải có `tenant_id` ngay khi tạo.
- Bộ test có ma trận tenant: không API nào (client, Bot API, webhook, tìm kiếm, presence) trả dữ liệu của tenant khác.
- Kiểm duyệt tách theo tenant; chủ tenant (`ownerSubs` từ API nội bộ) kiểm duyệt được trong tenant của mình.
- Phía IdP phải có: host `chat.<d>` và `*.chat.<d>` trong quy ước host của tenant, cờ bật chat theo tenant, chặn nhãn `chat` khi nhận domain, và credentials API nội bộ cho vai `chat`. Đây là thay đổi ở repo `hoandat-auth`.
- Host của đăng nhập trong [ADR 0006](./0006-sign-in-and-chat-sessions.md) đều nằm dưới `chat.<d>`; allowlist `Origin` theo tenant suy từ bảng Host ở trên.

## Cách thay đổi

- Thêm host mới cho tenant: giữ trong `*.chat.<d>` một cấp để dùng chứng chỉ sẵn có; cập nhật mẫu host trong `brand.config.json` ([ADR 0008](./0008-branding-and-naming.md)) và quy ước host phía IdP.
- Không chuyển Mini App hay media vào dưới `<d>`; muốn đổi domain thì chọn một domain đăng ký riêng khác.
- Khi backend rời server dùng chung với IdP, API nội bộ không còn trên loopback: cần kênh có xác thực (WireGuard hoặc mTLS) hoặc chuyển IdP cùng sang cụm, lên plan ở cả hai repo.
- Đổi công thức suy secret cần đổi đồng thời ở IdP; xoay khoá gốc phía IdP xoay mọi secret suy ra cùng lúc.

Nguồn: [plan nền tảng chat v1, phần contract](../../plans/dattqh/261013-0448-chat-platform-v1/phase-01-contracts-foundation.md)
