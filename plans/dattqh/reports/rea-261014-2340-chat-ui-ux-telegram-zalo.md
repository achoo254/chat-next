# REA — UI/UX của Telegram Desktop và Zalo PC: mẫu nên mượn cho app chat

- Ngày: 2026-10-14 (Asia/Saigon). Phạm vi: **chỉ phân tích tĩnh** gói cài trong `/Applications`. Không gắn vào app đang chạy, không đọc thư mục dữ liệu người dùng, không chụp màn hình.
- Định hướng đã chốt (Jev): **Telegram là tham chiếu chính** (0,94); **mượn mẫu quen thuộc của Zalo** để người Việt đỡ phải học lại (0,78); **không mượn Discord** (0,41).
- Mục tiêu app: **đơn giản, nhanh, gọn**. Các quyết định đã có và phải giữ: danh bạ tự thêm (không tự sinh từ chung nhóm), có chủ đề (topics), có kênh, không feature flag, không nhãn lộ trình trong UI, không cuộn ngang.
- Báo cáo kiến trúc Telegram trước đó: `rea-261014-1200-telegram-desktop-architecture.md` (dùng lại Evidence của nó, chỉ bổ sung bằng chứng UI/UX).

## 0. Bằng chứng và giới hạn

| ID | Nguồn | Nội dung |
|---|---|---|
| **Z0** | REA `analyze_javascript_application` (detail=summary) trên `/Applications/Zalo.app/Contents/Resources/app.asar` (Zalo 26.10.11, sha256 `b9206da1de64023d2e5575e39a7ecc0624b9ed1b809314e7b792581c63a2d7d6`) | Parent Evidence `ev_50b7297b488944c05ed2a57011fbcbde78fce10b8335fe9d3653875b0312d44e`; view tóm tắt `ev_d9136c73a6865009728ef313f84b6e2f9eaeb514b472aff776db6b98f0252581`; trang module `ev_f700344c6756be7bc5f7033938ed684f13c04b97d524b1c68cdc9eda334c055e`. 155 file liên quan, 112 file JS parse được, 0 lỗi parse. Coverage **partial**: các bundle lớn (`pc-dist/compact-app-pc.*.js`, `pc-dist/lazy/5x.*.js`) vượt ngân sách kết quả nên quan hệ chỉ giữ trên node file. Integrity mismatch chỉ ở các addon `.node` nằm trong `app.asar.unpacked` (bình thường với Electron). |
| **Z0-T** | REA `trace_application_feature` (seed chuỗi `short-cut-list`) | `ev_68f9b7fd4b8dd9582ef5e0cd2e4e4795e6025b5f850e3432869a47bd444e7fc9`: **no-match**. Graph của REA không giữ literal trong bundle lớn, nên phần chuỗi/CSS bên dưới đọc trực tiếp từ byte của file (Z1–Z4). |
| **Z1** | Header ASAR (13.172 mục) đọc bằng script tĩnh | 54 chunk lazy trong `pc-dist/lazy/`, 31 file worker; ngôn ngữ tách thành chunk riêng `lang-vi.*.js`, `lang-en.*.js`. |
| **Z2** | `pc-dist/lazy/lang-vi.9fe41fe2b3e18f5a9c87.js` sha256 `7164a8fa1c2bd0596d2bd355ee24b46d6a2a99af9fe4e79ccabb168e99b2c805`; `lang-en.2fa20604566d177537e2.js` sha256 `b1d30cd9716029b725daa1563f47ee5619e37ceebaf663159cd3f54e7d7cc398` | Bảng i18n 6.409 khoá ở mỗi ngôn ngữ. Trích dẫn dạng `KHOÁ` = "giá trị vi". |
| **Z3** | `pc-dist/compact-app-pc.847a8145140c1c296fa0.css` sha256 `90b466729173a1dbc76229ee0ce9bc0429c0dabff582fd961f613ce6be40793b` | 868 biến CSS; khối `:root,:root .light` có 418 biến. Trích dẫn dạng selector/biến. |
| **Z4** | `pc-dist/compact-app-pc.847a8145140c1c296fa0.js` sha256 `f3c70e516e77696557954ff100443d537baccd0c7a5c61ed758e354fd8e9b70f` | Bundle renderer chính (20,7 MB). Trích dẫn dạng offset byte hoặc chuỗi định danh. |
| **T0** | Báo cáo trước, Evidence `ev_e92380557ae0528ec07cd7d6022ea5722597548aa92f473b3c5d07e2315c1135`, binary sha256 `1a3c87057ae4ea810cd886ee31033cc52fac408523f9d555684d1339ea1ec227` | Kiểm kê chuỗi `tg-strings.txt`; trích dẫn `L<n>` = số dòng trong file đó. |
| **T1** | Khối chuỗi mặc định UTF-16LE trong binary Telegram, offset file 169.380.698–169.899.984 (259.643 ký tự) | Toàn bộ giá trị tiếng Anh mặc định nối liền (không có tên khoá). Ký tự `\x10` đánh dấu tham số. **Không có tiếng Việt** (0 kết quả cho "Tiếng Việt", "Trả lời"). |
| **T2** | Bảng phím tắt UTF-16LE, offset 236.569.270–236.571.622 | Tên lệnh (`search`, `previous_chat`, `next_chat`, `show_archive`, `read_chat`, `archive_chat`…) và tổ hợp phím mặc định (`ctrl+f`, `alt+up`, `ctrl+1`…). |
| **T3** | `Telegram.rcc` sha256 `d061713182dbf05f929ae2ec4b7308ec0eaa64d46f6e187d4326712cbb106d64`, mục `/gui/day-blue.tdesktop-theme` (zip → `colors.tdesktop-theme`, 394 dòng) và `/misc/default_shortcuts-custom.json` | Bảng màu theme ngày mặc định; file phím tắt người dùng tự sửa. |

**Giới hạn chung.** Mọi kết luận là đọc tĩnh. Có chuỗi chỉ chứng minh tính năng/nhãn **tồn tại** trong gói, không chứng minh nó đang bật, hiển thị ở đâu, hay theo thứ tự nào trên màn hình. Telegram là Qt native: hằng số layout (độ rộng cột, chiều cao hàng) được biên dịch thành số nên **không đọc được** từ chuỗi; báo cáo không đoán các số đó. Thiếu một chuỗi không chứng minh tính năng không có. Không session REA native nào được mở (`binary_session`: `open=false`), nên không có gì cần đóng.

Ký hiệu trong từng mục: **[QS]** quan sát trực tiếp, **[SL]** suy luận, **[CB]** chưa biết.

---

## 1. Bố cục tổng thể và điều hướng

**Telegram.**
- [QS] Có cả hai kiểu bày thư mục: "Tabs on the left" và "Tabs at the top" (T1, cạnh nhau trong khối chuỗi); source `ui/widgets/chat_filters_tabs_slider.cpp` (L204396), `chat_filters_tabs_strip.cpp` (L209441), `window/window_filters_menu.cpp` (L209863).
- [QS] Có "Archived chats", "Saved Messages", "All Chats" làm đích điều hướng nhanh (T1, T2: `show_archive`, `self_chat`, `all_chats`).
- [CB] Độ rộng cột danh sách và breakpoint thu gọn: không đọc được từ binary.

**Zalo.**
- [QS] Thanh rail trái `#main-tab{width:64px}`, nền xanh đậm `--layer-background-navbar-normal:#005ae0`, mỗi tab cao 56px (`.leftbar-tab{height:56px}`) (Z3).
- [QS] Định danh tab trong renderer: `div_Main_TabMsg`, `div_Main_TabCT`, `div_Main_TabToDo`, `div_Main_Tab_zCloud`, `div_Main_TabScreenshot`, `div_Main_TabTool`, `div_Main_TabSetting` (Z4). [SL] Tương ứng: Tin nhắn, Danh bạ, To-Do, Cloud, Chụp màn hình, Công cụ, Cài đặt.
- [QS] Cột danh sách `--nav-width:408px`, có tay kéo đổi rộng (`cursor:ew-resize; left:calc(var(--nav-width) - 4px)`) (Z3).
- [QS] Header cột 68px (`header{height:68px}`), thanh tiêu đề danh sách tính bằng `calc(100vh - 68.5px)` (Z3).
- [QS] Khung tin có mức thu gọn `compactLv` với ngưỡng 540px và 720px (Z4, hook `max-width`); CSS có media query 909/1170/1306/1368/1596/1824px (Z3).

**Người Việt đã quen.** Rail trái có 2 mục lớn nhất là "Tin nhắn" và "Danh bạ" (Zalo). Phím Alt+1/Alt+2 chuyển giữa hai mục này (xem §15).

**Khuyến nghị.** Giữ bố cục 3 cột + rail 64px như mock hiện có (`--rail-w:64px`, trùng với Zalo). Rail chỉ chứa: các bộ lọc/thư mục chat, **Danh bạ**, **Cài đặt** (như mock `chat.html#app`). Không thêm To-Do/Cloud/Công cụ (không thuộc phạm vi, và trái tinh thần "gọn"). Cho phép kéo đổi rộng cột danh sách (280–420px, mặc định 320–360px) như Zalo; không bao giờ để nội dung tràn ngang. Màn hẹp dùng hàng tab ở trên (Telegram "Tabs at the top") như mock đã làm.

**Xung đột.** Mock `chat.html#app` và `desktop.html#three-pane` có nút "Sửa thư mục" mờ kèm nhãn/toast "có sau R4" → trái quyết định "không nhãn lộ trình". Phải bỏ hẳn nút này cho tới khi có tính năng thật.

## 2. Danh sách chat: hàng, bộ lọc, menu

**Telegram.**
- [QS] Menu chuột phải hàng chat có các mục: "Pin/Unpin", "Mark as unread/Mark as read", "Archive/Unarchive", "Mute/Unmute", "Delete" (T1: đoạn "PinUnpinMark as unreadMark as read", "MuteUnmutePinUnpinReadUnreadArchiveUnarchiveDelete").
- [QS] Có "Archive and Mute" tự động cho người lạ (T1).
- [QS] Hàng chat của nhóm có chủ đề hiển thị danh sách chủ đề (`dialogs/ui/dialogs_topics_view.cpp`, L206669); có "Topics layout" để chọn cách hiện chủ đề (T1).
- [QS] Có giới hạn số chat ghim (chuỗi "Unpin some of the currently pinned…", T1).

**Zalo.**
- [QS] Hàng chat: `.conv-item{margin:4px 8px;border-radius:6px;padding:0 8px}` nằm trong hàng ảo hoá; hover hiện nút "…" 20px (`.conv-item:hover .conv-action__popup`) (Z3).
- [QS] Tab "Ưu tiên" / "Khác" (`STR_TAB_CONV_FOCUS`, `STR_TAB_CONV_OTHER`) có chấm đỏ báo tin mới (Z4); menu lọc có "Chưa đọc" (`STR_UNREAD_LABEL`) và "Phân loại" (`STR_LABEL_CLASS`) (Z2, Z4).
- [QS] Thuật ngữ menu: "Ghim hội thoại" / "Bỏ ghim", "Đánh dấu chưa đọc", "Đánh dấu đã đọc", "Tắt thông báo" / "Bật thông báo", "Ẩn trò chuyện", "Xóa hội thoại" (Z2).
- [QS] Trạng thái đang gõ trong danh sách: "đang soạn tin" (`STR_TYPING`) (Z2).

**Người Việt đã quen.** "Tắt thông báo" (không phải "tắt tiếng"), "Đánh dấu chưa đọc", "Ghim". Lọc "Chưa đọc" là thao tác hằng ngày ở cả hai app.

**Khuyến nghị.**
- Menu hàng chat (theo Telegram, chữ theo Zalo): Ghim / Bỏ ghim · Đánh dấu đã đọc / **Đánh dấu chưa đọc** · Tắt thông báo ▸ (1 giờ, 8 giờ, 1 ngày, cho tới khi bật lại) · Xoá chat (khi có). Hiện nút "…" khi hover như Zalo để người không quen chuột phải vẫn tìm được.
- Bộ lọc có sẵn: giữ Tất cả · Cá nhân · Nhóm · Bot; **xin duyệt thêm "Chưa đọc"** (lọc ở client, không cần server) — đây là mở rộng phạm vi nhỏ nên cần chủ app đồng ý.
- Không làm "Ưu tiên/Khác" của Zalo (cần phân loại tự động, không hợp "đơn giản").
- Không mượn "Lưu trữ" (Archive) ở bản này: thêm một khái niệm mới; nếu cần ẩn chat ít quan trọng thì "Tắt thông báo" đã đủ.

## 3. Header khung chat

**Telegram.** [QS] Có widget top bar riêng (`history_view_top_bar_widget.cpp`, L206977); trạng thái: "online", "last seen recently/within a week/a long time ago", "{n} members, {n} online", "is typing", "connecting…" (T1). Có "Search messages", "Chat menu" (T1).

**Zalo.** [QS] Header cao 68px (Z3). Trạng thái: "Đang hoạt động" (`STR_ACTIVE`), "Vừa truy cập" (`STR_JUST_NOW`), "Truy cập" + thời gian (`STR_LAST_SEEN`, `STR_MIN_AGO` "phút trước") (Z2). Nút thông tin hội thoại: "Thông tin hội thoại" (`STR_CONVERSATION_INFO`), "Thông tin nhóm" (`STR_PROFILE_GROUP`) (Z2).

**Khuyến nghị.** Header 56–64px: avatar, tên, một dòng trạng thái; bên phải chỉ 3 nút: Tìm trong chat, (Gọi — chưa có thì không hiện), Thông tin. Chữ trạng thái theo Zalo: "Đang hoạt động", "Vừa truy cập", "Truy cập {x} phút trước", và giữ các mức mờ của Telegram ("Truy cập gần đây", "Truy cập trong tuần") cho quyền riêng tư. Nhóm: "{n} thành viên · {k} đang hoạt động".

## 4. Bong bóng tin, trạng thái gửi, reaction, trả lời

**Telegram.**
- [QS] Màu theme ngày: tin mình `msgOutBg:#def1fd`, tin người khác `msgInBg` = nền trắng, màu nhấn `windowBgActive:#40a7e3` (T3).
- [QS] "Reply with double click", "Send reaction…" là tuỳ chọn cài đặt (T1). Có `history_view_reply_button.cpp`, `reactions/history_view_reactions_strip.cpp`, `…_selector.cpp` (L206866–206946).
- [QS] Có "Quote" và kiểu trích đoạn ("Styles for Links and Quotes", T1).
- [QS] "edited" hiện cạnh giờ (T1).

**Zalo.**
- [QS] Bong bóng `.card{padding:12px;border-radius:8px;background:var(--white-message)}`, tin mình `--blue-message:#e5f1ff`, bóng `--shadow-bubble` rất nhẹ; `.chat-message.me{justify-content:flex-end}` (Z3).
- [QS] Reaction gọi là **"Biểu cảm"** (`STR_MSG_REACTION`, `STR_REACTION_BT`); thông báo "đã bày tỏ cảm xúc với tin nhắn bạn gửi" (Z2). Icon reaction 24px (`.msg-reaction-icon.react-icon{width:1.5rem}`) (Z3).
- [QS] Trả lời: "Trả lời" (`STR_REPLY_MSG`), nút hover dùng icon trích dẫn (`Quote_24_Filled`); "Trích dẫn" (`STR_QUOTE_MSG`); "Bấm đúp vào vùng cạnh tin nhắn để trả lời" là tuỳ chọn (`enableDoubleClickReply`) (Z2, Z4). Bấm vào trích dẫn: "Xem tin nhắn gốc" (`STR_JUMP_TO_MESSAGE`) (Z2).
- [QS] Trạng thái gửi: "Đang gửi", "Đã gửi", "Đã nhận", "Đã xem" (`STR_SENDING/SENT/RECEIVED/SEEN`) (Z2).
- [QS] "Đánh dấu tin quan trọng" (`STR_MARK_IMPORTANT_MESSAGE`) (Z2).

**Người Việt đã quen.** "Đã xem" (không phải "đã đọc") cho tin của mình; "Biểu cảm"/"thả cảm xúc"; bấm đúp để trả lời; bấm trích dẫn để nhảy về tin gốc.

**Khuyến nghị.** Tin mình nền nhạt màu thương hiệu (mock đang dùng 14% tím — giữ, chỉ đảm bảo tương phản chữ ≥4.5:1), tin người khác nền trắng + viền mảnh; bo 12px; gộp tin liên tiếp cùng người trong 5 phút (một avatar, một tên). Hàng reaction dưới bong bóng, chip 24px. Bật **bấm đúp để trả lời** mặc định (cả hai app có). Trạng thái tin mình: đồng hồ → 1 dấu tích ("Đã gửi") → 2 dấu tích ("Đã xem"). Không làm "tin quan trọng" (thừa với ghim).

## 5. Menu thao tác tin (thu hồi, xoá, chuyển tiếp)

**Telegram.** [QS] "Delete for everyone", "Also delete for {name}", "Unsend my messages"; "Copy Text", "Copy Link", "Forward", "Select", "Pin", "Report", "Translate" (T1). Context menu ở `history_view_context_menu.cpp` (L206890).

**Zalo.** [QS] Thứ tự khoá menu chuột phải quanh `STR_RECALL_MSG` trong bundle: Copy → Trả lời → Xem chi tiết → Ghim tin nhắn → Tạo nhắc hẹn → **Thu hồi** → Tuỳ chọn khác (Z4). [SL] Đây là thứ tự khai báo, gần đúng thứ tự hiển thị. Thuật ngữ: "Thu hồi" (`STR_RECALL_MSG`), "Tin nhắn đã thu hồi", "Xóa ở cả người nhận (Thu hồi)", "Xóa chỉ ở phía tôi", "Chia sẻ" thay cho chuyển tiếp (`STR_FORWARD`), "Chọn nhiều" (`STR_MULTI_SELECT`), "Sao chép" (Z2).

**Người Việt đã quen.** **"Thu hồi"** là từ gần như ai dùng Zalo cũng biết; "Xóa chỉ ở phía tôi".

**Khuyến nghị.** Menu tin: Trả lời · Chuyển tiếp · Sao chép · Ghim · Sửa (tin mình) · Xem ai đã xem (nhóm nhỏ) · Báo cáo (tin người khác) · **Thu hồi** (tin mình, xoá cho mọi người) · **Xoá ở phía tôi**. Thêm hàng hành động nhanh khi hover: Biểu cảm, Trả lời, Chuyển tiếp (Zalo có nút trích dẫn khi hover). Giữ "Chuyển tiếp" (rõ nghĩa hơn "Chia sẻ" của Zalo, khớp Telegram). Tin đã thu hồi hiện "Tin nhắn đã thu hồi" (đổi từ "Tin đã bị xoá").

## 6. Ô soạn tin, đính kèm, thao tác nhanh

**Telegram.** [QS] Placeholder "Write a message...", "Broadcast a message...", "Silent broadcast...", "Comment…" (T1); "Send without sound", "Schedule message", "Set a reminder" (T1); định dạng "Bold, Italic, Underline, Strikethrough… Spoiler" (T1); thanh trả lời/chuyển tiếp (`history_view_forward_panel.cpp`, `history_view_draft_options.cpp`), ghi âm (`history_view_voice_record_bar.cpp`) (L206802–206816).

**Zalo.** [QS] Placeholder **"Nhập @, tin nhắn tới {tên}"** (`STR_MESSAGE_TO`) (Z2). Thanh công cụ trên ô soạn: nút 30×30px (`.chat-box-input__tools__btn`) (Z3). Lệnh `@` nhanh: "Gửi File @FILE", "Tạo bình chọn @POLL", "Treo thông báo @NOTICE", "Tìm sticker @STICKER" (Z2). "Định dạng tin nhắn" Cmd/Ctrl+Shift+X; "Chụp màn hình" Cmd/Ctrl+Alt+S; "Tin nhắn nhanh" (phím tắt nội dung) (Z2). Ô soạn có viền trên `border-top:1px solid var(--divider-bold)` (Z3).

**Người Việt đã quen.** Placeholder có tên người nhận; gõ `@` để nhắc tên; dán ảnh/chụp màn hình gửi ngay; "Gửi File".

**Khuyến nghị.** Ô soạn một dòng tự giãn (tối đa ~8 dòng), placeholder "Nhập tin nhắn tới {tên}" (nhóm: "Nhập @ để nhắc tên, tin nhắn tới {nhóm}"). Bên trái: nút đính kèm (một menu: Ảnh/Video, File) — chỉ hiện khi media đã chạy thật; bên phải: emoji, nút Gửi. Enter gửi, Shift+Enter xuống dòng. Định dạng bằng phím tắt + menu khi chọn chữ (Telegram), không cần thanh định dạng luôn hiện. Không mượn @FILE/@POLL/sticker store.

## 7. Ghim

**Telegram.** [QS] "Pin this message in the group?", "Notify all members", "Also pin for {name}", "{n} pinned messages" (T1).

**Zalo.** [QS] "Ghim tin nhắn" (`STR_PIN_MESSAGE`); ghim được tin, ghi chú, bình chọn lên đầu hội thoại (`STE_ADMIN_UPDATE_TOPIC_2`); "ghim một tin nhắn thành thông báo nhóm" (Z2). Nền vùng ghim `--layer-background-pinned` (Z3).

**Khuyến nghị.** Giữ thanh tin ghim của mock (đã có nút ẩn). Khi có nhiều tin ghim, hiện "Tin ghim 2/3" và bấm để xoay vòng (Telegram); hộp xác nhận ghim có ô "Thông báo cho mọi thành viên".

## 8. Tìm kiếm

**Telegram.** [QS] "Search messages in", "From: {name}", "Global search results", "Search for messages" (T1); có lọc theo tag/bài đăng (`dialogs_search_tags.cpp`, `dialogs_search_posts.cpp`, L206721–206723); nhảy "Jump to bottom / Jump to mention / Jump to reaction" (T1).

**Zalo.** [QS] "Tìm kiếm" (ô chính), "Tìm kiếm tin nhắn" (`STR_SEARCH_MESSAGES`), "Tìm kiếm thành viên", "Tìm kiếm theo tên File", "Kết quả tìm kiếm" (Z2); màu tô từ khoá `--text-search-highlight:#ffcd29` (Z3). Có worker riêng cho tìm kiếm `pc-dist/search-worker.*.js` (Z1).

**Khuyến nghị.** Giữ ⌘K/Ctrl+K của mock và gợi ý "gõ không dấu vẫn ra". Kết quả chia nhóm: **Liên hệ · Nhóm và kênh · Tin nhắn** (đúng thứ tự người Việt tìm: tìm người trước). Tô vàng từ khoá. Thêm nút nổi "@" nhảy tới tin nhắc mình khi chat có mention chưa đọc (Telegram).

## 9. Danh bạ

**Telegram.** [QS] "Contacts", "Add Contact", "New Group", "New Channel" ở menu chính (T1: "ContactsAdd ContactNew GroupNew Channel").

**Zalo.** [QS] Tab Danh bạ gồm "Danh sách bạn bè", "Danh sách nhóm và cộng đồng", "Lời mời kết bạn", "Lời mời vào nhóm và cộng đồng" (Z2); "Kết bạn", "Thêm bạn", "Thêm bạn bằng số điện thoại", "Tìm bạn" (Z2). Danh sách ảo hoá với `overscanRowCount` (Z4).

**Người Việt đã quen.** Một nơi "Danh bạ" chứa cả người và nhóm; "Thêm bạn".

**Khuyến nghị.** Giữ "Danh bạ" là danh sách **tự thêm, một chiều** (quyết định đã có). **Không** dùng "Kết bạn/Lời mời kết bạn" vì gợi ý quan hệ hai chiều cần đối phương đồng ý — sai mô hình. Dùng "Thêm vào danh bạ". Có thể thêm mục phụ "Nhóm của bạn" trong Danh bạ (Zalo) — cần duyệt vì là mở rộng nhỏ. Danh sách xếp A–Z, có chữ cái nhóm đầu mục.

## 10. Tạo nhóm

**Telegram.** [QS] "New Group", "Add Members", "Next", "Create" (T1). [SL] Luồng 2 bước (chọn người → đặt tên).

**Zalo.** [QS] "Tạo nhóm" (`STR_CREATE_GROUP`), "Tạo nhóm với người này" từ hồ sơ (`STR_CREATE_CONVERSATION_GROUP`), "Nhập tên bạn bè, đồng nghiệp" (`STR_ENTER_MEMBER`), hỏi "Bạn có gửi tin nhắn cho nhóm mà chưa đặt tên nhóm không?" (`STR_CREATE_GROUP_WITHOUT_NAME`) (Z2). [SL] Tên nhóm không bắt buộc; một hộp thoại chứa cả ô tên và danh sách chọn người.

**Khuyến nghị.** Một màn: ô "Tên nhóm" ở trên (không bắt buộc; bỏ trống thì đặt theo tên 3 thành viên đầu), ô tìm + danh sách chọn có chip người đã chọn ở dưới, nút "Tạo nhóm". Ít bước hơn Telegram, giống Zalo. Thêm lối tắt "Tạo nhóm với người này" trong hồ sơ người dùng.

**Xung đột.** Mock `chat.html#new-group` đang 2 bước và bắt buộc nhập tên (`nameRequired`). Đổi là quyết định UX — đề xuất ở mục "Đề xuất thay đổi mock".

## 11. Thông tin nhóm, quản trị, link mời

**Telegram.** [QS] "Group Info", "Channel Info", "Topic Info" (T1); "Members", "Administrators", "Exceptions", "Removed users", "Permissions", "Invite links", "Reactions" (T1); "Add Members", "Invite via Link", "Hide Members" (T1); tab media "Photos, GIFs, Videos, Audio files, Files, Voice messages, Shared links" (T1); "Chat history for new members: Visible" (T1).

**Zalo.** [QS] "Thông tin nhóm", "Bảng tin nhóm", "Ảnh/Video", "File", "Link", "Thành viên nhóm", "Quản lý nhóm", "Thiết lập bảo mật", "Tin nhắn tự xóa", "Rời nhóm", "Giải tán nhóm" (Z2). Vai trò: **"Trưởng nhóm"**, **"Phó nhóm"** (`STR_GROUP_OWNER`, `STR_ADMIN`) (Z2). Link: "Link tham gia nhóm", "Kích hoạt link tham gia nhóm" (Z2). Rời nhóm khi là trưởng nhóm: "Rời nhóm và chọn {tên} làm trưởng nhóm mới?" (Z2).

**Người Việt đã quen.** "Trưởng nhóm/Phó nhóm"; khối "Ảnh/Video · File · Link"; "Rời nhóm" ở cuối.

**Khuyến nghị.** Cột thông tin theo thứ tự: avatar + tên + mô tả → hàng nút nhanh (Tắt thông báo · Ghim · Thêm thành viên) → Thành viên (5 người đầu + "Xem tất cả") → Link mời → Ảnh/Video · File · Link (chỉ khi media đã chạy thật) → Quản lý nhóm (chỉ admin) → Rời nhóm / Báo cáo. Với **nhóm**, dùng "Trưởng nhóm" và "Phó nhóm" thay "chủ nhóm"/"Admin"; với **kênh**, giữ "Chủ kênh" và "Admin". Luồng chủ rời nhóm của mock (chọn người nhận quyền) đã khớp Zalo.

## 12. Chủ đề và kênh

Zalo không có chủ đề kiểu Telegram ([CB] không thấy chuỗi tương ứng; Zalo dùng "Cộng đồng" là khái niệm khác). Telegram [QS] có "Enable Topics", "New Topic", "Edit Topic", "Close Topic", "Topics layout" (T1), `data_forum_topic.cpp` (L206320).

**Khuyến nghị.** Giữ chủ đề và kênh theo Telegram (đã là quyết định). Dùng "Chủ đề" và "Kênh" (không dùng "Cộng đồng" của Zalo vì khác nghĩa). Hàng nhóm có chủ đề hiện 2 dòng như mock đang làm.

## 13. Thông báo và badge

**Telegram.** [QS] "Notifications for chats", "Show notifications", "Reactions to my messages", "Notify me about" (T1); badge chưa đọc màu nhấn, badge của chat đã tắt thông báo màu xám `dialogsUnreadBgMuted:#bbbbbb` (T3).

**Zalo.** [QS] Badge đỏ `--icon-count-noti-enable-bg:#c31818`, badge tắt thông báo xám `--icon-count-noti-disable-bg:#8b96a7` (Z3); favicon chấm đỏ `fav-reddot.ico`, `fav-busymode.ico` (Z1); thông báo "nhắc đến bạn" (`STR_MENTIONED_YOU`), "Nhắc nhóm" cho @All (Z2).

**Khuyến nghị.** Badge số trên hàng chat: màu thương hiệu khi bật thông báo, **xám khi đã tắt** (cả hai app làm vậy); "@" riêng khi có người nhắc. Rail: badge tổng chat chưa đọc. Tiêu đề tab trình duyệt: "(3) Chat". Dòng phân cách "Tin nhắn chưa đọc" trong khung chat.

## 14. Đăng nhập và lần đầu dùng

**Zalo.** [QS] Đăng nhập bằng mã QR ("Mã QR đã hết hạn", `STR_LOGIN_QR_PAGE_QR_TIMEOUT_ERROR`), chuỗi giới thiệu tính năng `STR_ONBOARD_B2S_*` ("Ghim tin nhắn", "Bình chọn", "Nhắc hẹn", "Định dạng tin nhắn") (Z2). [CB] Thứ tự và hình thức hiển thị onboarding.

**Khuyến nghị.** App dùng IdP hoandat — giữ một nút "Đăng nhập bằng tài khoản hoandat". Không làm tour giới thiệu; dùng trạng thái rỗng có hướng dẫn một câu (mock đã có: "Bấm + để nhắn cho một người…").

## 15. Phím tắt

**Telegram** (T2). [QS] Lệnh: `search`, `previous_chat`, `next_chat`, `first_chat`, `last_chat`, `self_chat`, `pinned_chat1…8`, `previous_folder`, `next_folder`, `all_chats`, `folder1…6`, `show_archive`, `show_contacts`, `read_chat`, `archive_chat`, `show_scheduled`, `record_voice`… Phím mặc định có mặt: `ctrl+f`, `ctrl+pgdown`/`alt+down`, `ctrl+pgup`/`alt+up`, `ctrl+alt+home`, `ctrl+alt+end`, `ctrl+1…9`, `ctrl+0`, `ctrl+j`, `ctrl+r`, `ctrl+w`, `ctrl+l`, `ctrl+m`, `ctrl+q`. [SL] Cặp đôi: Ctrl+F tìm, Alt+↑/↓ chat trước/sau, Ctrl+1…8 thư mục, Ctrl+0 Saved Messages, Ctrl+L khoá app. [CB] Ghép chính xác từng phím với lệnh (bảng lưu tách rời). Người dùng sửa được qua `shortcuts-custom.json` và "Keyboard Shortcuts" trong cài đặt (T3).

**Zalo** (Z4, offset 14.633.385). [QS] Hộp "Danh sách phím tắt": Alt+1 Tin nhắn, Alt+2 Danh bạ, Alt+3 Danh sách nhóm, ⌘/Ctrl+F Tìm kiếm; ⌘/Ctrl+I vào ô nhập tin; ⌘/Ctrl+N tạo trò chuyện; ⌘/Ctrl+Alt+S chụp màn hình; ⌘/Ctrl+L khoá ứng dụng; ⌘/Ctrl+Shift+X định dạng tin nhắn. Mở từ menu "Phím tắt" (`STR_MENU_HOTKEYS`).

**Khuyến nghị.** Bộ phím nhỏ, trùng chỗ hai app trùng nhau: ⌘/Ctrl+K (đã có) **và** ⌘/Ctrl+F đều mở tìm; Alt+↑/↓ chuyển chat; ⌘/Ctrl+1…4 chuyển bộ lọc; ⌘/Ctrl+N chat mới; Esc huỷ trả lời/sửa, đóng cột thông tin; ↑ trong ô soạn trống để sửa tin vừa gửi [CB: không thấy bằng chứng trong hai gói, nhưng là mẫu phổ biến]. Thêm hộp "Phím tắt" mở từ Cài đặt và bằng ⌘/Ctrl+/. Lưu ý trình duyệt chiếm ⌘/Ctrl+N, ⌘/Ctrl+W, ⌘/Ctrl+L — trên web chỉ dùng tổ hợp không đụng trình duyệt; bản desktop (Tauri) mới bật ⌘/Ctrl+N.

## 16. Token giao diện (dữ liệu tham khảo, không chép)

| Mục | Telegram (T3, theme ngày) | Zalo (Z3, light) | Mock hiện tại |
|---|---|---|---|
| Màu nhấn | `#40a7e3` | `#0068ff` / `#005ae0` | `#6e56cf` (tím) |
| Nền tin mình | `#def1fd` | `#e5f1ff` | tím 14% |
| Nền tin người khác | trắng | trắng | trắng + viền |
| Chữ chính / phụ | `#000` / `#999` | `#081b3a` / `#5a6981` | `#1c2024` / `#60646c` |
| Badge tắt thông báo | `#bbbbbb` | `#8b96a7` | (chưa định nghĩa) |
| Thang chữ | [CB] | 12/13/14/15/16/18/24px (`--f12…--f24`) | 13–16px |
| Khoảng cách | [CB] | 4/8/12/16/20/24/32 (`--space-xxs…xxl`) | 4/8/12/16/24/32 |
| Bo bong bóng | [CB] | 8px | 12px |
| Rail / cột danh sách | [CB] | 64px / 408px kéo được | 64px / 320px |

[SL] Cả hai app dùng nền tin mình **nhạt, cùng tông màu nhấn**, tin người khác trắng; đây là mẫu người dùng nhận ra ngay. Mock đang theo đúng mẫu đó với màu tím — giữ màu thương hiệu, không đổi sang xanh. Thêm token màu badge cho chat đã tắt thông báo.

## 17. Kỹ thuật hiệu năng thấy được trong renderer Zalo

- [QS] Danh sách ảo hoá: `rowHeight` (62 lần), `overscanRowCount` (34), `rowRenderer`, bộ đệm đo kích thước theo hàng (`cache:E … rowIndex`) (Z4). [SL] API kiểu react-virtualized được đóng gói lại (không thấy tên gói).
- [QS] `contain:` trong CSS 47 lần, ví dụ `.conv-item{contain:size style}` (Z3).
- [QS] `IntersectionObserver` 18 lần, `requestIdleCallback` 15 lần (Z4).
- [QS] Việc nặng tách ra worker: `search-worker`, `sync-v2-sub-worker`, `dal-worker`, `cpu-heavy-worker`, `preview-thumb-worker`, `pdf-worker`, `opfs-worker`, `shared-worker` (Z1).
- [QS] Ngôn ngữ và màn phụ tải lười: 54 chunk `pc-dist/lazy/`, gói ngôn ngữ tách riêng (Z1).

**Khuyến nghị.** Đã khớp hướng của app (shell R0 nhỏ, chunk messaging tải sau, copy tách file). Bổ sung: ảo hoá cả danh sách chat lẫn khung tin; `contain: layout style` cho hàng chat; tìm kiếm cục bộ chạy trong worker; việc không gấp (tiền tải ảnh đại diện, đánh chỉ mục) chạy trong `requestIdleCallback`.

---

## Đề xuất thay đổi mock

Thư mục: `plans/dattqh/261013-0448-chat-platform-v1/mockups/`. P1 = nên sửa ngay (đúng quyết định đã có hoặc chỉ là chữ); P2 = đổi UX, cần chủ app duyệt; P3 = tinh chỉnh.

| # | Ưu tiên | Trang#màn | Thay đổi | Lý do |
|---|---|---|---|---|
| 1 | P1 | `chat.html#app`, `desktop.html#three-pane` | Bỏ hẳn nút "Sửa thư mục" mờ và toast "có sau R4". | Trái quyết định "không nhãn lộ trình"; Telegram/Zalo không hiện tính năng chưa có. |
| 2 | P1 | `chat.html#context-menu`, `#delete` | Tin của mình: "Thu hồi" (xoá cho mọi người) và "Xoá ở phía tôi"; tin người khác: "Xoá ở phía tôi". Tin đã thu hồi hiện "Tin nhắn đã thu hồi". | Zalo `STR_RECALL_MSG`, `STR_DELETE_MSG_FOR_ME` (Z2); Telegram có cùng hai lựa chọn (T1). |
| 3 | P1 | `chat.html#list-menu` | "Tắt tiếng" → "Tắt thông báo" (khớp "Bật thông báo" đang có); thêm "Đánh dấu chưa đọc"; hiện nút "…" khi hover hàng. | Z2 `STR_MUTE_CONVERSATION_SHORT`, `STR_LABEL_MARK_UNREAD`; Z3 `.conv-action__popup`; T1 "Mark as unread". |
| 4 | P1 | `chat.html#composer-states`, `mobile.html#chat` | Placeholder "Nhập tin nhắn tới {tên}"; nhóm: "Nhập @ để nhắc tên, tin nhắn tới {nhóm}". Gợi ý nhỏ "Enter gửi · Shift+Enter xuống dòng" ở trạng thái đầu. | Z2 `STR_MESSAGE_TO`. |
| 5 | P1 | `chat.html#emoji-picker`, `#context-menu` | "Thả reaction"/"Chọn reaction" → "Thả cảm xúc"/"Chọn biểu cảm". | Zalo gọi là "Biểu cảm" (Z2); tránh từ tiếng Anh. |
| 6 | P1 | `chat.html#message-kinds`, `#read-by` | Trạng thái tin mình: "Đã gửi" → "Đã xem"; "Xem ai đã đọc" → "Xem ai đã xem"; tiêu đề "Đã đọc · 3 người" → "Đã xem · 3 người". | Z2 `STR_SEEN`. |
| 7 | P1 | `chat.html#context-menu` | Thêm hàng nút khi hover trên bong bóng: Biểu cảm · Trả lời · Chuyển tiếp; ghi chú "bấm đúp để trả lời". | Zalo nút trích dẫn khi hover + `enableDoubleClickReply` (Z4); Telegram "Reply with double click" (T1). |
| 8 | P2 | `chat.html#info-panels` | Sắp lại cột thông tin: đầu → hàng nút nhanh (Tắt thông báo · Ghim · Thêm thành viên) → Thành viên (5 + "Xem tất cả") → Link mời → Ảnh/Video · File · Link (chỉ khi media chạy thật, không hiện mờ) → Quản lý nhóm → Rời nhóm/Báo cáo. | Mẫu "Thông tin nhóm" của Zalo (Z2) + Group Info Telegram (T1); không feature flag/không nhãn lộ trình. |
| 9 | P2 | `chat.html#chat-admin`, `#info-panels`, `#channel-owner-leave`, `#member-remove` | Nhóm: "chủ nhóm" → "Trưởng nhóm", "Admin" → "Phó nhóm" (kênh giữ "Chủ kênh"/"Admin"). | Z2 `STR_GROUP_OWNER`, `STR_ADMIN`. Từ người Việt quen nhất cho vai trò nhóm. |
| 10 | P2 | `chat.html#new-group` | Gộp 2 bước thành 1: ô "Tên nhóm" (không bắt buộc, tự đặt theo tên thành viên) + chọn người có chip. Thêm "Tạo nhóm với người này" ở `#user-profile`. | Zalo `STR_CREATE_GROUP_WITHOUT_NAME`, `STR_CREATE_CONVERSATION_GROUP` (Z2); ít bước hơn. |
| 11 | P2 | `chat.html#app`, `#list-states`, `desktop.html#three-pane` | Thêm bộ lọc "Chưa đọc" (lọc ở client). | Zalo `STR_UNREAD_LABEL` trong menu lọc (Z4); Telegram có "Unread" (T1). Mở rộng nhỏ — cần duyệt. |
| 12 | P2 | `search.html#global` | Chia kết quả thành Liên hệ · Nhóm và kênh · Tin nhắn; tô vàng từ khoá; nhận ⌘/Ctrl+F như ⌘K. | Z2 "Kết quả tìm kiếm", Z3 `--text-search-highlight`; Zalo/Telegram dùng Ctrl+F (Z4, T2). |
| 13 | P2 | `settings.html#appearance` (hoặc màn mới trong `settings.html`) | Thêm hộp "Phím tắt" (Alt+↑/↓, ⌘/Ctrl+1…4, ⌘/Ctrl+K/F, Esc, ⌘/Ctrl+/). | Zalo có "Danh sách phím tắt" (Z4); Telegram có trang chỉnh phím tắt (T2, T3). |
| 14 | P2 | `chat.html#app` | Nút nổi "@" nhảy tới tin nhắc mình, cạnh nút "Xuống tin mới nhất". | Telegram "Jump to mention" (T1). |
| 15 | P2 | `chat.html#info-panels` (header) | Dòng trạng thái: "Đang hoạt động", "Vừa truy cập", "Truy cập {x} phút trước"; nhóm: "{n} thành viên · {k} đang hoạt động". | Z2 `STR_ACTIVE`, `STR_JUST_NOW`, `STR_LAST_SEEN`. |
| 16 | P3 | `chat.html#app`, `desktop.html#window` | Cột danh sách kéo đổi rộng 280–420px, chữ cắt bằng dấu "…", không cuộn ngang. | Zalo tay kéo `ew-resize` (Z3); quyết định "không cuộn ngang". |
| 17 | P3 | `chat.html#app` (thanh tin ghim) | Nhiều tin ghim: "Tin ghim 2/3", bấm để xoay; hộp ghim có ô "Thông báo cho mọi thành viên". | T1 "{n} pinned messages", "Notify all members". |
| 18 | P3 | `chat.html#list-states` | Badge chat đã tắt thông báo màu xám; "@" riêng khi có người nhắc. | T3 `dialogsUnreadBgMuted`; Z3 `--icon-count-noti-disable-bg`. |
| 19 | P3 | `chat.html#contacts` | Danh bạ xếp A–Z có chữ cái nhóm; nút "Thêm vào danh bạ" (không "Kết bạn"). | Giữ mô hình danh bạ một chiều; tránh từ Zalo gây hiểu nhầm. |

## Thuật ngữ tiếng Việt

Nguồn: `apps/web/src/messaging/copy/vi.ts`, `vi-screens.ts` (khoá ghi dạng `nhóm.khoá`). Cột Zalo lấy từ Z2; cột Telegram là chuỗi tiếng Anh gốc (T1) — Telegram Desktop **không** kèm tiếng Việt trong gói.

| Thuật ngữ hiện tại (khoá) | Zalo (Z2) | Telegram (T1) | Khuyến nghị |
|---|---|---|---|
| "Tắt tiếng" (`convo.mute`, `listMenu.mute`), "Đã tắt tiếng" | "Tắt thông báo" / "Bật thông báo" | Mute / Unmute | **Đổi** → "Tắt thông báo", "Đã tắt thông báo" (đang lệch cặp với "Bật thông báo"). |
| "Xoá" tin mình (`menu.deleteMine`, `deleteDialog.delete`) | "Thu hồi", "Xóa ở cả người nhận (Thu hồi)" | Delete for everyone / Unsend | **Đổi** → "Thu hồi". |
| "Xoá ở phía tôi" (`menu.deleteTheirs`) | "Xóa chỉ ở phía tôi" | Delete for me | **Giữ**. |
| "Tin đã bị xoá" (`message.deleted`) | "Tin nhắn đã thu hồi" | Deleted message | **Đổi** → "Tin nhắn đã thu hồi" khi người gửi thu hồi. |
| "Thả reaction", "Chọn reaction", "Thêm reaction" | "Biểu cảm", "bày tỏ cảm xúc" | Reactions | **Đổi** → "Thả cảm xúc", "Chọn biểu cảm", "Thêm biểu cảm". |
| "Trả lời" (`menu.reply`) | "Trả lời" (+ "Trích dẫn") | Reply / Quote | **Giữ**. |
| "Chuyển tiếp" (`menu.forward`) | "Chia sẻ" | Forward | **Giữ** "Chuyển tiếp" (rõ nghĩa, khớp Telegram). |
| "Sao chép" (`menu.copy`) | "Sao chép" / "Copy" | Copy Text | **Giữ**. |
| "Sửa", "đã sửa" | "Chỉnh sửa", "Lần sửa cuối" | Edit, edited | **Giữ** (ngắn, gọn). |
| "Ghim", "Ghim chat", "Tin ghim" | "Ghim tin nhắn", "Ghim hội thoại", "Bỏ ghim" | Pin / Unpin | **Giữ**. |
| "Đánh dấu đã đọc" (`listMenu.markRead`) | "Đánh dấu đã đọc", "Đánh dấu chưa đọc" | Mark as read / unread | **Giữ**, **thêm** "Đánh dấu chưa đọc". |
| "Đã đọc" (trạng thái tin, `message.read`, `readBy.title`) | "Đã xem" | (2 dấu tích) | **Đổi** → "Đã xem"; "Xem ai đã xem". |
| "Đã gửi", "Đang gửi", "Gửi lỗi" | "Đã gửi", "Đang gửi", "Không gửi được" | — | **Giữ**; "Gửi lỗi" → "Chưa gửi được" cho đồng nhất với `message.notSent`. |
| "Viết tin nhắn" (`composer.placeholder`) | "Nhập @, tin nhắn tới {tên}" | Write a message... | **Đổi** → "Nhập tin nhắn tới {tên}". |
| "online" (`info.online`) | "Đang hoạt động" | online | **Đổi** → "Đang hoạt động". |
| "truy cập gần đây/trong tuần/…" | "Vừa truy cập", "Truy cập {x} phút trước" | last seen recently/within a week | **Giữ** các mức mờ; viết hoa đầu câu; thêm "Vừa truy cập" khi được phép thấy giờ chính xác. |
| "đang gõ" (`privacy.lastSeenHint`) | "đang soạn tin" | is typing | **Giữ** "đang gõ…" (ngắn hơn, ai cũng hiểu). |
| "Admin" (nhóm), "chủ nhóm" | "Phó nhóm", "Trưởng nhóm" | Admin, Owner | **Đổi** cho nhóm → "Phó nhóm", "Trưởng nhóm"; kênh giữ "Admin", "Chủ kênh". |
| "Thành viên" | "Thành viên", "Thành viên nhóm" | Members | **Giữ**. |
| "Thêm thành viên" | "Thêm thành viên", "Thêm bạn vào nhóm" | Add Members | **Giữ**. |
| "Rời nhóm", "Rời kênh" | "Rời nhóm", "Giải tán nhóm" | Leave group | **Giữ**. |
| "Link mời" | "Link tham gia nhóm", "Link nhóm" | Invite link | **Giữ** "Link mời" (ngắn; dùng chung cho nhóm và kênh). |
| "Danh bạ" (`folders.contacts`) | "Danh bạ", "Danh sách bạn bè" | Contacts | **Giữ**. |
| "Thêm liên hệ", "Thêm vào danh bạ" | "Thêm bạn", "Kết bạn" | Add Contact | **Giữ** "Thêm vào danh bạ"; **không** dùng "Kết bạn" (sai mô hình một chiều). |
| "Tạo nhóm", "Tạo kênh" | "Tạo nhóm" | New Group / New Channel | **Giữ**. |
| "Tạo chat mới" (`list.newChat`), "Tin nhắn mới" (`newChat.title`) | "Tạo trò chuyện" | New message | **Giữ** "Chat mới"; tiêu đề hộp đổi "Tin nhắn mới" → "Chat mới" cho khớp nút. |
| "Thông tin chat", "Thông tin nhóm/kênh" | "Thông tin hội thoại", "Thông tin nhóm" | Group Info / Channel Info | **Giữ**. |
| "Tìm chat và tin nhắn", "Tìm trong chat" | "Tìm kiếm", "Tìm kiếm tin nhắn" | Search / Search messages | **Giữ**. |
| "Báo cáo" | "Báo xấu" | Report | **Giữ** "Báo cáo" (trung tính, hợp môi trường công việc). |
| "Chặn", "Bỏ chặn" | "Chặn tin nhắn", "Bỏ chặn" | Block / Unblock | **Giữ**. |
| "Chủ đề" | (không có) | Topics | **Giữ**. |
| "Kênh", "người đăng ký" | ("Cộng đồng" — khác nghĩa) | Channel, subscribers | **Giữ**. |
| "Tin chưa đọc" (vạch phân cách) | "Tin nhắn chưa đọc" | Unread messages | **Giữ** (ngắn). |
| "Nháp:" | — | Draft | **Giữ**. |
| "Huỷ", "Xoá" (dấu đặt ở "y"/"a") | "Hủy", "Xóa" | — | **Cần chọn một kiểu**: Zalo và đa số app Việt viết "Hủy/Xóa". Khuyến nghị đổi sang "Hủy/Xóa" cho quen mắt và để tìm kiếm khớp cả hai kiểu; ít rủi ro, chỉ là chữ. |

## Câu hỏi còn mở (cần chủ app quyết)

1. Thêm bộ lọc "Chưa đọc" (đề xuất #11) và mục "Nhóm của bạn" trong Danh bạ — mở rộng phạm vi nhỏ. Khuyến nghị: làm "Chưa đọc" (rẻ, lọc ở client), hoãn "Nhóm của bạn".
2. Tạo nhóm một màn, tên không bắt buộc (đề xuất #10) — khác luồng Telegram. Khuyến nghị: làm theo Zalo.
3. "Trưởng nhóm/Phó nhóm" cho nhóm nhưng "Chủ kênh/Admin" cho kênh (đề xuất #9) — hai bộ từ. Khuyến nghị: chấp nhận, vì người Việt chỉ quen bộ từ của Zalo ở nhóm.
4. Kiểu dấu "Hủy/Xóa" hay "Huỷ/Xoá" — đổi toàn bộ copy một lần.

## Đối chiếu yêu cầu

| Hạng mục | Trạng thái |
|---|---|
| Zalo: điều hướng, hàng chat, header, ô soạn, bong bóng, biểu cảm, trả lời/trích dẫn, ghim, tìm kiếm, danh bạ, tạo nhóm, thông tin nhóm, badge, phím tắt, token, hiệu năng | Đã trả lời (tĩnh) |
| Zalo: onboarding | Một phần — chỉ có khoá chuỗi, chưa biết cách hiển thị |
| Zalo: kích thước hàng chat, avatar | Một phần — chiều cao hàng do JS ảo hoá quyết định, không đọc ra số cố định |
| Telegram: theme, lang key (tiếng Anh), phím tắt, menu, thư mục, chủ đề, info panel, ô soạn | Đã trả lời qua chuỗi; không có tên khoá lang (chỉ có giá trị) |
| Telegram: tiếng Việt trong gói | Không có (0 kết quả) |
| Telegram: hằng số layout | Chưa biết — biên dịch thành số, không đọc được bằng kiểm kê chuỗi |
| Đóng session REA | Không có session native nào mở (`open=false`); phân tích JS không giữ session |
