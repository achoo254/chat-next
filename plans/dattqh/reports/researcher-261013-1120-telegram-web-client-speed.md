# Telegram Web A/K: kỹ thuật tạo "perceived speed" — nghiên cứu kiến trúc

Ngày: 2026-10-13 (Asia/Saigon). Phạm vi: chỉ nghiên cứu thiết kế, KHÔNG sao chép code.
Phương pháp: shallow-clone hai repo, đọc file bằng grep/sed, đối chiếu với `AGENTS.md` của chính maintainer (nguồn có độ tin cậy cao nhất vì do tác giả viết để hướng dẫn contributor), kiểm tra license qua GitHub API.

## Kết luận chính

Telegram Web nhanh chủ yếu nhờ **kỷ luật kiến trúc**, framework chỉ đóng góp một phần nhỏ:
1. Toàn bộ network/crypto/update-sequencing nằm trong **Worker**; main thread chỉ nhận object đã build sẵn và được **batch theo tick**.
2. **Render từ cache trước, hỏi network sau**: state rút gọn được lưu vào IndexedDB, chat list và viewport cuối cùng của mỗi chat hiện ra ngay khi mở app.
3. **Tách measure/mutate theo frame** (fastdom-style), và **hoãn update UI khi đang chạy animation nặng**.
4. **Viewport window** trên danh sách message (không render toàn bộ history), cùng với **scroll anchoring thủ công**.
5. Media có **kích thước biết trước** cộng với **stripped thumbnail inline** (khoảng 100–200 byte) nên layout không bị nhảy; video chạy qua **Service Worker range streaming**.

Với chat-inet: nên áp dụng các *pattern* này trên một stack thông dụng (React/Solid/Vue), không nên tự viết framework. Lý do được trình bày ở §1.

---

## 0. Source manifest

| Repo | URL | Commit SHA (HEAD, depth 1) | Ngày commit | License | Ghi chú |
|---|---|---|---|---|---|
| Telegram Web A | https://github.com/Ajaxy/telegram-tt | `090e38f1dffec3e0a9aefbec8159a9931fbeec8f` | 2026-10-12 | GPL-3.0 | ~3.5k stars, active. Có sẵn `tauri/` (desktop wrap) |
| Telegram Web K | https://github.com/morethanwords/tweb | `ed0b0def153959ed9f96eff078469837bfc30e0f` | 2026-10-12 | GPL-3.0 | ~2.7k stars, active. Solid.js fork + SharedWorker |
| Teact (tách riêng) | https://github.com/Ajaxy/teact | (không clone) | — | MIT | Bản copy trong telegram-tt (`src/lib/teact/`) thuộc repo GPL |
| GramJS upstream | https://github.com/gram-js/gramjs | (không clone) | — | MIT | **Upstream đã archived**; telegram-tt dùng fork nội bộ `src/lib/gramjs/` |

**Hệ quả license với việc reuse:**
- GPL-3.0 có hiệu lực khi *phân phối* (convey). Web app gửi JS xuống trình duyệt người dùng, và app Capacitor/Tauri được phân phối dưới dạng binary; cả hai trường hợp đều là "convey". Nếu copy hoặc dịch sát code từ hai repo trên thì chat-inet phải phát hành toàn bộ source theo GPL-3.0. Ngoài ra GPL còn xung đột với điều khoản App Store (iOS).
- Ý tưởng, kiến trúc và thuật toán không được bảo hộ bởi copyright. Report này chỉ mô tả technique, việc implement lại từ mô tả là an toàn. Không nên mở file GPL bên cạnh editor khi code (clean-room discipline).
- Teact upstream là MIT, về lý thuyết dùng được, nhưng chỉ có 150 stars và gần như chỉ một maintainer. Rủi ro bus-factor rất cao (xem §1).
- *Đây không phải tư vấn pháp lý.*

---

## 1. Rendering layer: Teact + fasterdom

**Technique**
- Teact là bản reimplement API React (hooks, memo, context) rất nhỏ, khoảng 96 KB source trong `src/lib/teact/`. README nói rõ lý do ban đầu là luật contest "nearly zero dependencies"; tức là lý do lịch sử, không phải vì React chậm. Điều mà Teact cho phép (và React không cho) là **gắn render pass vào scheduler fasterdom**.
- Thứ tự trong một frame do maintainer tự ghi lại: *effects → requested measures → JSX render → layout effects → requested mutations → forced reflow measures/mutations*. `runUpdatePassOnRaf` của Teact được throttle bằng `requestMeasure`, còn DOM patch thì chạy trong `requestMutation`.
- `requestMeasure` / `requestMutation` / `requestForcedReflow` gom các task vào một rAF duy nhất, đảm bảo đọc layout hết rồi mới ghi, nên không có layout thrash. Ở dev mode, `stricterdom` patch các DOM API gây layout và **throw lỗi khi đọc layout trong phase mutate**. Đây là "linter runtime" chống thrash.
- **Heavy animation gate**: `beginHeavyAnimation()` bật một signal. Trong thời gian đó, `runCallbacks` của global store (teactn) và cả update pass đều *hoãn*. Kết quả là update từ network không chen vào frame animation, nên mở chat hay chuyển folder luôn mượt. `onFullyIdle` dùng cho việc không gấp.
- Global store: một object immutable duy nhất. Sau mỗi `setGlobal`, `withGlobal(mapStateToProps)` chạy shallow-compare cho từng container, throttle theo tick end. Ở DEBUG, nếu update containers mất hơn 7ms thì có warning.
- Signals (`useSignal`, `useDerivedState`) dùng cho dữ liệu đổi nhanh như typing, caret, tiến độ animation, để không phải re-render component.
- tweb dùng Solid.js (fork) và bubbles được dựng DOM imperative. Ý tưởng tương đương nằm ở `sequentialDom.measure/mutate`. `AGENTS.md` của tweb cấm forced sync layout trên hot path (row của chat list, incoming update, unread counter) và yêu cầu đo `LayoutCount` bằng CDP khi review perf.

**Evidence**
- telegram-tt: `src/lib/teact/teact.ts` (L402–435 `runUpdatePassOnRaf`), `src/lib/teact/teact-dom.ts` (`teactFastList`, keyed reconcile), `src/lib/teact/teactn.tsx` (L71–84 hoãn khi heavy animation, L188+ `updateContainers`), `src/lib/teact/heavyAnimation.ts`, `src/lib/fasterdom/fasterdom.ts`, `src/lib/fasterdom/stricterdom.ts`, `AGENTS.md` mục "Rendering and animation".
- tweb: `src/helpers/sequentialDom.ts`, `AGENTS.md` (mục perf review, khoảng L464–485).

**Takeaway cho chat-inet**
- **Không tự viết framework.** Lợi thế của Teact đến từ *scheduler*, và scheduler có thể làm như một lớp mỏng trên React/Solid/Vue: một module `dom-scheduler` với `measure(cb)` / `mutate(cb)` gom theo rAF, cộng một flag `isHeavyAnimating` để store tạm hoãn notify.
- Chọn framework có fine-grained reactivity (Solid, Vue 3 hoặc Preact + signals). Chọn React thì bắt buộc dùng selector shallow-equal kiểu Zustand/Redux và `memo` kỷ luật.
- Đưa vào lint/review ngay từ đầu: không đọc `offsetHeight` hoặc `getBoundingClientRect` sau khi ghi DOM trên hot path.

---

## 2. Message list: viewport window, infinite scroll, scroll anchoring

**Technique**
- **Không virtualize theo pixel**, mà dùng **viewport window theo id**. State giữ `listedIds` (dải id liên tục đã biết), `outlyingLists` (các dải rời, ví dụ khi nhảy tới reply cũ) và `viewportIds` (tối đa `MESSAGE_LIST_VIEWPORT_LIMIT = 2 × SLICE`, với SLICE bằng 40 hoặc 60 tùy màn hình). DOM chỉ chứa `viewportIds`.
- `getViewportSlice(ids, offsetId, direction)` trả về `areSomeLocal` và `areAllLocal`. Nếu có sẵn một phần trong local thì **render ngay phần đó**, phần còn thiếu mới gọi server (`loadWithBudget`). Khi message mới đến mà viewport đã đầy, `addViewportId` cắt bớt về nửa SLICE cuối.
- Trigger load: hai sentinel `backwards-trigger` / `forwards-trigger` cùng IntersectionObserver với `rootMargin = 750px` (`MESSAGE_LIST_SENSITIVE_AREA`); load được debounce 1000ms (leading).
- **Giữ vị trí khi prepend history**: trước khi update, chọn phần tử anchor là *item thứ 2* còn tồn tại (tránh item đầu vì có thể là album đang load dở hoặc sắp bị cắt) và lưu `getBoundingClientRect().top`. Sau khi patch DOM thì `newScrollTop = scrollTop + (newTop - oldTop)`. CSS đặt `overflow-anchor: none` để tắt scroll anchoring tự động của trình duyệt, tránh hai cơ chế đánh nhau.
- Lưu `scrollOffset = scrollHeight - scrollTop` theo từng chat (ghi vào global mỗi giây) để mở lại chat thì về đúng chỗ cũ.
- Khi local message được thay bằng server id, anchor id được đổi theo `previousLocalId` để không mất anchor (xem §6).
- **Chat list** dùng một kỹ thuật khác: chiều cao row cố định (`CHAT_HEIGHT_PX`), `position:absolute; top = index × height`, container `maxHeight = n × height`. Nhờ đó reorder (chat nhảy lên đầu) không gây reflow toàn list; `teactOrderKey` cho phép di chuyển node thay vì remount.
- tweb: `ScrollSaver` lưu rect của các bubble đang nhìn thấy rồi restore; `sliceViewport()` (debounce 3s) **xoá bubble ngoài viewport** để giữ DOM nhỏ. Hàm này bị tắt trên Safari ("Safari cannot reset the scroll") và tắt khi đang chạy heavy animation.
- **Media không làm nhảy layout**: server trả `w/h` cho photo/video, component set `--media-width` và `--media-aspect-ratio` cùng thuộc tính `width/height` trước khi có bytes.

**Evidence**
- telegram-tt: `src/hooks/useInfiniteScroll.ts`, `src/global/actions/api/messages.ts` (L228+ `loadViewportMessages`), `src/global/reducers/messages.ts` (L675–717 `addViewportId`, `safeReplaceViewportIds`, `updateOutlyingLists`), `src/components/middle/MessageList.tsx` (L312–323 scrollOffset/anchor, L855–870 `rememberScrollPositionRef`, L1188–1197 restore), `src/components/middle/hooks/useScrollHooks.ts`, `src/components/middle/MessageList.scss` (L127 `overflow-anchor: none`), `src/config.ts` L83–84, `src/components/left/main/ChatList.tsx` (L104, L199–234), `src/components/middle/message/Photo.tsx` (L90, L248–249).
- tweb: `src/helpers/scrollSaver.ts`, `src/components/chat/bubbles.ts` (L4860 `onScrolledTop/Bottom`, L12772 `sliceViewport`), `src/components/scrollable.ts`.

**Takeaway cho chat-inet**
- Mô hình dữ liệu: `messagesById` cộng với **các dải id liên tục** (`ranges: number[][]`) cho mỗi chat. Viewport là một slice khoảng 80–120 id. Không dùng thư viện virtualizer pixel-based cho message list (chiều cao bubble biến thiên và có prepend); với chat list cố định chiều cao thì virtualizer kiểu đó dùng tốt.
- Tự implement anchoring: `overflow-anchor:none`, chụp anchor trước patch, bù `scrollTop` sau patch (trong cùng phase mutate).
- API backend phải trả **kích thước media** (w/h) cùng với message metadata. Đây là yêu cầu contract, cần chốt ngay từ thiết kế API.

---

## 3. Networking: Worker, luồng API/update, sequencing

**Technique**
- telegram-tt: GramJS (MTProto, crypto, socket) chạy trong **dedicated Web Worker** (`new Worker(new URL('./worker.ts'))`). UI gọi `callApi(name, args)`, worker trả về **plain `Api*` object đã build sẵn** (không trả class TL), nên main thread không phải parse hay convert gì.
- **Batch hai chiều**: main gom payload rồi `postMessage` một lần mỗi tick (`postMessagesOnTickEnd`); worker gom update rồi gửi một lần mỗi tick, kèm **Transferable** cho binary (`sendToOriginOnTickEnd`). Phía main, `apiUpdateEmitter` throttle tiếp các update theo `API_UPDATE_THROTTLE` (trung bình thời lượng scroll animation); một số loại update quan trọng (`API_THROTTLE_RESET_UPDATES`) reset throttle để đi ngay.
- **Multi-tab**: chỉ tab "master" giữ kết nối; các tab khác proxy qua `BroadcastChannel` (`establishMultitabRole.ts`, `callApiOnMasterTab`). tweb dùng **SharedWorker** (có fallback sang Worker), nên một kết nối dùng chung cho mọi tab và crypto chạy ở worker riêng.
- **Sequencing** (`updateManager.ts`): giữ `seq` (common box) và `pts` cho từng channel trong các `SortedQueue`. Logic:
  - `pts === local + pts_count`: apply, rồi thử pop tiếp.
  - `pts > local + pts_count` (có gap): đẩy lại vào queue, chờ `UPDATE_WAIT_TIMEOUT = 500ms`, sau đó `getDifference` / `getChannelDifference`.
  - `pts` nhỏ hơn: update cũ, bỏ qua. Update thiếu local state cũng bị bỏ.
  - Các channel đang mở được **shortpoll** `getChannelDifference` theo `timeout` do server gợi ý.
- tweb `apiUpdatesManager.ts` có cùng mô hình: `pendingPtsUpdates`, `pendingSeqUpdates`, `syncLoading`, `getDifference`.

**Evidence**
- telegram-tt: `src/api/gramjs/worker/connector.ts` (L38–57 batch, L93 tạo Worker, L198 master tab), `src/api/gramjs/worker/worker.ts` (L163–200 batch + transferables), `src/api/gramjs/updates/apiUpdateEmitter.ts`, `src/api/gramjs/updates/updateManager.ts` (L45–63 hằng số và queue, L202–262 pop logic, L375–440 `getDifference`), `src/api/gramjs/updates/mtpUpdateHandler.ts`, `src/util/establishMultitabRole.ts`, `AGENTS.md` mục "Telegram API".
- tweb: `src/lib/apiManagerProxy.ts` (L1038–1075 SharedWorker/Worker), `src/lib/appManagers/apiUpdatesManager.ts` (L26–68, L98–190, L298+), `src/lib/mainWorker/`, `src/lib/crypto/crypto.worker.ts`.

**Takeaway cho chat-inet** (backend riêng, không phải MTProto)
- WebSocket client, decode, cache entity và sequencing đều đặt trong **SharedWorker** (fallback Worker). UI chỉ thấy `api.call()` cộng với một stream `updates[]` đã batch theo tick.
- Backend cần cấp **sequence số đơn điệu cho từng chat** (tương đương pts) và endpoint `getDifference(sinceSeq)` cho từng chat và cho user-box. Không có cái này thì client không thể phát hiện gap sau khi mất kết nối. **Đây là contract backend quan trọng nhất cần chốt.**
- Gap thì chờ khoảng 500ms rồi gọi difference; reconnect thì gọi difference toàn cục trước khi coi là "online".

---

## 4. Local cache / persistence và cold start

**Technique**
- telegram-tt: **một snapshot global state rút gọn** (`reduceGlobal`) ghi vào IndexedDB (qua `idb-keyval`, `MAIN_IDB_STORE`). Ghi được throttle 5s và chỉ chạy khi `onFullyIdle`. Giới hạn: 200 chat, 10 chat archived, 500 user, 150 custom emoji. Với mỗi chat chỉ lưu `lastViewportIds` cộng last message, nghĩa là **đúng những gì cần để vẽ lại màn hình cuối cùng**. Có `migrateCache` theo version. Một số key nhỏ đồng bộ (passcode, multitab) để ở `localStorage`.
- Boot (`src/index.tsx`): `initGlobal()` load cache rồi render `<App/>` ngay; network kết nối song song. `UiLoader` chờ main bundle cộng preload (font, icon, khoảng 10 avatar đầu) **tối đa 700ms** (`MAX_PRELOAD_DELAY`) rồi bỏ mask, không chờ network.
- Media cache: **Cache Storage** (`tt-media`, `tt-media-avatars`, `tt-media-progressive`) cùng một in-memory `Map` của blob URL. Asset app: Service Worker cache-first cho asset có hash, network-first cho `index`.
- Worker có `localDb` (users/chats/documents/photos dạng TL) để build input/refetch file reference mà không cần UI gửi `accessHash`.
- tweb: IndexedDB **per-account** với store `session/users/chats/messages/dialogs/stickerSets/webapp`; có biến thể `__encrypted` khi bật passcode. `loadState` đọc song song tất cả key và reset storage khi lệch `STATE_VERSION`/build. UI giữ **mirrors** (bản sao read-only của peers/messages/thumbs) được đồng bộ từ SharedWorker, cho phép đọc đồng bộ ở main thread.

**Evidence**
- telegram-tt: `src/global/cache.ts` (L70–78 throttle, L196+ `readCache`, L292 `migrateCache`, L516 `reduceGlobal`, L769–850 `reduceMessages`), `src/util/browser/idb.ts`, `src/config.ts` (L52–68), `src/index.tsx`, `src/global/init.ts`, `src/components/common/UiLoader.tsx` (L55, L92–160), `src/util/mediaLoader.ts`, `src/util/cacheApi.ts`, `src/serviceWorker/assetCache.ts`, `src/api/gramjs/localDb.ts`.
- tweb: `src/config/databases/state.ts`, `src/lib/appManagers/utils/state/loadState.ts`, `src/lib/storages/dialogs.ts`, `src/lib/apiManagerProxy.ts` (L98–125 `Mirrors`), `src/lib/files/cacheStorage.ts`, `src/lib/files/idb.ts`.

**Takeaway cho chat-inet**
- Cache **"màn hình cuối cùng"** chứ không cache toàn bộ dữ liệu: chat list top N, viewport cuối của các chat đã mở, users liên quan, draft. Ghi throttled khi idle, có `schemaVersion` và migrate (hoặc drop nếu lệch).
- Thứ tự boot: shell HTML/CSS, đọc IDB, render ngay, rồi kết nối WS và `getDifference`, cuối cùng reconcile. Đặt **deadline cứng** cho splash (khoảng 700ms) thay vì chờ network.
- Media bytes để ở Cache Storage, metadata để ở IDB, không lưu blob vào global state.
- Với Capacitor/Tauri, giới hạn quota IDB và khả năng bị OS xoá khác với web. Cân nhắc `navigator.storage.persist()` và kiểm thử eviction.

---

## 5. Media: SW streaming, progressive thumbnail, lazy load

**Technique**
- **Range streaming qua Service Worker**: `<video src="/progressive/<id>">`. SW parse header `Range`, clamp từng part về 512KB, rồi `client.postMessage({type:'requestPart'})` gửi về tab. Tab gọi worker `downloadMedia` (có retry và backoff) và trả bytes cho SW, SW trả **206** kèm `Content-Range`. **Chỉ cache 2MB đầu** của file vào Cache Storage, lưu tách arrayBuffer và headers vì Cache API không lưu được response 206. Safari có nhánh riêng cho request `bytes=0-1`.
- tweb: `stream.ts` căn chỉnh chunk (`alignOffset/alignLimit`); chunk lớn hơn với file trên 75MB; **đọc trước (read-ahead) chunk kế tiếp và chunk cuối file** (vì moov atom có thể nằm ở cuối); cache chunk trong `cachedStreamChunks`.
- **Stripped thumbnail**: server gửi kèm message một ảnh JPEG khoảng 100–200 byte *không có header*. Client ghép lại header JPEG cố định để thành data-URI, vẽ lên canvas có blur, rồi crossfade sang ảnh thật (`useMediaTransition`). Không cần request thêm, thumbnail có ngay trong payload.
- **Lazy load**: IntersectionObserver với margin 300px (mobile) hoặc 500px, throttle 350ms (1000ms trên Android); chỉ download khi `isIntersecting && isLoadAllowed`. Có observer riêng cho "playing" (autoplay GIF/video trong viewport).

**Evidence**
- telegram-tt: `src/serviceWorker/service.worker.ts` (L52–83 routing), `src/serviceWorker/progressive.ts` (L27–28, L36–60, L138–158, L161–195), `src/util/mediaLoader.ts` (L250–285 bridge `requestPart`), `src/lib/gramjs/Utils.ts` (L89–101 `strippedPhotoToJpg`), `src/api/gramjs/apiBuilders/common.ts` (L34–60), `src/components/middle/message/Photo.tsx` (L94–114, L273), `src/components/middle/message/hooks/useBlurredMediaThumbRef.ts`, `src/components/middle/hooks/useMessageObservers.ts` (L15–41).
- tweb: `src/lib/serviceWorker/stream.ts` (L56–235), `src/helpers/bytes/getPreviewURLFromBytes.ts`, `src/lib/storages/thumbs.ts`.

**Takeaway cho chat-inet**
- Backend tự sinh **tiny thumbnail** (blurhash/thumbhash, hoặc tiny JPEG khoảng 200 byte) lúc upload và **nhúng vào message payload**.
- Nếu media server hỗ trợ HTTP Range với auth bằng cookie/URL ký sẵn, **dùng thẳng native `<video>` với Range**, không cần SW. Telegram buộc phải dùng SW vì media đi qua MTProto chứ không qua HTTP. Chỉ cần SW nếu media phải giải mã hoặc cần header auth tuỳ biến. Đây là chỗ nên đơn giản hơn Telegram (KISS).
- Lazy load bằng một IntersectionObserver dùng chung cho cả list (không tạo một observer cho mỗi item), margin khoảng 500px.

---

## 6. Optimistic UI: gửi message, read state

**Technique**
- **Local id dạng số thập phân**: telegram-tt dùng `lastMessageId + counter/LOCAL_MESSAGES_LIMIT`, tweb dùng `generateMessageId(lastId) + 0.0001`. Message tạm vì vậy **tự sắp đúng vị trí** (ngay sau message thật cuối cùng) mà không cần sort riêng; `isLocalMessageId(id) = !Number.isInteger(id)`.
- Message được insert vào store ngay (`sendMessage` trả về `localMessage` đồng bộ). Request mang `randomId` (idempotency key). Server trả `UpdateMessageID(randomId → id)`, client phát `updateMessageSendSucceeded{localId, message}`.
- **Swap id không remount DOM**: reducer xoá local, ghi message thật với `previousLocalId`; list render `key = previousLocalId || id` (`getMessageOriginalId`). Node DOM giữ nguyên, không nháy và không reset ảnh đang upload.
- **Chống nháy icon "đang gửi"**: chỉ set `sendingState: pending` (icon đồng hồ) nếu sau 1000ms (`FAST_SEND_TIMEOUT`) vẫn chưa xong.
- Không cho load history với offset là local id. Failure được chuyển thành `updateMessageSendFailed` để UI hiện nút retry.
- **Read state**: IntersectionObserver trên marker cuối của mỗi message (throttle 150ms) lấy maxId nhìn thấy rồi gọi `markMessageListRead`. Hàm này **giảm `unreadCount` local ngay** (đếm id trong viewport từ firstUnread tới maxId) và gọi server với **debounce 500ms**.

**Evidence**
- telegram-tt: `src/api/gramjs/apiBuilders/messages.ts` (L93–100), `src/util/keys/messageKey.ts` (L44), `src/api/gramjs/methods/messages.ts` (L145, L428–478, L3095–3128), `src/global/actions/apiUpdaters/messages.ts` (L761–800), `src/global/helpers/messages.ts` (L77–79), `src/components/middle/MessageListContent.tsx` (L385, L508), `src/global/actions/api/messages.ts` (L226, L1648–1695), `src/components/middle/hooks/useMessageObservers.ts`.
- tweb: `src/lib/appManagers/appMessagesIdsManager.ts` (L11–13), `src/lib/appManagers/appMessagesManager.ts` (L684–701 `pendingByRandomId`, L10668 `onUpdateMessageId`, L12583 `message_sent`), `src/components/chat/bubbles.ts` (L1167).

**Takeaway cho chat-inet**
- Client sinh `clientMsgId` (UUID) làm idempotency key; server echo lại kèm `serverId` và `seq`. Store dùng `sortKey` dạng thập phân cho message tạm, và `renderKey` ổn định (giữ `clientMsgId`) để không remount.
- Hiện trạng "đang gửi" sau một ngưỡng (khoảng 1s); hàng đợi outbox lưu IDB để gửi lại sau khi reload hoặc offline (đây là phần cần thiết cho mobile, Telegram Web chỉ giữ một phần).
- Read receipt: cập nhật badge local ngay, gọi server debounce 500ms với `maxReadId`.

---

## 7. Bundle và boot

**Technique**
- telegram-tt: **bundle theo domain** `Auth / Main / Extra / Calls / Stars / Editor / Wallet` (`src/bundles/*.ts`), load qua `loadBundle()`. Có **155 file `*.async.tsx`**: wrapper rất nhỏ gọi `useModuleLoader(Bundles.Extra, 'X', !isOpen)`, nên modal chỉ được tải khi mở lần đầu. Chưa đăng nhập thì không tải Main; `UiLoader` chỉ chờ bundle của page hiện tại.
- Critical path: `index.html` chạy `compatTest.js` rồi `index.tsx`. `stricterdom` chỉ bật ở dev. Worker có pipeline build riêng.
- tweb: `index.ts` rẽ nhánh `import('./pages/mountAuthFlow')` hoặc `import('./pages/bootstrapIm')`; trong khi đang ở màn hình lock passcode thì prefetch `bootstrapIm`. Font được preload và fade-in khi font sẵn sàng (tránh FOUT). Lottie, webp, opus và crypto đều chạy ở worker riêng, lazy.
- Cả hai đều dùng Vite. Tauri trong telegram-tt **load app từ URL remote** (`BASE_URL`), không đóng gói asset, nên SW, Cache Storage và cập nhật web tức thì đều hoạt động như trên web.

**Evidence**
- telegram-tt: `src/util/moduleLoader.ts`, `src/bundles/`, `src/hooks/useModuleLoader.ts`, ví dụ `src/components/middle/ChatLanguageModal.async.tsx`, `src/components/common/UiLoader.tsx` (L59–68), `index.html` (L55–72), `vite.config.ts`, `tauri/tauri.conf.json`, `docs/TAURI.md` (bảng env `BASE_URL`).
- tweb: `src/index.ts` (L476, L652–662), `vite.config.ts` (L272 `target: es2020`), `src/lib/apiManagerProxy.ts` (L1020–1035 crypto worker).

**Takeaway cho chat-inet**
- Chia 3 tầng: **shell** (layout, chat list, message list, composer), **Extra** (settings, modal, media viewer, editor), **Heavy** (calls, mini-app host, chart). Mọi modal đều mặc định là async.
- Đặt **budget** cho JS critical (ví dụ dưới 150KB gzip, con số này cần đo lại khi có stack) và kiểm trong CI.
- Đối với Tauri, cân nhắc mô hình "remote URL" của telegram-tt (tự cập nhật, SW hoạt động) so với đóng gói offline. Với Capacitor iOS (scheme `capacitor://`), **Service Worker không được hỗ trợ** nếu không cấu hình App-Bound Domains. Thêm một lý do để không phụ thuộc SW cho media (§5).

---

## 8. Search trên client

**Technique**
- **Hybrid local/server**. Global search (cột trái) làm hai việc song song: (a) **filter local tức thì** trên peers có sẵn trong store (`filterPeersByQuery`), (b) gọi server `contacts.search` cho chats/users, throttle 500ms, và `messages.searchGlobal` cho message. Phân trang bằng cursor `offsetRate / offsetPeer / offsetId` (`nextOffset*` lưu trong state); trang tiếp được kích hoạt bởi IntersectionObserver ở cuối list (throttle 500ms).
- **Chống kết quả cũ** (stale response): khi kết quả về, so `query` với query hiện tại trong state; khác thì bỏ.
- **In-chat search** (`MiddleSearch`): debounce 200ms, gọi `messages.search` theo peer/thread (có filter by sender, saved tag, hashtag). `shouldReuseParams` chỉ dùng lại offset khi query không đổi. Nhảy tới kết quả dùng `focusMessage`, kết hợp outlying list (§2). Có thêm `searchMessagesByDate` (`findFirstMessageIdAfterDate`).
- tweb: `InputSearch` debounce mặc định 300ms; `SearchIndex` (index full-text nhỏ trong bộ nhớ) cho dialogs và topics, phục vụ kết quả local ngay; server dùng `messages.search` và `messages.searchGlobal` trong `appMessagesManager`.

**Evidence**
- telegram-tt: `src/global/actions/api/globalSearch.ts` (L33–72, L97–135, L186–325), `src/global/actions/api/middleSearch.ts` (L47–165, L258–300), `src/components/left/search/ChatResults.tsx` (L77, L234–248), `src/components/middle/search/MiddleSearch.tsx` (L102, L336–338), `src/api/gramjs/methods/messages.ts` (L1928–2143), `src/api/gramjs/methods/chats.ts` (L472), `src/config.ts` (L97–99 slice sizes).
- tweb: `src/components/inputSearch.ts` (L77, L221), `src/components/appSearch.ts`, `src/lib/searchIndex.ts`, `src/lib/storages/dialogs.ts` (L97, L372–382), `src/lib/appManagers/appMessagesManager.ts` (L13788–13861).

**Takeaway cho chat-inet**
- Peer/chat: filter local trên cache trước (chuẩn hoá bỏ dấu tiếng Việt), server sau.
- Nội dung message: **server-side** (Postgres FTS/OpenSearch, cần cấu hình cho tiếng Việt); client chỉ index những gì đã cache khi cần offline.
- Debounce khoảng 200–300ms, cursor pagination, kiểm stale bằng query (hoặc dùng `AbortController`). API backend nên cùng một hình dạng `{items, nextCursor}` cho cả in-chat lẫn global.

---

## 9. Bot UI trên client

**Technique và file**

| Tính năng | telegram-tt | tweb | Ghi chú kỹ thuật |
|---|---|---|---|
| Reply keyboard (thay bàn phím) | `src/components/middle/composer/BotKeyboardMenu.tsx` (`keyboardButtons`, `isKeyboardSingleUse` thì tự đóng) | `src/components/chat/replyKeyboard.tsx` | Keyboard lấy từ message gần nhất có markup |
| Inline keyboard (dưới message) | `src/components/middle/message/InlineButtons.tsx` | trong `src/components/chat/bubbles.ts` | Một `switch(action.type)`: url, callback, copy, userProfile, webView, switchInline… |
| Callback query | `src/global/actions/api/bots.ts` L108+ `clickBotInlineButton` → `answerCallbackButton`; `src/api/gramjs/methods/bots.ts` L56 `messages.getBotCallbackAnswer` | `src/lib/appManagers/appInlineBotsManager.ts` L245 | Trả về toast/alert/url |
| Inline mode (`@bot query`) | `src/components/common/tooltips/InlineBotTooltip.tsx`, `src/components/middle/composer/inlineResults/*`; action `queryInlineBot` (L371) với debounce 500ms (L84); `messages.getInlineBotResults` | `src/components/chat/inlineHelper.ts` (debounce 200ms) | Render theo loại kết quả: article/media/gif/sticker |
| Commands menu | `src/components/middle/composer/BotCommandMenu.tsx`, `BotMenuButton.tsx`, `ChatCommand.tsx` | `src/components/chat/botCommands.ts`, `commandsHelper.ts`, `processPeerFullForCommands.ts` | Danh sách lệnh lấy từ bot full-info; gõ `/` mở autocomplete |
| Mini Apps (iframe bridge) | `src/components/modals/browser/WebAppTab.tsx` (L1245 `sandbox` + `allow`), `hooks/useWebAppFrame.ts` (L70–76 gửi event, L180–215 nhận), `src/util/browser/iframe.ts` (`isMessageFromIframe` kiểm `event.source` và `origin`), `src/types/webapp.ts` | `src/components/webApp.tsx` (L59 sandbox, L194–203 ràng buộc origin) | Giao thức JSON `{eventType, eventData}`: `web_app_ready`, `web_app_close`, `web_app_request_theme`… và host đẩy về `theme_changed`, `viewport_changed`, `safe_area_changed` |

**Takeaway cho chat-inet**
- Mô hình hoá button thành một **discriminated union `action.type`** và xử lý trong một reducer/handler trung tâm. Thêm loại button mới không phải sửa UI rải rác.
- Callback: hiện spinner trên nút, có timeout, server trả `{toast|alert|url}`.
- Mini App: iframe `sandbox` tối thiểu, **luôn kiểm `event.source === iframe.contentWindow` và `event.origin`**, giao thức message JSON có version, đẩy theme/viewport/safe-area từ host. Với Capacitor/Tauri, safe-area lấy từ native rồi chuyển tiếp vào iframe.
- Có thể tham chiếu spec công khai của Telegram Mini Apps (core.telegram.org/bots/webapps) để thiết kế protocol. Spec là tài liệu, không phải code GPL.

---

## Top-10 kỹ thuật cần áp dụng (xếp theo tác động / chi phí)

| # | Kỹ thuật | Lý do xếp hạng | Rủi ro áp dụng |
|---|---|---|---|
| 1 | **Cache "màn hình cuối" vào IDB và render trước network** (§4) | Quyết định cảm giác "mở là có" khi cold start; chi phí thấp | Thấp: cần schema version và migrate |
| 2 | **Sequence đơn điệu theo chat + `getDifference`** (§3) | Không có cái này thì cache và optimistic UI sẽ sai sau reconnect; *contract backend*, sửa về sau rất đắt | Trung bình: cần backend cam kết từ đầu |
| 3 | **Optimistic send: clientMsgId, sortKey thập phân, renderKey ổn định, ngưỡng 1s cho "pending"** (§6) | Cảm nhận tốc độ gửi tức thì, không nháy | Thấp |
| 4 | **Viewport window theo id cùng dải id liên tục, scroll anchoring thủ công (`overflow-anchor:none`)** (§2) | DOM nhỏ, nhảy tới message cũ không cần load toàn bộ | Trung bình: edge case album, unread divider, Safari |
| 5 | **Kích thước media trong payload và tiny thumbnail inline** (§2, §5) | Loại bỏ layout shift và scroll jump; *contract backend* | Thấp |
| 6 | **Network, decode, sequencing trong (Shared)Worker; batch update theo tick** (§3) | Main thread rảnh cho scroll/typing; một kết nối cho nhiều tab | Trung bình: Safari iOS mới có SharedWorker từ 16, cần fallback |
| 7 | **Scheduler measure/mutate cùng heavy-animation gate** (§1) | Giữ 60fps khi update đổ về lúc đang animate | Thấp nếu làm từ đầu, cao nếu thêm về sau |
| 8 | **Code-split theo domain và mặc định async cho modal; deadline splash khoảng 700ms** (§7) | Critical path nhỏ | Thấp |
| 9 | **Lazy media bằng IntersectionObserver dùng chung; Range HTTP native (SW chỉ khi bắt buộc)** (§5) | Tiết kiệm băng thông, không chặn scroll | Thấp; SW trên Capacitor iOS có rủi ro |
| 10 | **Search hybrid: local filter tức thì + server debounce 200–300ms, cursor, kiểm stale** (§8) | UX search "có ngay" | Thấp; FTS tiếng Việt ở backend là việc riêng |

**Không khuyến nghị** áp dụng: tự viết framework kiểu Teact (bus-factor, chi phí bảo trì; lợi ích đạt được bằng scheduler mỏng ở #7), và SW streaming cho media khi backend đã có HTTP Range.

## Giới hạn của nghiên cứu này

- Chỉ đọc code tĩnh ở một commit; **không đo** bằng Lighthouse hoặc CDP trên bản chạy thật. Các con số (700ms, 500ms, 512KB…) là hằng số trong code, không phải benchmark.
- Không đánh giá MTProto crypto, calls, stories, payments (ngoài phạm vi).
- Hành vi trên Capacitor (iOS WKWebView / Android WebView) chỉ được suy luận; **chưa kiểm chứng** với SW, SharedWorker và quota IDB trên thiết bị thật.
- Chưa xem xét `tweb` ở mức chi tiết bằng telegram-tt (bubbles.ts gần 14k dòng); với các điểm chỉ có ở tweb, bằng chứng là file/dòng nhưng chưa đọc toàn bộ ngữ cảnh.

## Câu hỏi chưa giải quyết

1. Backend chat-inet có cam kết cung cấp **sequence theo chat + endpoint difference** không? (chặn #2, #3, #4)
2. Media server có hỗ trợ **HTTP Range + auth bằng signed URL/cookie** không? Nếu chỉ có header Bearer thì cần SW hoặc proxy (ảnh hưởng #9 và tương thích Capacitor iOS).
3. Framework UI đã chốt chưa (React / Solid / Vue)? Điều này ảnh hưởng cách hiện thực scheduler (#7) và store selector.
4. Tauri: load từ **remote URL** (như telegram-tt) hay đóng gói offline? Đây là quyết định về cập nhật, CSP và khả năng dùng SW.
5. Có yêu cầu **mã hoá dữ liệu cache cục bộ** (passcode như tweb `__encrypted`) không? Có thì ảnh hưởng thiết kế IDB ngay từ đầu.
6. Yêu cầu offline outbox trên mobile (gửi khi mất mạng rồi tự gửi lại) có nằm trong scope v1 không?
