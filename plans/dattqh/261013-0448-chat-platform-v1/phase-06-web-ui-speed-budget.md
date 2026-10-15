---
phase: 6
title: "Phase 6: Web UI React 19 và ngân sách tốc độ"
status: in-progress
priority: P1
effort: "XL"
dependencies: [5]
principles: [2, 3, 1]
---

# Phase 6: Web UI React 19 và ngân sách tốc độ

<!-- Updated: Red Team 2026-10-13 - UI bot dựa trên reply_markup trong proto, allowlist scheme khi mở link, nhãn tích hợp cho tin từ webhook, perf gate có hồ sơ thiết bị native -->
<!-- Updated: Validation Session 2 2026-10-14 - màn hình đăng nhập chuyển sang IdP hoandat-auth, phiên đăng nhập + link /account, ui_locales -->
<!-- Updated: Validation Session 8 2026-10-14 - media hiển thị làm cùng Phase 4 (sau cùng) -->
<!-- Updated: Validation Session 9 2026-10-14 - UI lớn dần theo release, mỗi release duyệt mock tương ứng rồi lên prod -->

## Goal

Xây giao diện chat web bằng React 19 đạt cảm giác nhanh như Telegram, với ngân sách hiệu năng được đo tự động trong CI để không bị thoái lui.

## Context Links

- [Mock giao diện HTML](./mockups/index.html): mục lục 92 màn hình và trạng thái phủ mọi tính năng có giao diện trong plan, chia 11 trang theo nhóm tính năng; dùng token của hệ sinh thái (`mockups/tokens.css`, bản sao nguyên văn từ `hoandat-auth`). **Cổng:** user duyệt mock trước khi code UI; mọi thay đổi bố cục được thống nhất trên mock trước.
- [Kỹ thuật tốc độ client web](../reports/researcher-261013-1120-telegram-web-client-speed.md) — top-10 kỹ thuật
- [Client đa nền tảng](../reports/researcher-261013-1120-cross-platform-client.md) — mục 1, 4

## Key Insights

- Báo cáo xếp React 19 cuối về tốc độ thô; user đã chọn React. Bù lại bằng kỷ luật kiến trúc: React Compiler, store ngoài React, subscribe theo id bằng `useSyncExternalStore`, không dùng Context cho dữ liệu thay đổi nhanh.
- Lợi thế thật của Teact là scheduler: gom đọc DOM trước, ghi sau, trong mỗi frame; hoãn cập nhật UI khi đang chạy animation nặng.
- Message list chỉ giữ ~80–120 node; khi chèn lịch sử cũ phía trên, tắt `overflow-anchor` và khôi phục vị trí theo phần tử nhìn thấy.
- Chat list dùng hàng chiều cao cố định, định vị tuyệt đối.

## Requirements

Functional:
- Bộ lọc thư mục có sẵn (R1): Tất cả, Cá nhân, Nhóm, Bot, lọc phía client theo loại chat; thư mục tự tạo và đồng bộ giữa thiết bị làm sau R4.
- Nhóm có topic (R1): cột danh sách topic thay cho danh sách chat khi mở nhóm, khung chat theo topic, panel thông tin topic; cột thư mục bên trái và panel thông tin bên phải; tất cả theo mock `chat.html` và `desktop.html`.
- Màn hình: chào mừng với hai nút "Đăng nhập" và "Tạo tài khoản" bằng tài khoản hoandat (chuyển sang trang của IdP, không có form email hay mật khẩu trong app), danh sách chat, khung chat, composer (text, emoji, đính kèm, reply, edit), thông tin chat/người dùng, cài đặt cơ bản (bao gồm riêng tư), tìm kiếm (giao diện, nối API ở Phase 7).
- Formatting theo entities (bold, italic, code, pre, link, mention, spoiler…).
- Hiển thị media (inline thumb, kích thước cố định) làm cùng Phase 4 ở release R3; ở R1–R2 composer chưa có nút đính kèm.
- UI bot dựa trên `reply_markup` của `Message` (reply keyboard, inline keyboard + `PressInlineButton`, URL button), menu lệnh, nhãn `via_bot`; tin từ webhook hiển thị nhãn "Tích hợp: <tên>" không giả mạo được (`integration_label`).
- Reaction, album (`grouped_id`), ghim, trả lời, chuyển tiếp.
- Theme sáng/tối, đọc màu và tên từ `brand.config`; tên tenant (`displayName` từ IdP) hiện ở màn hình chào và cài đặt khi không phải tenant chính.
- Cài đặt → Phiên đăng nhập: danh sách phiên chat, thu hồi từng phiên hoặc mọi phiên khác, và link "Quản lý tài khoản hoandat" tới `/account` của IdP (đổi cách đăng nhập, gỡ quyền ứng dụng).
- i18n: tiếng Việt và tiếng Anh; gửi `ui_locales` khi chuyển sang IdP để trang đăng nhập cùng ngôn ngữ.

Non-functional (ngân sách, đo trong CI bằng Playwright + Chrome trace trên máy CI cố định):
- Cold start tới khi danh sách chat hiển thị từ cache: ≤ 400 ms trên laptop chuẩn, ≤ 1 s trên Android tầm trung (đo ở Phase 10).
- Mở chat từ cache: ≤ 100 ms p99.
- Cuộn 1.000 tin: không frame nào > 32 ms, trung bình ≥ 55 fps.
- JS initial (gzip) ≤ 150 KB; phần còn lại lazy load.

## Architecture

- `packages/ui`: component React; hook `useDialog(id)`, `useMessage(key)` bọc `useSyncExternalStore` trên event bus của `packages/core`.
- `packages/ui/src/scheduler`: `requestMeasure`/`requestMutation` theo frame.
- `packages/ui/src/virtual-list`: list tự viết, neo theo phần tử nhìn thấy, hỗ trợ chèn đầu và cuối.
- `apps/web`: Vite, code splitting theo route/màn phụ, preload chunk chat.

## Related Code Files

Create:
- `packages/ui/src/{components,hooks,scheduler,virtual-list,theme,i18n}/`
- `apps/web/{index.html,src/main.tsx,vite.config.ts}`
- `apps/web/perf/` (Playwright perf scenarios + ngưỡng)

## Implementation Steps

1. Thiết lập React 19 + React Compiler + Vite; lint rule cấm Context cho state thay đổi nhanh.
2. Hook subscribe hạt mịn trên event bus.
3. Scheduler đọc/ghi DOM theo frame.
4. Virtual list cho message (neo vị trí, chèn đầu/cuối, nhảy tới tin) và chat list (chiều cao cố định).
5. Composer + optimistic send; trạng thái pending/failed.
6. Render entities.
7. UI bot: reply keyboard, inline keyboard (callback), menu lệnh.
8. Theme + brand + i18n.
9. Bộ đo perf trong CI: cold start, mở chat, cuộn 1.000 tin, kích thước bundle; fail CI khi vượt ngưỡng. Chạy thêm hồ sơ CPU throttling 4× làm đại diện WebView tầm trung; đo thật trên thiết bị ở Phase 10/11.

## Todo

- [x] React 19 + Compiler + Vite (React Compiler bật mặc định từ 2026-10-15 trong `apps/web/vite-react.ts`; `REACT_COMPILER=0` để build hoặc test không có compiler khi cần so sánh)
- [x] Hook hạt mịn + scheduler (store ngoài React, `useSyncExternalStore` theo id, event bus gom theo frame)
- [x] Virtual list message + chat list (cửa sổ trượt tin nhắn, hàng chat cao cố định định vị bằng translateY)
- [x] Composer + optimistic send (trả lời, sửa, emoji, bỏ xem trước link)
- [x] Entities
- [ ] UI bot (R5)
- [ ] Người dùng mới (R3b, mock `chat.html#first-run`): hàng "Cloud của tôi" ghim đầu, mục "Lưu vào Cloud của tôi" trong menu tin, màn trống "Tạo nhóm và mời đồng đội" và "Nhắn cho một người", hộp link mời ngay sau khi tạo nhóm; lời mời ẩn khi đã có chat thứ hai
- [x] Theme/brand/i18n (vi/en, sáng/tối, brand.config)
- [x] Perf gate trong CI (job `web-perf` trong `.github/workflows/ci.yml`; chạy local bằng `pnpm perf`; ngưỡng ở `apps/web/test/perf/budgets.ts`)

Ghi chú perf gate và React Compiler (2026-10-15):

- Bundle: JS lúc khởi động sau đăng nhập (entry + `messaging-root` + `web-client` cùng import tĩnh của chúng) là 146,4 KiB gzip so với ngưỡng 150; CSS 13,7 KiB so với ngưỡng 20 (ngưỡng CSS tự đặt, plan chưa có).
- Trình duyệt (Playwright Chromium headless shell, trang `apps/web/test/visual/perf.html`, 1.000 chat, chat 5.000 tin): mở chat từ cache p50 17–18 ms, p99 29–33 ms; cuộn danh sách 1.000 chat và cuộn ngược 1.000 tin đều 60 fps, không frame nào quá 32 ms, không long task. Hồ sơ CPU chậm 4× chỉ báo số, chưa chặn CI. Ba lần chạy liên tiếp trên máy dev đều đạt.
- Chưa đo trong CI: cold start tới khi danh sách chat hiện từ cache (harness dùng SQLite trong bộ nhớ, không có cache bền), mở chat lần đầu khi cache chưa đủ tin, React Profiler (một tin mới chỉ render lại đúng item và dòng dialog), axe.
- Việc chặn bật React Compiler (đã gỡ, xem ghi chú 2026-10-15 bên dưới): (1) nhiều component đọc trạng thái thay đổi được thẳng từ `store`/`backend` lúc render sau một hook chỉ để ép render lại; compiler ghi nhớ các lệnh gọi đó nên UI cũ đi, 5 test messaging hỏng khi bật compiler. Cần chuyển mọi chỗ đọc sang hook subscribe theo id. (2) Compiler làm JS khởi động thành 165,8 KiB, vượt ngưỡng 150; cần tách bớt (ví dụ lazy Settings khỏi `messaging-root`, xem lại protobuf trong entry).

Ghi chú ngân sách JS và React Compiler (2026-10-15, sau R2):

- JS khởi động lúc R2 lên prod là 149,1/150 KiB. Phần lớn đến từ runtime protobuf và Connect trong entry (bootstrap `descriptor.proto`, registry, codec JSON) chỉ để gọi `GetSelf`.
- Đã tách:
  - `GetSelf` đi bằng JSON của Connect qua `fetch` (`apps/web/src/api/get-self.ts`).
  - Transport Connect-Web, schema sinh mã và các RPC tài khoản khác chỉ tải ở lần gọi đầu (`api/client.ts`, `api/account-client.ts`).
  - Mọi RPC đi qua một hàm `fetch` (`App rpcFetch`). Test và harness phục vụ RPC trong bộ nhớ qua `test/support/router-fetch.ts`, nên `GetSelf` trong test cũng đi qua codec JSON thật.
  - Kết quả: JS khởi động còn 112,5 KiB khi không có compiler (giảm 36,6 KiB).
- Code phía worker không nằm trong bundle chính: `sqlite-worker` và `sqlite3-worker1` là file riêng, không thuộc chunk khởi động. Settings, Moderation và các hộp thoại vốn đã lazy.
- Bật React Compiler: JS khởi động 130,7/150 KiB (entry 77,5; `messaging-root` 39,3). 176 test web đều qua khi bật compiler.
- `pnpm perf` trên máy dev khi bật compiler:
  - mở chat từ cache p50 18 ms, p99 32–38 ms (hai lần chạy);
  - cuộn danh sách chat và lịch sử 60 fps, không frame nào quá 32 ms, không long task;
  - hồ sơ CPU chậm 4×: p50 50–51 ms, p99 58–61 ms.

## Success Criteria

- Mọi ngưỡng ngân sách ở trên pass trong CI ba lần liên tiếp.
- React Profiler: nhận một tin mới chỉ render lại đúng item tin đó và dòng dialog tương ứng.
- Kiểm thử accessibility cơ bản (axe) không có lỗi mức critical.

## Verification

- `pnpm --filter @app/web build && pnpm --filter @app/web perf`
- `pnpm --filter @app/ui test`

## Risk Assessment

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| React re-render dây chuyền làm giật khi nhiều update | Cao | Subscribe theo id, perf gate trong CI, Profiler test |
| Bundle phình | Trung bình | Ngưỡng bundle trong CI, lazy load màn phụ |

## Security Considerations

- Render entities không dùng `dangerouslySetInnerHTML`; mọi URL (entity, nút) đi qua allowlist scheme của ADR 0004 trước khi mở; link mở với `rel="noopener noreferrer"` và cảnh báo link ngoài domain tin cậy.
- CSP chặt cho web app (Phase 13 cấu hình header).

## Rollback

UI chưa phát hành; tính năng mới đặt sau feature flag cấu hình khi đã có người dùng.

## Next Steps

UI lớn dần theo release: R1 nhắn tin, R2 webhook, R3 media, R4 tìm kiếm, R5 bot, R6 Mini App; Phase 10/11 bọc app ở R7/R8.
