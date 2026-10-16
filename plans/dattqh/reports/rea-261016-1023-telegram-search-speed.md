# REA — Vì sao tìm kiếm của Telegram Desktop "nhanh": kiến trúc phía client

- **Artifact:** `/Applications/Telegram.app/Contents/MacOS/Telegram`, Telegram Desktop **7.3.1**, Mach-O arm64, 254 MB, sha256 `1a3c8705…c227` (cùng binary với `rea-261014-1200-telegram-desktop-architecture.md`).
- **Ngày:** 2026-10-16 (Asia/Saigon).
- **Phương pháp:**
  1. REA kiểm tra session/provider: Ghidra 12.1.4 có sẵn. **Không** chạy phân tích Ghidra đầy đủ: binary 254 MB đã strip, chạy toàn bộ sẽ tốn nhiều giờ và nhiều GB RAM trên máy dùng chung, trong khi tên hàm vẫn không có.
  2. Kiểm kê chuỗi tĩnh (`strings -n 6`, 218.971 dòng) rồi demangle RTTI/lambda bằng `c++filt` để biết **lớp và hàm nào có thật trong binary**.
  3. Binary còn đường dẫn nguồn `Telegram/SourceFiles/...`, nên đối chiếu với mã nguồn công khai tdesktop **đúng tag `v7.3.1`** (commit `6fed91ff`) để biết **cơ chế**. Chỉ đọc để hiểu ngữ nghĩa, không chép code.
- **Cách đọc:** *Quan sát binary* = có trong binary. *Nguồn v7.3.1* = đọc từ mã nguồn cùng phiên bản (giả định binary build từ tag này, khớp version và path, nhưng chưa chứng minh từng byte). *Suy luận* = kết luận của tôi.

---

## Kết luận ngắn

Telegram Desktop không có "bí mật" index full-text phía client. Nó nhanh vì **tách tìm kiếm thành hai tầng có chi phí rất khác nhau và giấu độ trễ của tầng chậm**:

1. **Tầng tức thì (local, trong RAM):** lọc danh sách chat/liên hệ theo tên, chạy trên mỗi phím gõ. Index được **dựng sẵn khi tên thay đổi**, không dựng khi tìm. Tra cứu = 1 lần tìm trong map theo chữ cái đầu + duyệt danh sách nhỏ nhất.
2. **Tầng server (tin nhắn):** toàn bộ tìm tin nhắn nằm ở server Telegram (`messages.search`, `messages.searchGlobal`). Client chỉ: debounce, huỷ request cũ, **cache trang đầu theo chuỗi query**, phân trang 50 tin/lần bằng `next_rate`.
3. **Cache theo query ở mọi tầng:** gõ lại/xoá lùi về một query đã gặp thì hiện kết quả **ngay**, không gọi mạng.

Phần "nhanh thật sự" của tìm tin nhắn là index của **server** Telegram, thứ REA trên client không quan sát được.

---

## 1. Tầng local: `Dialogs::IndexedList` — index chữ cái đầu dựng sẵn

**Quan sát binary:** path `dialogs/dialogs_indexed_list.cpp`, `dialogs/dialogs_entry.cpp`, `dialogs/dialogs_list.cpp` (L206675–206705); không có RTTI riêng của `IndexedList` (lớp không đa hình, không lambda), điều này bình thường.

**Nguồn v7.3.1:**
- Cấu trúc: `IndexedList { List _list; mutable base::flat_map<QChar, List> _index; }` (`dialogs_indexed_list.h`). Mỗi chat nằm trong danh sách đầy đủ **và** trong một danh sách con cho **mỗi chữ cái đầu của mỗi từ** trong tên.
- Từ khoá index dựng ở `PeerData::fillNames()` (`data_peer.cpp` L1081), chạy **khi tên đổi**, không phải khi tìm:
  - `RemoveAccents(name)`; thêm bản chuyển tự Nga→Latin nếu tên có chữ Kirin; thêm `nameOrPhone`, `username`; với "Saved messages"/"Replies" thêm cả tên tiếng Anh lẫn bản dịch.
  - Kết quả cache trong peer: `_nameWords`, `_nameFirstLetters`. Đổi tên → `nameUpdated(oldFirstLetters)` → `IndexedList::peerNameChanged` chỉ chuyển chat giữa các danh sách con bị ảnh hưởng (cập nhật tăng dần).
- Truy vấn: `PrepareSearchWords(query)` = `trim` + `toLower` + `RemoveAccents` + tách từ (`lib_ui text_entity.cpp` L1496).
- `IndexedList::filtered(words)` (L234–284):
  1. Với mỗi từ của query, lấy danh sách con theo `word[0]`; nếu một từ không có danh sách → trả rỗng ngay.
  2. Chọn **danh sách con nhỏ nhất** làm ứng viên.
  3. Duyệt ứng viên, giữ chat mà **mọi** từ query là **tiền tố** của một từ trong `chatListNameWords()`.
- `InnerWidget::refreshFilterResults()` (L4348) ghép kết quả từ: danh sách chat chính, thư mục Archive (nếu đã tải), `contactsNoChatsList()`, rồi thêm kết quả peer từ server (`_filterResultsGlobal`), bỏ trùng.

**Suy luận — vì sao nhanh:**
- Chi phí mỗi phím ≈ O(số chat có chung chữ cái đầu hiếm nhất), so sánh `startsWith` trên chuỗi đã chuẩn hoá sẵn. Vài nghìn chat vẫn dưới 1 ms. Không I/O, không SQL, không chuẩn hoá lại tên.
- Đổi lại: chỉ khớp **tiền tố của từ** ("ngu" khớp "Nguyễn", "uyen" thì không) và chỉ tìm **tên**, không tìm nội dung tin.

## 2. Tầng server: tìm tin nhắn

**Quan sát binary:** `Api::MessagesSearch::searchRequest`, `Api::MessagesSearchMerged`, `Api::SearchController::{simpleIdsSlice,idsSlice,requestMore}`, `Api::DelayedSearchController`, `Api::PeerSearch::{requestPeers,requestSponsored}`, `Api::SingleMessageSearch::performLookupBy{Id,Channel,Username}`, `Dialogs::Widget::{search,searchMore,searchTopics,fullSearchRefreshOn}`, `Dialogs::InnerWidget::searchReceived`, `Dialogs::SearchRequestDelay`, `Dialogs::SearchRequestType`; TL `MTPmessages_search`, `MTPmessages_searchResultsCalendar`, `MTPcontacts_found`. Không có chuỗi `sqlite`, không có lớp nào gợi ý index tin nhắn local (đã ghi ở báo cáo 261014 mục 2 và 4).

**Nguồn v7.3.1 (`dialogs_widget.cpp`):**

| Cơ chế | Chi tiết | Tác dụng |
|---|---|---|
| Debounce | `kSearchRequestDelay = 900 ms`; `SearchRequestDelay::Instant` (Enter, đổi tab/bộ lọc) bỏ qua debounce | Không bắn request mỗi phím |
| Cache trang đầu theo query | `process->cache[query] = result` khi trang đầu về (L3636–3639). Lần gõ sau `search(inCache=true)` tìm trong cache trước, có thì `searchReceived(..., cacheResults=true)` **ngay** (L3156–3180) | Xoá lùi / gõ lại query cũ = 0 ms mạng |
| Huỷ/ bỏ request cũ | `cancelSearchRequest()` khi query đổi; `process->queries[requestId] = query` để biết response thuộc query nào | Không hiện kết quả lệch query |
| Phân trang | `kSearchPerPage = 50`; global dùng `messages.searchGlobal` với `offset_rate` = `next_rate` server trả về (L3594, L3699–3706) | Trang đầu nhỏ, cuộn mới tải tiếp |
| Tìm trong 1 chat | `messages.search` gửi qua `Histories::sendRequest` (xếp hàng theo history) | Không tranh chấp với request tải lịch sử cùng chat |
| Tìm peer song song | `Api::PeerSearch` gọi `contacts.search`, cache `_cache[query]` với trạng thái `requested/peersReady/sponsoredReady`; chế độ `CacheOnly` khi đang trong pha "chỉ cache" | Tên người/kênh công khai xuất hiện cùng lúc với lọc local |
| Tra cứu 1 tin theo link/username | `SingleMessageSearch` (query là link `t.me/...`) chèn kết quả lên đầu | Dán link → nhảy tới tin ngay |

**Tìm media/tin trong 1 chat** (`data_search_controller.cpp`): `SearchController` giữ `_cache` theo `Query`, mỗi entry là `SparseIdsSlice` (tập id thưa, tải dần quanh vị trí đang xem, `kSharedMediaLimit = 100`). `DelayedSearchController::setQuery` (L586): nếu `hasInCache(query)` → `setQueryFast` ngay; không thì hẹn giờ `kDefaultSearchTimeoutMs = 200 ms`. `Api::MessagesSearch` cache trang theo token (`_cacheOfStartByToken`).

**Suy luận:** độ "nhanh" của tìm tin nhắn mà người dùng cảm nhận đến từ (a) server Telegram có index riêng và trả 50 kết quả đã xếp hạng, (b) client không chặn UI: tầng local hiện ngay, kết quả server ghép vào sau, (c) cache theo query khiến thao tác lặp lại tức thì. Client **không** có FTS local, nên offline thì không tìm được nội dung tin.

## 3. Sơ đồ luồng một lần gõ phím

```
phím gõ
 ├─► PrepareSearchWords (lower + bỏ dấu + tách từ)
 ├─► IndexedList::filtered  ── RAM, mỗi phím ──► hiện ngay danh sách chat/liên hệ
 ├─► PeerSearch (cache theo query, không có thì contacts.search) ──► ghép peer từ server
 └─► Widget::search(inCache=true)
        ├─ có trong process->cache[query] ──► hiện kết quả tin ngay
        └─ không có ──► hẹn 900 ms ──► messages.searchGlobal / messages.search (50/trang)
                              └─► response: đúng query? lưu cache[query] ──► ghép vào list
cuộn cuối ──► searchMore(offset_rate = next_rate)
```

## 4. Đối chiếu với chat-next (để tham khảo, chưa đổi gì)

chat-next đã **vượt** Telegram Desktop ở tầng nội dung: có FTS5 local trên `search_text` vifold (`packages/core/src/repo/migrations.ts`) nên tìm tin chạy được offline; server có `search_tsv` + GIN `pg_trgm` (`server/README.md` L112–113); `search/session.ts` đã chạy local ngay, debounce server `SERVER_DEBOUNCE_MS = 350`, bỏ response cũ theo `generation`, phân trang `SERVER_PAGE = 20`.

Các điểm Telegram có mà chat-next chưa thấy trong lần đọc lướt này (chưa kiểm sâu):

| Kỹ thuật Telegram | Ở chat-next | Gợi ý |
|---|---|---|
| Cache trang đầu kết quả server **theo chuỗi query** | `search/session.ts` không có cache theo query | Thêm LRU nhỏ (ví dụ 20 query) trong session: xoá lùi về query cũ hiện ngay, không gọi lại server |
| Index tên chat dựng sẵn khi tên đổi, lọc tiền tố từ trong RAM | Chưa xác định cách lọc danh sách chat theo tên | Nếu đang lọc bằng cách chuẩn hoá tên trên mỗi phím, giữ sẵn `nameWords` đã fold (vifold) cho mỗi chat |
| Tìm peer song song có cache theo query | `people-search.ts` có debounce, chưa kiểm cache | Cache kết quả `SearchUsers` theo query |

Các con số (900 ms, 50/trang, 200 ms) là lựa chọn của Telegram; không nên chép, chat-next nên tự đo.

## 5. Giới hạn và câu hỏi còn mở

- Không decompile binary, nên không chứng minh từng hằng số trong binary trùng với nguồn v7.3.1; chỉ chứng minh các lớp/hàm đó **có mặt** và version/path khớp.
- Index phía server Telegram (cấu trúc, công nghệ) không quan sát được từ client; mọi nhận định về server là ngoài phạm vi REA.
- Không đo thời gian chạy thực tế (không quan sát runtime).
- Bảng đối chiếu chat-next dựa trên đọc lướt `packages/core/src/search/*`; cần kiểm kỹ phần lọc danh sách chat theo tên trước khi làm.
