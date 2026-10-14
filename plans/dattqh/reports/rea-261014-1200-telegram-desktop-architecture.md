# REA — Kiến trúc client Telegram Desktop 7.3.1 (macOS arm64) qua kiểm kê chuỗi tĩnh

- **Artifact:** `/Applications/Telegram.app/Contents/MacOS/Telegram`, Telegram Desktop **7.3.1**, Mach-O **arm64**
- **sha256:** `1a3c87057ae4ea810cd886ee31033cc52fac408523f9d555684d1339ea1ec227`
- **Evidence ID (REA, Mach-O):** `ev_e92380557ae0528ec07cd7d6022ea5722597548aa92f473b3c5d07e2315c1135`. Framework được link: AppKit, WebKit, UserNotifications, VideoToolbox, Metal, Network, NaturalLanguage, Translation, ScreenCaptureKit, LocalAuthentication…; không có chuỗi sqlite.
- **Phương pháp:** REA kiểm tra Mach-O cộng với kiểm kê chuỗi `strings -n 6` (218.971 dòng, file `scratchpad/tg-strings.txt`). Tên RTTI được demangle bằng `c++filt` (thêm tiền tố `_ZTS`). **Không** decompile, **không** quan sát lúc chạy.
- **Cách đọc bằng chứng:** `L<n>` là số dòng `grep -n` trong file chuỗi. Tên kiểu ghi dạng đã demangle.
- **Giới hạn chung:** chuỗi có mặt chỉ chứng minh code hoặc kiểu đó **tồn tại** trong binary. Nó không cho biết hành vi lúc chạy, nhánh nào được dùng, hay giá trị hằng số (timeout, giới hạn). Binary đã strip nên chỉ thấy tên phương thức khi chúng xuất hiện trong lambda/`std::function` RTTI, chuỗi log, hoặc assert. Thiếu một tên **không** chứng minh tính năng không có.
- **Bối cảnh build:** đường dẫn nguồn `/Users/preston/Telegram/tdesktop/Telegram/SourceFiles/...` còn trong binary (845 path duy nhất, ví dụ L204847), build `out/mac-26.6/Release/arm64` (L198557), Qt 6.11.2 (L213428).
- Ngày: 2026-10-14 (Asia/Saigon). Plan đối chiếu: `../261013-0448-chat-platform-v1/` (plan.md, phase 05, 07, 08, 11; đọc lướt thêm 02, 03, 04, 06, 09, 10).

---

## 1. Sync engine, phiên và kết nối

### 1.1 `Api::Updates` — quan sát

- Lambda RTTI của các phương thức (L61659–61719):
  - `Api::Updates::Updates(gsl::not_null<Main::Session*>)::$_0…$_11`; `$_11` nhận `tl::boxed<MTPupdates_state>` (L61683).
  - `Api::Updates::getDifference()::$_1` nhận `MTPupdates_difference`, `$_0` nhận `MTP::Error` (L61696–61700).
  - `Api::Updates::getChannelDifference(gsl::not_null<ChannelData*>, Api::Updates::ChannelDifferenceRequest)` (L61703–61707).
  - `Api::Updates::channelRangeDifferenceSend(gsl::not_null<ChannelData*>, MsgRange, int)` (L61712–61715).
  - `Api::Updates::addActiveChat(rpl::producer<PeerData*>)` (L61708).
  - `Api::Updates::updateOnline(long long, bool)` (L61716).
- Kiểu TL (RTTI): `MTPDupdates_differenceEmpty`, `MTPDupdates_difference`, `MTPDupdates_differenceSlice`, `MTPDupdates_differenceTooLong` (L33731–33734); `MTPDupdates_channelDifferenceEmpty/TooLong`, `MTPDupdates_channelDifference` (L33856–33858); `MTPDupdateChannelTooLong` (L33602); `MTPDupdates_state` (L33730); `MTPDupdateShortMessage`, `MTPDupdateShortChatMessage`, `MTPDupdateShort`, `MTPDupdatesCombined`, `MTPDupdateShortSentMessage` (L33735–33740).
- Chuỗi log ngay trước path `api/api_updates.cpp` (L204840–204867):
  - `getChannelDifference { good - after not final channelDifference was received }%1` (L204840)
  - `RPC Error in getChannelDifference: %1 %2: %3` (L204842)
  - `getDifference { good - after a slice of difference was received }%1` (L204843)
  - **`API Error: updates.differenceTooLong is not supported by Telegram Desktop!`** (L204844)
  - `getDifference { force - after get difference failed }%1` (L204846)
  - `getChannelDifference { good - after channelDifferenceTooLong was received, validating history part }%1` (L204848), kèm assert `"range.from < range.till"` (L204849)
  - `getChannelDifference { good - after not final channelDifference was received, validating history part }%1` (L204850)
  - **`getDifference { after new_session_created }%1`** (L204851)
  - `Api::Updates prevents quit, sending offline status...` (L204853)
  - `Unexpected: Type in applyUpdatesNoPtsCheck()` / `applyUpdateNoPtsCheck()` (L204854, L204856)
  - `Skipping message, because it is already in blocks!` (L204855)
  - `getDifference { good - after not all data loaded in updateShortMessage }` / `…updateShortChatMessage` / `…updateNewChannelMessage` (L204857, L204858, L204862)
  - `getDifference { good - updatesTooLong received }` (L204860); `getDifference { good - getting peer for updateNewMessage }` (L204861)
  - `Skipping new channel message because getting the difference.`, cùng các biến thể cho edit, pinned, delete, web page (L204863–204867)
- `ChannelData` chỉ xuất hiện như tham số `gsl::not_null<ChannelData*>` của các hàm difference. Không thấy tên `PtsWaiter` hay phương thức `ChannelData::pts*` trong chuỗi.

### 1.2 `Api::Updates` — suy luận (chưa kiểm chứng lúc chạy)

- **Suy luận:** state được giữ ở hai mức. Mức tài khoản là `updates.state` / `getDifference`, xử lý theo slice cho tới khi không còn slice. Mức từng channel là `getChannelDifference` theo `ChannelData`, lặp khi difference chưa "final". Cấu trúc này khớp với thiết kế `GetDifference` + `GetChatDifference` của plan.
- **Suy luận:** client có hai đường áp update: có kiểm pts (thứ tự theo pts) và không kiểm pts (`applyUpdatesNoPtsCheck`, dùng cho dữ liệu lấy từ difference). Có khử trùng theo id tin ("already in blocks").
- **Suy luận:** khi đang lấy difference của một channel, update realtime của channel đó bị **bỏ qua** chứ không xếp hàng ("Skipping … because getting the difference"). Difference sẽ mang lại các update đó.
- **Suy luận:** `too_long` của tài khoản không có nhánh khôi phục riêng; chuỗi coi đó là lỗi API. `too_long` của channel được xử lý bằng cách **chỉ kiểm lại khoảng lịch sử đang tải** (`channelRangeDifferenceSend` + `MsgRange`), không tải lại toàn bộ.
- **Suy luận:** có ba điều kiện kích hoạt getDifference đáng chú ý:
  1. Server báo `new_session_created`, tức phiên phía server bị reset.
  2. Update dạng rút gọn tham chiếu user hoặc chat mà client chưa có ("not all data loaded").
  3. Gọi getDifference thất bại; khi đó client buộc gọi lại ("force").
- **Suy luận:** `addActiveChat` dùng để theo dõi riêng các channel đang mở. Binary không cho biết đó là poll hay subscribe.

### 1.3 Phiên và kết nối MTProto — quan sát

- Lớp: `MTP::Instance`, `MTP::details::Session`, `SessionData`, `SessionPrivate`, `Dcenter`, `ConfigLoader`, `SpecialConfigRequest`, `DomainResolver`, `AbstractConnection`, `TcpConnection` (+`Protocol`), `HttpConnection`, `ResolvingConnection`, `TcpSocket`, `TlsSocket`, `WebProxySocket`, `MTP::ProxyData` (+`Type`, `Settings`), `MTP::ConcurrentSender`, `MTP::Sender`, `MTP::DedicatedLoader` (L31790, L33362–33375, L59597, L68718–68746, L125079–125294).
- Transport: path `connection_tcp.cpp`, `connection_http.cpp`, `connection_resolving.cpp` (L208041–208051). Log: `HTTP-transport connected by pq-response.` (L208042), `Valid pq response by TCP.` (L208072), `mtproxy ` / `webproxy ` (L208069–208070).
- Kiểu proxy: assert `"type == Type::Mtproto || type == Type::Web"` (L198548); `tdesktop-web-proxy-bridge-v1/v2` (L198549–198550). TLS giả lập: `Could not generate Client Hello.`, `Bad Server Hello digest.` (L198461–198465); secret `0xEE` (L198459). Có `core/proxy_rotation_manager.cpp` (L205811). Thông báo SOCKS5 lấy từ Qt: `Connection not allowed by SOCKSv5 server` (L189718).
- **WebSocket:** **không** thấy WebSocket trong transport chính. Chuỗi WebSocket chỉ nằm trong `mtproto/web_proxy/web_proxy_transport.cpp` (L208393–208421). Đó là một server HTTP cục bộ: `127.0.0.1:` (L208400), `/transport` (L208403), `HTTP/1.1 101 Switching Protocols` (L208411), cùng một "carrier" WebView (`Web Proxy Error: WebView carrier failed: %1`, L208449). Webview đó bị khoá bằng `WKContentRuleList` `tdesktop-web-proxy-restricted` + `url-filter` (L213514–213520).
- Phiên và keepalive:
  - `MTP Main Session`, `MTP %1 Session (%2)`, `MTP Other Session` (L208152–208156); `Download` / `Upload` (L208146–208147); hậu tố `_media` (L208038).
  - `MTP Info: sending ping, ping_id: %1` và `sending ping_delay_disconnect` (L208210–208211); TL dump `{ ping_delay_disconnect` / `disconnect_delay:` (L203650–203651).
  - `Could not send ping for some seconds, restarting...` (L208225); `This connection marked as old! _waitForReceived now %1ms` (L208224); `MTP Info: bad connection, _waitForReceived: %1ms` (L208228); `MTP Info: restart timeout: %1ms` (L208220).
  - `Connection Info: Connecting to %1 with %2 test connections.` (L208218); `connection %1 succeed, waiting for %2.`, `connection through IPv4 succeed.`, `can't connect through better, using %1.` (L208314–208316).
  - `MTP Info: dcWithShift %1 can wait for %2ms from current %3` (L208172); `adding request to toSendMap, msCanWait %1` (L208176); `Message Info: container received, count: %1` (L208247).
  - Lỗi điều hướng: `^(FILE|PHONE|NETWORK|USER)_MIGRATE_(\d+)$`, `^FLOOD_WAIT_(\d+)$`, `^SLOWMODE_WAIT_(\d+)$` (L208133–208136).
- Config và dcOptions:
  - `MTP Info: got config, chat_size_max: %1, date: %2, test_mode: %3, this_dc: %4, dc_options.length: %5` (L198483); `MTP Info: adding built in DC %1 connect option` (L198486); IP DC dựng sẵn (L198513–198529); file `.tdesktop-endpoints` (L198530).
  - Config dự phòng qua DNS-over-HTTPS: `dns.google.com`, `mozilla.cloudflare-dns.com` (L208344–208345), `/dns-query`, `/resolve` (L198431–198432).
  - Trường config do server đẩy: `online_update_period_ms`, `offline_blur_timeout_ms`, `offline_idle_timeout_ms`, `notify_cloud_delay_ms`, `notify_default_delay_ms`, `edit_time_limit`, `revoke_time_limit` (L200167–200176).
  - AppConfig có hơn 30 key giới hạn dạng `*_default`/`*_premium`, ví dụ `dialog_filters_limit_default`, `upload_max_fileparts_default` (L206473–206510).

### 1.4 Phiên và kết nối — suy luận

- **Suy luận:**
  - Mỗi DC có nhiều phiên logic: phiên chính nhận update, còn tải lên và tải xuống chạy trên phiên "shifted" riêng. Nhờ vậy file lớn không chặn kênh update.
  - Client gom nhiều request vào một container, có độ trễ cho phép (`msCanWait`).
  - Kết nối dùng chiến lược "chạy đua nhiều kết nối thử", tương tự happy eyeballs với IPv4/IPv6 và TCP/HTTP.
  - Keepalive dùng ping kèm `disconnect_delay` để server tự đóng kết nối chết. Client tự đánh dấu kết nối "old" hoặc "bad" theo thời gian chờ phản hồi rồi khởi động lại.
- **Không rõ:** giá trị cụ thể của timeout, chu kỳ ping và gap timer. Binary không lộ các hằng số này. Mã nguồn tdesktop công khai (GPL) ở tag v7.3.1 có thể xác nhận, nhưng báo cáo này **chưa** đối chiếu.

---

## 2. Lưu trữ local

### Quan sát

- **Không có SQLite:** `grep -ci sqlite` = 0. Không có `CREATE TABLE`, `fts5`, LevelDB hay LMDB (các hit "fts/realm" đều là dương tính giả trong tên mangled).
- **Thư viện `lib_storage`:** `storage_databases.cpp`, `storage_encrypted_file.cpp`, `storage_encryption.cpp`, `cache/storage_cache_binlog_reader.cpp`, `storage_cache_compactor.cpp`, `storage_cache_database_object.cpp`, `storage_cache_types.cpp` (L204503–204551).
  - Lớp: `Storage::Cache::Database`, `details::DatabaseObject`, `CompactorObject`, `CleanerObject`, `details::Settings`, `Storage::Cache::Key`, `TaggedValue`.
  - Assert lộ cấu hình: `_settings.maxDataSize`, `maxBundledRecords`, `totalTimeLimit`, `totalSizeLimit`, `staleRemoveChunk`, `compactChunkSize`, `trackEstimatedTime`, `_binlogExcessLength` (L204525–204542).
- **Mã hoá file:** `"bytes.size() % kBlockSize == 0"`, `"_encryptionOffset >= bytes.size()"` (L204513–204514); `"_data.size() == kSize || _data.size() == kSize_v2"`, `"salt.size() == kSaltSize"` (L204517–204518).
- **Lưu trữ tài khoản (`storage/storage_account.cpp`, L209173–209212):**
  - `App Info: reading map...`, `bad salt in map file`, `could not decrypt pass-protected key from map file`, `reading encrypted map...`, `unknown key type in encrypted map: %1` (L209175–209181).
  - `reading encrypted user settings`, `reading encrypted mtp data`, `reading encrypted mtp config` (L209185–209193).
  - Cache media: `media_cache` (L209200); `"_cacheTotalSizeLimit > normal.maxDataSize"`, `"_cacheBigFileTotalSizeLimit > normal.maxDataSize"` (L209189–209190); `"update.totalSizeLimit > Database::Settings().maxDataSize"`, `"update.totalTimeLimit >= 0"` (L209197–209198).
  - Có lưu nháp (`"source.draft != nullptr"`, L209194). Có lưu bộ sticker, GIF đã lưu (`Init: Read installed sticker sets.`… L209202–209212) và hashtag gần đây (`Storage::Account::saveRecentSentHashtags`).
- **Domain và nhiều tài khoản (`storage/storage_domain.cpp`, L209230–209278):**
  - `reading accounts info...`, `bad accounts count`, `the app lock is on, a passcode is needed`.
  - Khoá local bọc nhiều lớp: `key data wrap count`, `KDF family`, `wrap salt size`, `duplicate key data wrap generation`.
  - KDF: `App Error: Argon2id derivation failed.`, `Scrypt derivation failed.` (L209021–209022); `key_data` (L208961).
  - Lớp `Main::Domain`, `Main::Account`, `Main::Session` (L87727, L68720, L32054); `Storage::Account`, `Storage::Domain`.
- **Thư mục:** `tdata/emoji`, `tdata/fonts`, `tdata/countries`, `tdata/prefix`, `tdata/update-manifest`, `tdata/experimental_options.json` (L205894–209134).
- **Khoá MTP lưu local:** `MTP::AuthKey` (L121033); `AuthKey Info: writing auth keys, called by dc %1` (L208113).
- **UI giới hạn cache:** `settings_local_storage.cpp` với `"good(_mediaSizeLimit)"`, `"good(_totalSizeLimit)"` (L208962–208964).
- **Index trong bộ nhớ:** `Storage::SharedMedia` (`SharedMediaType`, `SharedMediaSliceUpdate`, `SharedMediaInvalidateBottom`), `storage_sparse_ids_list.cpp` (L209292–209294).

### Suy luận

- **Suy luận (khá chắc):** Telegram Desktop **không lưu lịch sử tin nhắn vào DB bền vững**. Không có engine DB, và danh sách mục mà `Storage::Account` đọc lúc init không có tin nhắn. Tin chỉ nằm trong `Data::Session`/`History` trong RAM, lấy lại từ server mỗi lần chạy.
- Phần bền vững gồm: khoá MTP, config, settings, nháp, sticker và cache **media** dạng key–value (binlog + compactor + cleaner, có trần dung lượng và trần thời gian, ngân sách riêng cho file lớn). Toàn bộ mã hoá bằng khoá local. Khoá local có thể được passcode bọc thêm (Argon2id/Scrypt).
- **Không rõ:** giá trị mặc định của `totalSizeLimit`/`totalTimeLimit`. Thuật toán mã hoá cụ thể: `kBlockSize` gợi ý AES dạng khối, nhưng chưa xác nhận chế độ.

---

## 3. Media

### Quan sát

- **Streaming:** path `media/streaming/*` (L207654–207753).
  - Lớp `Media::Streaming::Player`, `Document`, `VideoTrack`, `AudioTrack`, `Reader`, `LoadedPart`, `SpeedEstimate`, `QualityDescriptor`, `Loader`, `LoaderMtproto`, `LoaderLocal`, `RoundPreview`.
  - FFmpeg: `av_seek_frame`, `av_read_frame`, `avformat_find_stream_info` (L207666–207669).
  - Assert của Reader: `"buffer.size() <= kInSlice"`, `"waitingForHeaderCache()"`, `"_headerMode != HeaderMode::NoCache"`, `"!(flags & Flag::LoadedFromCache)"` (L207713–207736).
  - Giải mã phần cứng: `^{OpaqueVTDecompressionSession=}` (L218703); có `media/media_video_encode.cpp` (L207800).
- **Tải xuống (`storage/download_manager_mtproto.cpp`):**
  - `Download (%1,%2) adding, now sessions: %3`, `session timed-out`, `removing, now sessions: %3`, `increased max waited amount` (L209054–209058).
  - Assert `kStartSessionsCount`, `kMaxWaitedInSession * kMaxSessionsCount` (L209057–209059).
  - CDN: `API Error: Wrong cdnFileHash for offset %1.` (L209064); `Storage::DownloadMtprotoTask::requestMoreCdnFileHashes`, `cdnPartLoaded` (L136966–136990); `MTPDupload_fileCdnRedirect` (L33745), `MTPDupload_cdnFileReuploadNeeded` (L34031), `MTPDfileHash` (L34106).
- **Tải lên (`storage/file_upload.cpp`):**
  - `Uploader: Added dc index %1.`, `Slow request, removing dc index.`, `Mark %1 of %2 as fast.` (L209096–209106).
  - `Storage::Uploader::sendPreparedRequest<MTPupload_saveBigFilePart>` (L137066); `Storage::Uploader::runTranscode` (L137061); `upload_max_fileparts_default/premium` (L206502–206503).
- **Tham chiếu file:** `Data::FileOrigin`, `Data::UpdatedFileReferences` (L61298, L61301), `Data::FileOriginStickerSet`, `FileOriginSavedGifs`. Ví dụ `PhotoData::load(Data::PhotoSize, Data::FileOrigin, …)` (L90638).
- **Thumbnail:** `MTPDphotoStrippedSize`, `MTPDphotoPathSize` (L33540–33542); `"(_flags & Flag::GoodThumbnailWanted) != 0"` (L206290); `App Error: Bad thumbnail data for saving to cache.` (L207661).

### Suy luận

- **Suy luận:**
  - Player stream qua Reader chia slice. Header được cache riêng, các part được cache vào `Storage::Cache`.
  - Client ước lượng tốc độ để chọn chất lượng (`QualityDescriptor`, `SpeedEstimate`).
  - Tải xuống tự tăng hoặc giảm số phiên song song theo từng DC dựa trên thời gian phản hồi. Tải lên đánh dấu DC/phiên "nhanh" hoặc "chậm".
  - File reference hết hạn được làm mới theo "origin", tức ngữ cảnh chứa file, rồi request được thử lại.
- **Không rõ:** kích thước part, số phiên tối đa, ngưỡng "slow".

---

## 4. Tìm kiếm

### Quan sát

- Server search:
  - `Api::MessagesSearch::searchRequest`, `Api::MessagesSearch::Request`, `Api::MessagesSearchMerged::MessagesSearchMerged(History*)` phát `Api::FoundMessages` (L60779–60790, L98518).
  - TL `MTPmessages_search`, `MTPmessages_searchResultsCalendar` (L31485, L34265); `Api::SearchCalendarController`.
- Media và chat:
  - `Api::SearchController::simpleIdsSlice(PeerId, MsgId, PeerId, MsgId, Query const&, int, int)` → `SparseIdsSlice` (L90941); `data/data_search_controller.cpp` với `API Error: received messages.channelMessages when no channel was passed! (ParseSearchResult)` (L206545).
- Danh sách chat:
  - `Dialogs::Widget::search(bool, Dialogs::SearchRequestDelay)`, `searchMore`, `searchTopics`, `fullSearchRefreshOn` (L94149–94311); `Dialogs::SearchState`, `SearchRequestType`, `SearchTags`, `PostsSearch`, `ChatSearchIn`.
  - `dialogs/dialogs_indexed_list.cpp` (L206679).
  - `Api::PeerSearch::requestPeers`, `Api::SingleMessageSearch::performLookupBy{Channel,Id,Username}`.
- NaturalLanguage: chỉ thấy selector `dominantLanguageForString:` (L216101) và `languageHypothesesWithMaximum:` (L216566). Không thấy dùng NL cho tokenize hay index.

### Suy luận

- **Suy luận (khá chắc):** tìm tin nhắn **hoàn toàn ở server**. Không có index full-text local, điều này khớp với việc không lưu lịch sử local (mục 2).
- Phía client chỉ có:
  - Lọc tên chat trong bộ nhớ: `Dialogs::IndexedList`, có lẽ index theo chữ cái đầu. Đây là suy luận từ tên file.
  - Debounce request (`SearchRequestDelay`).
  - Gộp kết quả (`MessagesSearchMerged`, ví dụ gộp group cũ đã migrate sang supergroup).
- NaturalLanguage nhiều khả năng chỉ dùng để **nhận diện ngôn ngữ** cho tính năng dịch (`HistoryView::TranslateTracker`, L105320). Các selector trên là API của `NLLanguageRecognizer` hoặc `NSLinguisticTagger`, nên đây là suy luận.

---

## 5. Bot và Mini Apps

### Quan sát

- **Inline bot, bàn phím, callback:**
  - `InlineBots::Result`, `InlineBots::Layout::ItemBase`, `InlineBots::ResultSelected` (L78573–85276).
  - `MTPDbotInlineResult`, `MTPDmessages_botResults`, `MTPDmessages_botCallbackAnswer` (L33881–33897); `MTPmessages_sendInlineBotResult`.
  - `ReplyKeyboard`, `HistoryMessageMarkupButton`, `ReplyMarkupClickHandler`, `BotKeyboard`.
  - `MTPDkeyboardButton`, `MTPDkeyboardButtonRow`, `MTPDreplyKeyboardHide/ForceReply/Markup`, `MTPDreplyInlineMarkup` (L33820–33825).
  - `MTPDupdateBotCallbackQuery`, `MTPDupdateInlineBotCallbackQuery` (L33615–33617).
  - `Api::SendBotCallbackDataWithPassword`, `Api::ActivateBotCommand` (L59746–59774).
- **WebView của Mini App:**
  - `InlineBots::WebViewInstance` với các nguồn mở: `WebViewSourceButton`, `WebViewSourceSwitch`, `WebViewSourceLinkBotProfile`, `WebViewSourceBotMenu`, `WebViewSourceBotProfile`, `WebViewSourceJoinChat`; `InlineBots::AttachWebView` (L118953–119029).
  - `Ui::BotWebView::Panel`, `Delegate`, `CustomMethodRequest`, `SendPreparedMessageRequest`, `RequestChatRequest`, `DownloadFileRequest` (L56249–119239).
- **49 sự kiện `web_app_*`** (L197935, L204199–204252, L207287), trong đó có:
  - `web_app_close`, `web_app_data_send`, `web_app_setup_main_button`, `web_app_setup_back_button`, `web_app_request_theme`, `web_app_request_viewport`, `web_app_request_safe_area`.
  - `web_app_open_link`, `web_app_open_tg_link`, `web_app_open_invoice`, `web_app_open_popup`, `web_app_request_write_access`, `web_app_request_phone`, `web_app_invoke_custom_method`, `web_app_setup_closing_behavior`, `web_app_read_text_from_clipboard`.
  - `web_app_device_storage_{save_key,get_key,clear}`, `web_app_secure_storage_{save_key,get_key,restore_key,clear}`, `web_app_request_file_download`, `web_app_biometry_get_info`, `web_app_allowed_protocols`.
  - Chiều ngược lại (client → app): `viewport_changed`, `theme_changed`, `safe_area_changed`, `main_button_pressed`, `back_button_pressed`, `popup_closed`, `invoice_closed`, `file_download_requested` (L204147–204269).
- **Cầu nối JS:**
  - `window.TelegramWebviewProxy = { postEvent: function(eventType, eventData) { … window.external.invoke(JSON.stringify([eventType, eventData]))` (L204142–204145).
  - Trên mac: `window.external = { invoke: function(s) { window.webkit.messageHandlers.external.postMessage(s);` (L213483–213485); `addScriptMessageHandler:name:` (L215678); `WKScriptMessageHandler`, `WKNavigationDelegate` (L218188–218189).
- **Bảo vệ ở cầu nối:**
  - `BotWebView Error: Native message rejected: %1 (%2 bytes).` (L204255–204256).
  - `this.location.origin === ` (L204191).
  - `BotWebView Error: Post event "%1" on crashed webview.`, `Drop raw external event "%1".` (L204184–204185).
  - Kiểm từng tham số: `Bad 'url' in download request.`, `Bad url in openExternalLink.`, `Bad 'slug' in openInvoice.` (L204152–204181).
- **Hosting:**
  - Scheme riêng `desktopappresource://domain/`, `http://desktop-app-resource/page.html` (L213472, L213487); `<WKURLSchemeTask>` (L218836).
  - `Webview::StorageId` (219 lần), `dataStoreForIdentifier:` (L216002), `nonPersistentDataStore` (L216802).
  - `Webview::Window::navigationPolicyHandler`, `permissionHandler`, `dataRequestHandler`.
  - Cờ thử nghiệm `Enable webview inspecting` (L213433); thuộc tính `developerExtrasEnabled`, `fraudulentWebsiteWarningEnabled`, `mediaDevicesEnabled`, `DOMPasteAccessRequestsEnabled` (L213480–213491).
  - `tdesktop_external_bot_webapp` (L204257).
- **Thanh toán:** `Payments::CheckoutProcess`, `Payments::Form`, `StripePaymentMethod`, `SmartGlocalPaymentMethod`, `ProcessCreditsPayment` (L126327–126472).
- **Script khoá webview khác:** trong `lib_webview/webview_embed.cpp` có script chèn CSP + `x-dns-prefetch-control` và khoá `localStorage`, `indexedDB`, `Worker`, `serviceWorker`, `geolocation`, `open`, `alert`, `document.cookie` (L213441–213464). Script này **không** thuộc code bot webview.

### Suy luận

- **Suy luận:** Mini App chạy trong WKWebView nhúng. Giao tiếp là một message handler duy nhất với payload JSON `[eventType, eventData]`. Native kiểm kích thước message và kiểm từng trường trước khi xử lý.
- **Suy luận:** dữ liệu web (cookie, localStorage) được cô lập theo từng ngữ cảnh qua `StorageId` → `WKWebsiteDataStore dataStoreForIdentifier:` (API có từ macOS 14), hoặc dùng store không bền.
- **Suy luận:** điều hướng đi qua `navigationPolicyHandler`, nên link ngoài có thể bị chặn và mở bằng trình duyệt hệ thống.
- **Suy luận:** script khoá API ở L213441–213464 thuộc một webview "hạn chế", có lẽ cho Instant View hoặc nội dung không tin cậy, không phải Mini App.
- **Không rõ:** WebView của Mini App có bật inspect mặc định hay không, và chính sách CSP áp cho Mini App.

---

## 6. Thông báo trên desktop

### Quan sát

- **Kiến trúc:**
  - `Window::Notifications::System` (`registerThread`, `clearFromHistory`, `clearFromSession`, `showNext`).
  - `Window::Notifications::Manager` (`notificationActionActivated`, `NotificationId`, `NotificationFields`), `NativeManager::doShowNotification`, `Default::Manager` (toast tự vẽ), `DummyManager` (L146576–146685).
- **macOS:**
  - `Platform::Notifications::Manager` (NSUserNotification cũ) và `Platform::Notifications::UNManager` (UserNotifications). Có `UNManager::Private::clearAll/clearFromItem/clearFromTopic/clearFromSublist/clearFromHistory/clearFromSession` (L126538–126552).
  - Cờ cài đặt `Modern macOS notifications` / `Use UserNotifications framework for native notifications (macOS 10.14+)` (L209827–209828).
  - Delegate `NSUserNotificationCenterDelegate`, `UNUserNotificationCenterDelegate` (L218125–218127).
- **Hành động:**
  - Đánh dấu đã đọc: `actionId`, `markAsRead`, `TelegramMarkAsReadText/Timestamp/LanguageCode` (L208775–208779).
  - Trả lời: `actionWithIdentifier:title:options:textInputButtonTitle:textInputPlaceholder:` (L215639), `userText` (L217853), `setHasReplyButton:` (L217335), `Hide reply button` (L209829).
  - Category: `categoryWithIdentifier:actions:intentIdentifiers:options:`, `setNotificationCategories:` (L215851, L217433).
- **Dọn thông báo:** `removeDeliveredNotificationsWithIdentifiers:` (L217022), `getDeliveredNotificationsWithCompletionHandler:` (L216214).
- **Quyền:** `requestAuthorizationWithOptions:completionHandler:` (L217056); `App Warning: Notifications authorization denied.` (L208784).
- **Định tuyến:** `Received UN notification with instance %1, mine: %2` (L208780); `A notification with unknown session/peer/topic was received` (L208770–208772).
- **Badge:** `dockTile` (L216095), `setBadgeLabel:` (L217200); `Main::Domain::scheduleUpdateUnreadBadge` (L121156); `Data::IncludeMutedCounterFoldersValue` (L91761).
- **Cài đặt:** `Settings::NotificationsCount`, `Core::Settings::NotifyView`, `Data::NotifySettings` (`loadExceptions`, `forumParentMuteUpdated`), `Data::DefaultNotify`.
- **Độ trễ từ server:** `notify_cloud_delay_ms`, `notify_default_delay_ms` (L200171–200172).
- **Focus/DND:** không tìm thấy chuỗi nào về Focus, Do Not Disturb hay `interruptionLevel`. Cũng không có `threadIdentifier`.

### Suy luận

- **Suy luận:** client có hai backend native (UN mới và NSUserNotification cũ) và một backend tự vẽ. Notification mang định danh tới session, peer, topic và instance, nên nhiều tài khoản hoặc nhiều tiến trình không nhầm nhau.
- **Suy luận:** khi tin được đọc, kể cả đọc ở thiết bị khác, client xoá notification đã giao theo item, topic, chat hoặc session.
- **Suy luận:** client chờ trước khi hiện thông báo, theo `notify_cloud_delay_ms` hoặc `notify_default_delay_ms` do server cấp, để kịp huỷ nếu tin đã được đọc ở thiết bị khác.
- **Suy luận:** badge trên Dock gộp mọi tài khoản và được debounce. Người dùng chọn có tính chat bị tắt tiếng hay không.
- **Không rõ:** client có tôn trọng Focus/DND của macOS hay không, và có nhóm notification theo chat hay không (không thấy `threadIdentifier`).

---

## 7. Các mảng khác có ích cho plan

- **Bus thay đổi hạt mịn:**
  - Quan sát: `Data::Changes` với `Data::PeerUpdate::Flag`, `HistoryUpdate::Flag`, `TopicUpdate::Flag`, `MessageUpdate::Flag`, `EntryUpdate::Flag`, `StoryUpdate::Flag` (L88584–88746); `Data::Changes::realtimeNameUpdates`, `Data::Changes::Manager`.
  - Suy luận: có hai kênh phát, một kênh realtime và một kênh gom rồi phát sau.
- **Hàng đợi request theo chat:**
  - Quan sát: `Data::Histories::sendRequest(History*, RequestType, …)`, `finishSentRequest`, `readInbox`, `sendReadRequest`, `requestDialogEntry`, `postponeRequestDialogEntries`, `requestGroupAround`, `deleteMessages`, `deleteMessagesByDates`, `reportPendingDeliveries` (L89463–89568).
  - Suy luận: request trong cùng một chat (đọc, xoá, gửi) được sắp thứ tự theo loại để không tranh chấp nhau.
- **Đã đọc và typing:**
  - Typing: `Api::SendProgressManager::send` (+`Key`, L61288); `HistoryView::SendActionPainter`; TL `MTPDupdateUserTyping`, `ChatUserTyping`, `ChannelUserTyping`.
  - Đã đọc: `Api::WhoReadList` (L61839); `MTPDupdateReadHistoryInbox/Outbox`, `ReadChannelInbox/Outbox`.
  - AppConfig `pm_read_date_expire_period`, `chat_read_mark_expire_period`, `chat_read_mark_size_threshold` (L204879–204881). Suy luận: danh sách "ai đã đọc" chỉ có trong group nhỏ và chỉ trong một khoảng thời gian.
- **Sửa, hẹn giờ, topic, story, folder, reaction:**
  - `Api::EditTextMessage` (L60554), `Data::ScheduledMessages` (L88124), `HistoryView::ScheduledWidget`.
  - `Data::Forum`, `Data::ForumTopic` (L72175–72178), `Data::Stories` (L31582).
  - `Data::ChatFilters` (L88487), `Data::Folder`, `MTPDupdateDialogFilter`.
  - `Data::Reactions`, `Data::MessageReactions`, `MTPDupdateMessageReactions`; `Api::UnreadThings::requestMentions/requestReactions`.
  - Giới hạn từ server, ví dụ `edit_time_limit`, `revoke_time_limit`, `dialog_filters_limit_*`.
- **Dịch:**
  - Quan sát: `Ui::TranslateProvider`, `MTProtoTranslateProvider::requestBatch`, `UrlTranslateProvider`, `HistoryView::TranslateTracker::requestSome` (L105367, L120916–120933); chuỗi `lib_translate` (L1).
  - Suy luận: dịch chủ yếu qua server. Framework `Translation` có link nhưng không thấy kiểu Swift nào.
- **Kiểm tra chính tả:** `Spellchecker::Dict`, `DictLoader`, `SpellingHighlighter`; trên mac dùng `sharedSpellChecker` (L217627, NSSpellChecker); manifest từ điển tải từ cloud (L205706–205708).
- **Gọi thoại và video:** `tgcalls::*` (L52365–83781), `lib_webrtc`, `calls/group/*`, `ScreenCaptureKit` (`SCStream`, L218115). Nằm ngoài phạm vi v1, chỉ ghi nhận.
- **Nhiều tài khoản:** `Main::Domain` → `Main::Account` → `Main::Session`. Mỗi tài khoản có storage riêng (`Storage::Account`).

---

## Đề xuất bổ sung cho plan

Quy ước: **nên thêm** là thay đổi tối thiểu đề xuất; **đã có** là plan đã phủ; **không đổi** là giữ quyết định hiện tại. Mọi đề xuất dựa trên quan sát hoặc suy luận ở trên. Hằng số của Telegram **không** lấy được từ binary, nên không đề xuất đổi con số nào theo Telegram.

### Phase 05 — client core, sync engine

| # | Phát hiện | Đề xuất |
|---|---|---|
| 5.1 | Sync hai mức: tài khoản và channel (§1.1) | **Đã có** (`GetDifference`/`GetChatDifference`, `chat_pts`). Không đổi. |
| 5.2 | Gap timer: binary không lộ giá trị | **Không đổi** 150 ms. |
| 5.3 | Đang lấy difference của một chat thì bỏ qua update realtime của chat đó (L204863–204867) | **Nên thêm** một dòng vào Key Insights: "Khi `GetChatDifference(chat)` đang chạy, update realtime của chat đó bị bỏ (hoặc chỉ giữ để so pts) vì difference sẽ trả lại chúng; không áp hai lần". Hiện plan chỉ ghi "hàng đợi theo pts". |
| 5.4 | `channelDifferenceTooLong` chỉ kiểm lại khoảng lịch sử đang tải (`channelRangeDifferenceSend` + `MsgRange`, L204848) | **Nên thêm** quy tắc `too_long` theo chat: tải lại cửa sổ đang hiển thị (cursor quanh vị trí đang xem). Đánh dấu phần cache local cũ hơn là "stale, cần kiểm lại khi cuộn tới" thay vì xoá và resync toàn chat. FTS5 local cũng phải bỏ hoặc đánh dấu stale phần đó. |
| 5.5 | `too_long` mức tài khoản: Telegram Desktop không xử lý được (L204844) | **Đã có** `too_long`. **Nên thêm** hành vi cụ thể: xoá state + snapshot dialogs mới + giữ cache theo từng chat ở trạng thái "stale" như 5.4. Telegram Desktop không lưu tin local nên không cần làm việc này; mình có SQLite nên phải định nghĩa rõ. |
| 5.6 | getDifference khi update tham chiếu user hoặc chat chưa có (L204857–204862) | **Nên thêm:** nếu update mang id user/chat mà client chưa có thì gọi `GetDifference` (hoặc lấy entity), không render dở. Phía server (Phase 2) **nên thêm** quy ước: update realtime luôn kèm entity tối thiểu (tên, ảnh) cho id mới. |
| 5.7 | getDifference sau `new_session_created` (L204851) | **Đã có** `server_epoch` + thứ tự reconnect (ADR 0002). Không đổi. |
| 5.8 | Phát hiện kết nối "old"/"bad" theo thời gian chờ phản hồi, khởi động lại nhanh (L208224–208229) | **Nên thêm** vào transport: nếu không nhận pong hoặc frame trong N giây (bằng heartbeat Phase 3 cộng biên) thì coi WS chết, reconnect ngay, kèm backoff. Không chờ TCP timeout của OS. |
| 5.9 | Cache media có trần dung lượng + trần thời gian + ngân sách riêng cho file lớn (L209189–209198, L204529–204533) | **Nên thêm:** media cache local có `totalSizeLimit`, `totalTimeLimit` và ngân sách riêng cho file lớn hoặc video, dọn theo LRU. Có màn hình cài đặt trong Phase 6/10/11. Hiện plan mới có purge theo quyền. |
| 5.10 | `Data::Changes` có flag theo đối tượng, kênh realtime và kênh gom (§7) | **Đã có** "event bus theo id" + "batch theo frame". Không đổi. Có thể ghi thêm "flag theo trường" nếu muốn giảm re-render. |
| 5.11 | `Data::Histories::sendRequest(RequestType)` sắp thứ tự request theo chat | **Nên thêm** (nhỏ): outbox xếp tuần tự theo `chat_id` cho các thao tác có thứ tự (gửi → sửa → xoá → đọc). Các chat khác nhau vẫn chạy song song. |
| 5.12 | Khoá local bọc bằng passcode (Argon2id/Scrypt, L209021) | **Đã có** SQLCipher + keyring (ADR 0009) trên native. Không đổi. App-lock/passcode ngoài phạm vi v1 trừ khi đã có. |

### Phase 07 — tìm kiếm

| # | Phát hiện | Đề xuất |
|---|---|---|
| 7.1 | Telegram Desktop chỉ tìm ở server, không có FTS local (§4) | **Không đổi** FTS5 local + gộp kết quả server. Telegram Desktop không có lựa chọn này vì không lưu tin. Plan đã có quy tắc purge nên local an toàn hơn. |
| 7.2 | `Dialogs::SearchRequestDelay` debounce request | **Nên thêm** một dòng: debounce gọi server khi gõ, còn FTS local chạy ngay mỗi phím. Giá trị tự đo, không lấy theo Telegram. |
| 7.3 | `MessagesSearchMerged` gộp nhiều nguồn | **Đã có** ("gộp kết quả server, nhảy tới tin"). Không đổi. |
| 7.4 | NaturalLanguage chỉ dùng để nhận diện ngôn ngữ | **Không đổi.** Không cần NL cho tìm kiếm tiếng Việt; `vifold` đã có. |

### Phase 08 — Bot API và Mini Apps

| # | Phát hiện | Đề xuất |
|---|---|---|
| 8.1 | 49 sự kiện `web_app_*`, payload `[eventType, eventData]` qua một kênh (L204142–204145) | **Nên thêm** vào `packages/miniapp-sdk`: định nghĩa **tập sự kiện v1 tối thiểu** dạng enum trong spec, ví dụ `ready`, `close`, `expand/viewport`, `theme`, `main_button`, `back_button`, `open_link`, `open_popup`, `data_send`, `request_write_access`, `invoke_custom_method`. Mọi sự kiện lạ thì **bỏ và log**, như "Drop raw external event". |
| 8.2 | Native từ chối message quá lớn và kiểm từng trường (L204255, L204152–204181) | **Nên thêm** vào Security: bridge giới hạn kích thước message, validate schema từng sự kiện, và mọi URL từ Mini App đi qua allowlist scheme ADR 0004. Plan đã có kiểm `event.origin`/`event.source`; thiếu trần kích thước và schema. |
| 8.3 | `web_app_device_storage_*`, `secure_storage_*` | **Không đổi** cho v1 (YAGNI). Nếu sau này thêm thì storage phải scope theo `(tenant, user, bot)`. |
| 8.4 | `web_app_request_write_access`, `request_phone` là các quyền xin qua popup | **Đã có** tương đương: consent invariant `bot_user_consent`. Không đổi. |
| 8.5 | `navigationPolicyHandler` chặn điều hướng | **Nên thêm:** container Mini App chặn điều hướng top-level ra ngoài origin `b<bot_id>.…`; link ngoài mở bằng trình duyệt hệ thống sau allowlist. |
| 8.6 | Thanh toán (`Payments::*`) | **Không đổi** (ngoài phạm vi v1). |

### Phase 11 — desktop Tauri

| # | Phát hiện | Đề xuất |
|---|---|---|
| 11.1 | Dữ liệu web cô lập theo `Webview::StorageId` → `dataStoreForIdentifier:` / `nonPersistentDataStore` (L216002, L216802) | **Nên thêm:** cửa sổ Mini App dùng data store riêng cho từng bot. Trên macOS 14+ dùng `data_store_identifier` của WKWebView; WebView2 dùng thư mục user-data riêng; hoặc dùng store không bền. Lúc đó cookie và storage không dính giữa các bot ngay cả khi origin khác nhau. Plan đã có "cửa sổ riêng, origin riêng, không capability". |
| 11.2 | Scheme riêng `desktopappresource://` (L213487) | **Đã có** tương đương: Tauri custom protocol. Không đổi. |
| 11.3 | Notification có hành động đánh dấu đã đọc và trả lời tại chỗ (L208776, L215639) | **Nên thêm** vào Requirements: notification có nút "Đánh dấu đã đọc" và "Trả lời" (text input) trên macOS/Windows, nếu plugin hoặc native hỗ trợ; Linux tuỳ DE. Có tuỳ chọn ẩn nút trả lời. |
| 11.4 | Xoá notification đã giao khi tin được đọc, kể cả ở thiết bị khác (L217022, `UNManager::clearFrom*`) | **Nên thêm:** khi nhận update `read` (hoặc `read_inbox_max_seq`) qua WS, desktop xoá các notification hệ thống của chat đó. Mobile đã có best-effort (Phase 3/10); desktop chưa ghi. |
| 11.5 | Độ trễ notification theo `notify_cloud_delay_ms` (L200171) | **Nên thêm** (nhỏ): desktop giữ notification một khoảng ngắn cấu hình được từ server rồi mới hiện; huỷ nếu trong lúc đó nhận `read` của chat từ thiết bị khác. Giá trị tự đo. |
| 11.6 | Badge Dock gộp tài khoản, debounce, tuỳ chọn tính chat tắt tiếng (L121156, L91761) | **Đã có** tray + badge. **Nên thêm** (nhỏ): badge cộng mọi `(tenant, user)` đang đăng nhập, debounce, và tuỳ chọn "tính cả chat tắt tiếng". |
| 11.7 | Notification gắn instance, session và peer (L208780) | **Nên thêm:** id notification mang `(tenant, user, chat_id, seq)` để click mở đúng tenant và chat khi có nhiều tenant. |
| 11.8 | Giữ kết nối khi chạy nền | **Đã có** (giữ WS, phương án Rust). Telegram Desktop là app native thuần, không gặp throttling của WebView nên không có gì để học thêm. Không đổi. |
| 11.9 | Focus/DND: không có bằng chứng | **Không đổi.** Để hệ điều hành tự xử lý. |

### Phase 02/03/09 — server, gateway, thông báo

| # | Phát hiện | Đề xuất |
|---|---|---|
| 2.1 | Config và giới hạn do server đẩy: MTP config + hơn 30 key AppConfig (L200167–200176, L206473–206510) | **Nên thêm** RPC `GetAppConfig` (có `hash` để trả "không đổi") cho các giới hạn và timer: độ dài tin, `edit_time_limit`, trần folder, độ trễ thông báo, trần cache gợi ý. Client không hardcode. Phase 6 mới nói "feature flag". |
| 2.2 | Danh sách "ai đã đọc" bị giới hạn theo kích thước group và thời gian (L204879–204881) | **Nên thêm** (Phase 2/3): read receipt từng thành viên chỉ cho group ≤ ngưỡng thành viên và trong một khoảng ngày; group lớn chỉ có `read_outbox_max_seq`. Ngưỡng đặt trong AppConfig. Giảm tải fan-out. |
| 3.1 | ping + `disconnect_delay` (L203650–203651) | **Đã có** heartbeat 25 s + đóng idle. Không đổi. |
| 3.2 | Phiên tải lên/xuống tách khỏi kênh update (L208146–208155) | **Đã có** (media đi HTTP/S3, không đi WS). Không đổi. |
| 9.x | Độ trễ thông báo theo đám mây | **Đã có** "bỏ qua push khi có session foreground" + `read_inbox_max_seq`. Không đổi. |

### Phase 04 — media

| # | Phát hiện | Đề xuất |
|---|---|---|
| 4.1 | Làm mới file reference theo origin (`Data::FileOrigin`, `UpdatedFileReferences`) | **Nên thêm** (client, `packages/core/src/media`): URL tải media ngắn hạn hết hạn (403/401) thì tự xin URL mới theo `(chat_id, message seq)` rồi thử lại một lần. Không báo lỗi cho người dùng. |
| 4.2 | Song song thích ứng (`DownloadManagerMtproto`, Uploader fast/slow) | **Nên thêm** (nhỏ): upload multipart chạy nhiều part song song, số luồng tự giảm khi part chậm hoặc lỗi. Plan có "resumable" nhưng chưa nói tới song song thích ứng. |
| 4.3 | Kiểm hash từng part từ CDN (`cdnFileHash`) | **Không đổi.** Mình tự sở hữu CDN và có xác thực ở edge; hash từng part không cần cho v1. |
| 4.4 | Stripped thumb, header streaming cache | **Đã có** (inline thumb do client sinh; HTTP Range). Không đổi. |
| 4.5 | `Uploader::runTranscode` (chuyển mã phía client trước khi upload) | **Không đổi** cho v1. Ghi nhận như phương án nếu sau này cần nén video phía client. |

### Câu hỏi còn mở

1. Hằng số của Telegram Desktop (gap timer, ping, idle, cache mặc định): binary không lộ. Có thể đối chiếu mã nguồn tdesktop tag v7.3.1 nếu cần. Báo cáo này chưa làm và không cần cho các đề xuất trên.
2. Mini App có bật inspect và CSP cụ thể nào: cần quan sát lúc chạy (chưa làm theo yêu cầu).
3. Telegram Desktop có tôn trọng Focus/DND của macOS hay không: không có bằng chứng tĩnh.
