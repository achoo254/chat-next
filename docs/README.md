# Tài liệu

Thư mục này giữ phần "vì sao" và "ở đâu" của dự án. Cách làm cụ thể nằm trong code, test, `proto/` và `spec/`; khi tài liệu và nguồn đó lệch nhau, nguồn đó đúng và tài liệu phải sửa.

## Quyết định kiến trúc (ADR)

Mỗi ADR trong [`adr/`](./adr/) ghi một quyết định mà sửa về sau phải migrate dữ liệu hoặc phá vỡ client, cùng lý do, hệ quả và cách thay đổi an toàn.

| ADR | Tóm tắt |
|---|---|
| [0001 Sơ đồ định danh](./adr/0001-id-scheme.md) | Mọi id lộ ra ngoài nhỏ hơn 2^53; tin nhắn lộ ra bằng `(chat_id, seq)`, Snowflake chỉ dùng nội bộ. |
| [0002 Đồng bộ update](./adr/0002-sync.md) | `pts` theo người dùng, `chat_pts` cho chat `large`, `GetDifference`/`GetChatDifference`, `too_long`, `server_epoch` và các quy tắc đồng bộ phía client. |
| [0003 Outbox](./adr/0003-outbox.md) | Log outbox ghi trong cùng transaction, partition theo ngày, enum `kind` đầy đủ, cursor theo consumer, giao ngay sau commit cộng sweeper. |
| [0004 Định dạng văn bản](./adr/0004-text-format.md) | `text + entities[]` với offset UTF-16, allowlist scheme URL, giới hạn độ dài theo code point. |
| [0005 Fold tiếng Việt](./adr/0005-vietnamese-fold.md) | Một hàm bỏ dấu có đặc tả và test vector dùng chung cho TypeScript và Go. |
| [0006 Đăng nhập và phiên chat](./adr/0006-sign-in-and-chat-sessions.md) | Đăng nhập chỉ qua `auth-next`; phiên chat riêng của app nhưng chết theo grant của IdP. |
| [0007 Topology client](./adr/0007-client-topology.md) | Web chạy sync và SQLite trong worker; native chạy sync trên main thread và đẩy việc nặng xuống native theo lô. |
| [0008 Branding và đặt tên](./adr/0008-branding-and-naming.md) | `brand.config.json` là nguồn duy nhất cho tên, màu, scheme, domain. |
| [0009 Lưu trữ local](./adr/0009-local-storage.md) | SQLCipher trên native, cache không mã hoá trên web, dữ liệu local tách theo `(tenant, user)`. |
| [0010 Tenant theo domain](./adr/0010-tenants-by-domain.md) | Bị thay thế 24/10/2026 bởi [ADR 0013 Đơn tenant](https://github.com/achoo254/auth-next/blob/main/docs/decisions/0013-single-tenant.md) của `auth-next`: chỉ còn `hoandat.com`; giữ cột `tenant_id` = `primary`, Mini App và media trên domain đăng ký riêng. |
| [0011 Phiên native, bearer và CORS](./adr/0011-native-sessions-bearer-cors.md) | App iOS/Android đổi code qua `ExchangeNativeCode`, xác thực bằng bearer (hello ở `/ws`), CORS và origin WebView chỉ cho bearer, không bao giờ cho cookie. |
| [0012 Endpoint MCP](./adr/0012-mcp-endpoint.md) | `/mcp` cho công cụ AI, xác thực bằng access token của IdP (`aud` = `/mcp`), tool gọi lại handler của `/rpc`; `bots:admin` (webhook, token, xoá bot) cần scope riêng có cảnh báo và mã xác nhận hai bước thay cho đăng nhập lại 10 phút. |
| [0013 AI Agent (máy riêng)](./adr/0013-remote-machines.md) | Chat với claude trên máy riêng từ thiết bị khác: tiến trình nền trên máy, relay Tunelo, mã hoá đầu-cuối Noise KK, tài khoản là gốc tin cậy cả hai chiều (khoá thiết bị gắn phiên, thu hồi dứt điểm, chứng minh sở hữu khoá, tối đa 24 giờ khi Chat sập); MCP `tunelo` trong phiên claude và quyền ghi qua lần cấp duyệt. |
| [0014 Tunelo, tiến trình máy](./adr/0014-tunelo-machine-agent.md) | `tunelo` gộp CLI Tunelo, một lần đăng nhập cho tunnel/Chat/Localman, máy theo tài khoản (`tunelo login` đăng ký có chứng minh khoá, không mã cài), cây lệnh gọn có lệnh ẩn, `logout`/`uninstall`, profile Claude và đăng nhập từ xa, Localman gọi `localhost` của máy qua `/.tunelo/forward`. |
| [0015 Thông báo bảo mật từ IdP](./adr/0015-account-notices-from-idp.md) | `POST /api/account-notices`: IdP gửi thông báo bảo mật bằng token tự ký (`client_id` `auth-account-notices`, scope `account-notices`), Chat chuyển qua bot trợ lý; `204` cả khi không có người dùng để IdP không dò được tài khoản. |
| [0016 Xoá tài khoản chỉ ở IdP](./adr/0016-account-deletion-at-idp.md) | Chat không còn luồng xoá, giữ 30 ngày hay tự xoá; IdP gửi SET `account.deleted` tới `POST /api/idp/account-deleted` (kiểm JWKS, `typ: secevent+jwt`, `aud` = URL endpoint), Chat xoá ngay, nhóm và kênh chuyển cho người vai trò cao nhất rồi vào sớm nhất, bot bị xoá; `202` cả khi `sub` không có. |
| [0017 AI Agent không gắn với một AI](./adr/0017-provider-neutral-ai-agent.md) | Không AI mặc định, capability thay rẽ nhánh theo id, tài khoản theo từng AI, Antigravity qua `agy acp`. |
| [0018 Văn phòng của phiên AI](./adr/0018-office-view-babylon-normalized-agent-stream.md) | Bị thay thế 23/11/2026 bởi ADR 0027. Toà nhà 3D Babylon.js (bản 2D khi không có WebGL) vẽ từ luồng hoạt động agent chuẩn hoá trên máy; chỉ tên tool, phòng, số đếm rời máy. |
| [0019 Tầng sinh hoạt và trò chuyện](./adr/0019-office-living-floor-and-resident-talks.md) | Bị thay thế 23/11/2026 bởi ADR 0027. Nhân vật sống 24/7 theo lịch giờ người xem, bỏ tan ca, trò chuyện viết sẵn điền bằng dữ kiện chuẩn hoá, ngủ gật khi kẹt. |
| [0021 Văn phòng một mặt bằng và cache tài sản](./adr/0021-office-single-plan-and-asset-cache.md) | Bị thay thế 23/11/2026 bởi ADR 0027. Bốn khu trên một mặt bằng, bỏ thang máy và thanh tầng, tài sản bake theo khu, cache bền ở máy người xem |
| [0027 Quan sát bằng Live Map](./adr/0027-observatory-live-map.md) | Live Map 2D PixiJS thay văn phòng 3D: mỗi chuyển động là một sự kiện thật của dòng thời gian Observatory trên máy, trạm tính trong bộ lọc riêng tư, khung sự kiện không mang nội dung, rảnh 0 khung hình, cấm nới CSP, điểm nghẽn là quy tắc ở agent. Phần hình ảnh thay bởi ADR 0029. |
| [0029 Live Map là thành phố số](./adr/0029-observatory-cyber-city.md) | Thành phố isometric vẽ 100% bằng AI offline, khu đang làm sáng lên bằng lớp sáng cắt từ bản "bật đèn"; thẻ hoạt động tách Runtime khỏi p95 lịch sử, không phần trăm giả; camera theo hành động với ba chế độ; rảnh ≤ 20 khung/giây, 0 khi giảm chuyển động; agent theo dõi CI GitHub sau push. |
| [0020 Cố vấn (Jev)](./adr/0020-advisor-mascot-jev.md) | Mascot trên mọi màn, ngữ cảnh copy chỉ gửi khi người dùng đính, phiên Cố vấn chỉ đọc do tunelo ép theo (máy, thư mục, AI), Jev bằng khoá TypeSafe BYOK trên máy, chế độ tự động theo phiên. |
| [0026 MCP của phiên qua HTTP loopback](./adr/0026-session-mcp-over-loopback-http.md) | Dịch vụ tunelo tự phục vụ MCP cho phiên nó mở trên `127.0.0.1`, xác thực bằng vé phiên nằm trong biến môi trường (không argv); bỏ tiến trình `tunelo mcp` khoảng 45 MB mỗi phiên, stdio còn làm dự phòng và cho ACP. |
| [0022 Chat Bridge](./adr/0022-chat-bridge.md) | Đưa chat của ứng dụng khác (Telegram trước) vào Chat, và gửi từ Chat sang đó theo từng chat: adapter Go, người dùng ảo, đường ghi nội bộ `ImportTx`, khoá chống trùng, không tải thêm lịch sử cũ. |

Đổi một quyết định: viết ADR mới mang số kế tiếp, ghi ADR cũ là "Bị thay thế bởi ADR NNNN" trong dòng trạng thái, và làm theo mục "Cách thay đổi" của ADR cũ.

## Đặc tả

- [Fold tiếng Việt](../spec/vi-fold/SPEC.md): đặc tả và bộ test vector mà bản TypeScript và Go cùng phải pass.
- [Bot API](../spec/bot-api/openapi.yaml) (OpenAPI 3.1, kèm [`format.md`](../spec/bot-api/format.md)); bắt đầu nhanh cho người viết bot: [`bot-api/`](./bot-api/README.md) (token, long poll, webhook, kiểm chữ ký HMAC).
- [Menu Cài đặt](./settings-menu.md): mọi mục mở trong khung Cài đặt (menu luôn còn), mục có trang con dùng tab ngang, biểu mẫu là trang chứ không phải hộp thoại; quy tắc cho mục thêm sau này.

## Quyền riêng tư

- [Danh mục dữ liệu cá nhân](./privacy/data-inventory.md): dữ liệu app chat giữ, nơi lưu, thời hạn, cơ sở pháp lý (Nghị định 13), xuất và xoá dữ liệu.
- [Trang chính sách công khai](./privacy/legal-pages-draft.md) (`/privacy`, `/terms`, `/delete-account`): Jev duyệt phát hành 20/10/2026, từng khẳng định kèm nguồn và các mục còn thiếu.

## App mobile

- [App iOS và Android](./mobile-app.md): build, chạy, luồng đăng nhập, khác web và phần chưa làm.
- [Hồ sơ store](./store/listing.md): nội dung App Store và Google Play, nhãn quyền riêng tư, Data safety, xếp hạng tuổi, ghi chú cho người duyệt, ảnh chụp màn hình và việc người sở hữu còn phải làm.

## Vận hành

- [Xoay vòng khoá](./operations/key-rotation.md): đổi `SESSION_KEY` không đăng xuất ai (`SESSION_KEY_PREVIOUS`, role `reseal`), đổi secret OIDC, mật khẩu database, và các khoá không được đổi.

## Kế hoạch

Kế hoạch triển khai và nhật ký quyết định nằm ở [`plans/dattqh/261013-0448-chat-platform-v1/plan.md`](../plans/dattqh/261013-0448-chat-platform-v1/plan.md). Đó là bản ghi theo thời điểm, không phải tài liệu thường trực; khi plan và ADR khác nhau, ADR là quyết định hiện hành.
