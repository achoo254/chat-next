# R5 lát A — Bot trên web (+ sửa "Cloud của tôi")

Ngày 2026-10-15. Chưa commit, không đụng production, không sửa `server/` hay `proto/`.

## Đã làm — bot

- **Developer Console** (`apps/web/src/messaging/bots/console.tsx` + `console.css`, nạp lười): link "Developer Console" trong Cài đặt → `/console`. Có danh sách "Bot của tôi" (bảng; dưới 1100px thành thẻ), trạng thái rỗng và giới hạn 20 bot. Trang tạo bot (`/console/new`) kiểm username khi gõ: ký tự, hậu tố "bot", độ dài; kiểm trùng qua `ResolveUsername` có debounce và gợi ý tên khác. Có ô mô tả và công tắc chế độ riêng tư. Lỗi `username_taken`, `bots_limit` và `resource_exhausted` (giới hạn tốc độ tạo) đều hiện bằng tiếng Việt. Mỗi bot có ba tab:
  - **Hồ sơ**: tên, mô tả, giới thiệu, chế độ riêng tư, xoá bot có hỏi lại.
  - **Token**: hiện một lần kèm cảnh báo, nút Sao chép, ghi chú "server chỉ giữ hash"; bấm "Tôi đã lưu token" thì token bị che. Cấp lại có hỏi lại. Có dòng chỉ đọc giải thích long poll kèm `GET …/bot/v1/updates`.
  - **Lệnh**: ba phạm vi (Mọi chat riêng / Mọi nhóm / Admin nhóm), báo lỗi dưới từng ô, xem trước "Người dùng thấy". Danh sách `default` mà bot đặt qua API được giữ nguyên khi lưu.
- **Đăng nhập lại**: khi gặp `reauth_required`, modal "Đăng nhập lại để tiếp tục" dẫn tới `/auth/login?reauth=1&return_to=/console/<id>/<tab>?after=token|delete`. `signInUrl` trong core có thêm `reauth`, và server đã hỗ trợ `return_to`. Khi quay về, `after=token` tự cấp token (người dùng đã bấm trước khi đi đăng nhập); `after=delete` mở lại hộp xác nhận xoá. Tham số được xoá khỏi URL ngay, nên tải lại trang không cấp thêm token.
- Theo đúng yêu cầu, **không hiện** webhook, dead-letter, số liệu gửi, Mini App, tầng rate limit hay SDK, kể cả dưới dạng placeholder.
- **Deep link** `/b/<username>?start=…` (`bot-link-dialog.tsx`): gọi ResolveUsername rồi GetBotInfo, hiện hộp "Mở <bot>" kèm đúng lệnh `/start …`. Đồng ý thì gọi StartBot (có random_id) và mở chat; Huỷ thì không gửi gì. Link bot nằm trong tin nhắn được mở ngay trong app. `returnPathFor` giữ `?start=` cho người chưa đăng nhập. Dev server proxy thêm `/bot/` với `changeOrigin: false`, vì Bot API chỉ trả lời đúng host của tenant.
- **Chat riêng với bot** (`bot-chat.tsx`, nạp lười):
  - Chat chưa có tin: hiện thẻ hồ sơ bot (mô tả, lệnh, ghi chú đồng ý) và nút "Bắt đầu" thay ô soạn tin; nút này gọi StartBot với tham số rỗng.
  - Ô soạn tin có nút menu lệnh và menu mở khi gõ "/" (↑↓ chọn, Tab điền, Enter gửi, Esc đóng).
  - Bàn phím trả lời lấy từ tin mới nhất của bot có markup: bấm phím gửi đúng chữ trên phím, bàn phím một lần tự ẩn, có nút ẩn/hiện, có placeholder; `remove` gỡ bàn phím.
  - Tiêu đề chat ghi "@username · bot"; tin của bot trong nhóm có nhãn `bot`.
- **Nút inline** (`message-item.tsx`): nút callback bấm vào thì hiện spinner và "Đang chờ bot"; các nút khác vẫn bấm được. Câu trả lời hiện bằng toast, hoặc hộp thoại khi bot gửi `show_alert`. `url` trong câu trả lời đi qua `openLink`. `timed_out` hiện "Bot không phản hồi". Nút URL vẫn giữ hộp "Mở link ngoài?" như trước.
- **Core**: `MessageButton.callbackData` (base64) nằm trong JSON `buttons`. Thêm `Message.keyboard` (`ReplyKeyboard`) và migration local **9** (`messages.reply_keyboard`). Purge xoá cột này khi thu hồi tin.

## Đã làm — "Cloud của tôi" (scope bổ sung)

1. "Xoá toàn bộ tin nhắn" ở cột thông tin và menu danh sách mở hộp riêng cho Cloud (tiêu đề, ghi chú, nút "Xoá toàn bộ", toast theo mock). Màn hình vẫn ở lại Cloud. `packages/core/src/sync/apply.ts`: khi nhận `chat_updated` cho saved chat thì gọi `ensureDialog`, nên Cloud không bị ghim vẫn còn trong danh sách sau chuỗi `chat_deleted` → `chat_updated` mà server mới gửi. Lịch sử bị purge trên mọi phiên.
2. Placeholder "Ghi chú vào Cloud của tôi" (có cả bản tiếng Anh).
3. Thao tác nhanh của Cloud chỉ còn Ghim/Bỏ ghim.
4. Biểu cảm trong Cloud chỉ hiện emoji và số đếm (`pillContent(..., saved)`).
5. Xem trước ảnh/video trong danh sách chat: ô vuông `pv-thumb` 18px dùng inline thumbnail, rồi đến caption, hoặc "Ảnh"/"Video" khi không có caption. Không có thumbnail thì không hiện ô. File và tin thoại giữ nguyên dạng chữ.

**Phụ thuộc**: hành vi "Cloud vẫn ở đầu danh sách" cần thay đổi server của backend agent (giữ `pin_rank`, giữ dialog, rồi gửi `chat_deleted` → `chat_updated` → `pinned_dialogs` nếu đang ghim). Phía client đã xử lý đúng chuỗi update đó và có test. Không có workaround ghim lại ở client.

## Bằng chứng kiểm thử

- `pnpm lint`: eslint `--max-warnings=0` không lỗi, không cảnh báo; `check-brand: no hard-coded product name`.
- `pnpm typecheck`: 6/6 project `Done`.
- `pnpm test`:
  - core: 23 file, 758 test pass. Mới: `bot-markup.test.ts` (3), `saved-chat-clear.test.ts` (1, đã thử fail khi bỏ phần sửa).
  - web: 23 file, 245 test pass. Mới: `bots.test.tsx` (16), `cloud.test.tsx` (5).
  - platform-web: 17 test pass; brand: 7 test pass.
- `pnpm perf`: tất cả budget đạt; startup JS 140,8 KB / 150 (trước đó 138,2), CSS 16,2 KB / 20; mở chat p50 19 ms, p99 40 ms.
- `pnpm e2e`: 17/17 pass. Kịch bản mới `bots.e2e.ts`: tạo bot trong Console → Cấp token → đăng nhập lại thật qua fake IdP → token hiện một lần → bot gọi `GET /me` → deep link `/start hello` → bot long poll nhận update → gửi bàn phím inline → người dùng bấm → bot nhận callback và trả lời → người dùng thấy toast → bàn phím trả lời một lần → bot nhận "staging".
- Kiểm hình (Playwright trên e2e stack, 1333x780 và 390x844, 14 màn mỗi kích thước): không phần tử nào cuộn ngang. Màn đã kiểm: Console, lỗi khi tạo, đăng nhập lại, token, lệnh, hồ sơ, bảng, deep link, nút đang chờ, câu trả lời, bàn phím trả lời, menu lệnh, Bắt đầu. Các màn Cloud chỉ được kiểm bằng test jsdom, chưa chụp hình.
- gitleaks: diff và các file mới đều "no leaks found". Hai cảnh báo `generic-api-key` nằm ở `apps/web/test/app.test.tsx:40` và `messaging-units.test.ts:151`; đây là file đã commit trước đó (`7a8f061`), tôi không sửa.

## Bổ sung sau quyết định của Jev

1. **Ô soạn tin bot ở màn hẹp**: mock `bots.html#reply-keyboard` được cập nhật trước (thêm một câu). Dưới 760px, khi chat có bàn phím của bot (có nút ẩn/hiện bàn phím), ô soạn tin ẩn nút biểu cảm; người dùng dùng emoji của bàn phím hệ thống. Placeholder luôn một dòng, dài thì cắt bằng "…" ở mọi ô soạn tin (`textarea:placeholder-shown` nowrap + ellipsis). Đo bằng Playwright ở 390x844 và 1333x780: ô soạn tin cao 44px (một dòng), không phần tử nào cuộn ngang, emoji ẩn ở 390 và vẫn hiện ở 1333.
2. **Trạng thái "đã ẩn" của bàn phím được lưu vào SQLite local**: migration **10** thêm cột `messages.keyboard_hidden`. Đây là cột riêng, nên bản tin từ server (sửa tin, tải lịch sử) không ghi đè. Thêm `ChatCore.setKeyboardHidden` (qua worker, `CORE_METHODS`) và trường `ReplyKeyboard.hidden`. Nút ẩn/hiện và việc bấm phím của bàn phím một lần đều lưu lại. Ảnh chụp xác nhận sau khi tải lại trang bàn phím vẫn ẩn, nút "Hiện bàn phím của bot" vẫn còn. Lớp bot đọc tin chứa bàn phím qua `useItem`, vì React Compiler giữ kết quả cũ nếu chỉ tính từ `store`. Unit test mới trong `bot-markup.test.ts`: trạng thái ẩn giữ qua lần sửa tin của bot và qua khởi động lại, sau đó hiện lại được.

Kiểm thử lại:
- `pnpm lint`: không lỗi, không cảnh báo; brand check sạch.
- `pnpm typecheck`: 6/6 project `Done`.
- vitest `--maxWorkers=2`: core 23 file, 759 test pass; platform-web 17 test pass; web 23 file, 245 test pass.
- `pnpm perf`: tất cả budget đạt; startup JS 140,8 KB, CSS 16,2 KB, p50 19 ms, p99 29 ms.
- `pnpm e2e`: chạy một lần ở cuối, 17/17 pass.

## Vấn đề / câu hỏi mở

1. Menu lệnh gộp của các bot trong nhóm làm ở lát sau (theo quyết định của Jev).
2. Hai cảnh báo gitleaks ở file đã commit từ trước; giữ nguyên theo chỉ đạo.

Status: DONE
Summary: Đã làm xong Console, deep link, Bắt đầu, menu lệnh, bàn phím trả lời và nút inline, năm sửa cho Cloud, và hai sửa của Jev (ô soạn tin bot ở màn hẹp, lưu trạng thái ẩn bàn phím). lint, typecheck, test, perf, e2e đều pass.
Concerns/Blockers: Hành vi giữ Cloud trong danh sách dựa vào thay đổi server của backend agent (client đã xử lý chuỗi update và có test).
