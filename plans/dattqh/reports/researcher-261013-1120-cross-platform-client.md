# Nghiên cứu: Chat client web-first đa nền tảng (Capacitor + Tauri v2)

- Ngày: 2026-10-13 (Asia/Saigon). Repo: `chat-inet` (trống, greenfield).
- Phương pháp: đọc docs chính thức, kiểm tra trực tiếp npm registry, GitHub issues/source, và chạy thử FTS5 bằng SQLite 3.53.1 cục bộ. Chưa benchmark trên thiết bị thật.
- Phiên bản tại thời điểm viết: Capacitor 8.5.3 (Capacitor 9 đang alpha, dự kiến cuối 11/2026), Tauri 2.12 (v3 alpha), Solid 1.9.17 (2.0 RC), Svelte 5.57, React 19.3 + Compiler 1.0, Vue 3.5.43 (3.6 Vapor RC.11), Preact 11.0.1.

## 0. Kết luận nhanh

| Quyết định | Khuyến nghị | Lý do chính |
|---|---|---|
| UI framework | **SolidJS 1.9** (thứ 2: Svelte 5) | Fine-grained reactivity không VDOM, runtime khoảng 8 KB gz, `virtua`/TanStack Virtual đều hỗ trợ |
| Store web | `@sqlite.org/sqlite-wasm` + VFS `opfs-sahpool` trong dedicated Worker | Không cần COOP/COEP, nhanh nhất trong các OPFS VFS, có sẵn FTS5 |
| Store mobile | `@capacitor-community/sqlite` 8.1.1 (file SQLite native) | Notification Service Extension và FirebaseMessagingService đọc được DB/keys; không bị WebKit dọn storage |
| Store desktop | `rusqlite` (feature `bundled`) + 2 Tauri command tự viết | `tauri-plugin-sql` chưa hỗ trợ transaction (issue #886 vẫn mở) |
| Tìm kiếm | FTS5 `unicode61 remove_diacritics 2` **cộng với** tự fold `đ→d` trong TS | Test thực tế: `remove_diacritics 2` không fold được `đ` |
| Sync | Giao thức riêng dựa trên sequence (kiểu `pts`/getDifference của Telegram) | PowerSync/Electric không khớp với chat realtime (xem mục 2.5) |
| Mobile realtime | Không giữ WebSocket khi app ở background; dùng push và catch-up khi resume | iOS suspend app; plugin push không hỗ trợ silent push trên iOS |
| OTA | Capgo (plugin open-source, có thể self-host), chỉ cho bugfix và UI | Phù hợp Apple DPLA 3.3.1(B) nếu không đổi mục đích app |
| Monorepo | pnpm workspaces + Vite, 3 shell mỏng, adapter tách theo nền tảng | KISS; mỗi app chỉ bundle adapter của nó |

Ghi chú quan trọng: framework chỉ quyết định một phần nhỏ của cảm giác "cực nhanh". Phần lớn đến từ kiến trúc: render từ DB cục bộ trước khi gọi mạng, virtualization, optimistic send, và để I/O nặng ngoài main thread. Telegram Web A đạt tốc độ cao bằng framework tự viết kiểu React (Teact), GramJS chạy trong worker và cache nhiều tầng.

---

## 1. Chọn frontend framework

| Tiêu chí | SolidJS 1.9 | Svelte 5 | Vue 3.5 / 3.6 Vapor | Preact 11 + Signals | React 19 + Compiler |
|---|---|---|---|---|---|
| Runtime (min+gz, ước tính) | ~8 KB (bundlephobia 8.4 KB) | ~3–11 KB tùy component dùng (bundlephobia 10.8 KB) | 3.5: ~42 KB runtime đầy đủ (tự đo, chưa tree-shake); Vapor nhỏ hơn nhưng chưa có số chính thức | ~5 KB + 1.8 KB signals | ~55–60 KB react-dom (số phổ biến, không tự đo) |
| Reactivity | Signals, cập nhật thẳng DOM node | Runes, compile ra fine-grained | 3.5 VDOM; 3.6 Vapor fine-grained, reactivity viết lại theo alien-signals | VDOM; signal bind thẳng vào text node | VDOM; Compiler tự memo |
| Cập nhật nhỏ tần suất cao (typing, reaction, read receipt, tiến độ upload) | Tốt nhất: chỉ chạm đúng node | Rất tốt | Vapor tốt; VDOM ổn nếu memo đúng | Tốt nếu dùng signal đúng chỗ | Ổn khi Compiler memo đúng; vẫn tốn reconcile |
| Virtual list | virtua, TanStack Virtual | virtua (svelte ≥5), TanStack | virtua, TanStack | Qua React compat | Phong phú nhất |
| Hệ sinh thái/tuyển dụng | Nhỏ | Trung bình | Lớn (và iNET có design system Vue) | Nhỏ | Lớn nhất |
| Rủi ro | Solid 2.0 RC (rc.14, 08/10/2026), sẽ phải migrate | Thấp, stable từ 10/2024 | 3.6 vẫn RC; Vuetify là VDOM nên dùng interop sẽ mất lợi ích kích thước | Preact 11 vừa ra 08/10/2026 | Thấp, nhưng bundle nặng nhất |

**Xếp hạng cho chat UI:** (1) SolidJS, (2) Svelte 5, (3) Vue 3.6 Vapor, (4) Preact + Signals, (5) React 19.

- Chọn Solid vì danh sách tin nhắn dài, có nhiều cập nhật nhỏ liên tục, rất hợp với signals và store theo từng message (`createStore` + `<For>`). Bundle nhỏ cũng giúp cold start trong WebView, đặc biệt trên Android tầm thấp.
- Bắt đầu với 1.9 stable. Giữ toàn bộ domain logic (protocol, sync, repository, search) trong `packages/core` thuần TS, không import framework, để việc lên Solid 2.0 hay đổi framework chỉ ảnh hưởng `packages/ui`.
- Nếu team chỉ quen Vue và bắt buộc dùng lại `@inet/ui` (Vue 3 + Vuetify), Vue là phương án chấp nhận được. Khi đó không nên dùng component Vuetify trong message list (hot path) và cần chờ 3.6 stable mới bật Vapor. Đây là câu hỏi mở số 2.

## 2. Lưu trữ cục bộ trên 3 target

### 2.1 Một abstraction duy nhất

Thiết kế driver quanh **batch nguyên tử** thay vì transaction tương tác. Lý do: mỗi lần gọi đều phải vượt bridge (Capacitor), IPC (Tauri) hoặc postMessage (worker), và `tauri-plugin-sql` không pin connection cho transaction.

```ts
export interface SqlDriver {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  batch(stmts: { sql: string; params?: unknown[] }[]): Promise<void>; // atomic, 1 lần qua bridge
  close(): Promise<void>;
}
```

Migrations là các file `.sql` trong `packages/core/migrations`, do một migrator TS duy nhất chạy qua `SqlDriver` (DRY). Không dùng hệ migration riêng của từng plugin.

### 2.2 Driver theo target

| Target | Driver khuyến nghị | FTS5 | Ghi chú |
|---|---|---|---|
| Web | `@sqlite.org/sqlite-wasm` 3.53.4, VFS `opfs-sahpool`, chạy trong dedicated Worker | Có (đã kiểm `ENABLE_FTS5` trong compile options của `sqlite3.wasm`) | Không cần COOP/COEP; Safari ≥16.4. Không mở được ở tab thứ hai (xem 2.4) |
| Capacitor iOS/Android | `@capacitor-community/sqlite` 8.1.1 (peer `@capacitor/core >=8`, ~183k lượt tải/tuần, Capawesome maintain) | Android: có (`sqlcipher-android` Android.mk bật `ENABLE_FTS5`). iOS: dùng SQLCipher.swift dạng binary xcframework nên **chưa xác minh**, cần spike `PRAGMA compile_options` | Luôn dùng SQLCipher, mã hóa là tùy chọn. Đặt DB trong App Group container để NSE đọc được |
| Tauri desktop | `rusqlite` (feature `bundled`, v0.40.2) + command `db_query` / `db_batch` | Có (build.rs của bản bundled bật `-DSQLITE_ENABLE_FTS5`) | Một connection, WAL mode, transaction thực hiện trong Rust |

**Các phương án bị loại:**

| Phương án | Lý do loại |
|---|---|
| IndexedDB thuần | Không có SQL/FTS, phải tự viết index tìm kiếm, query join chậm |
| Web driver của plugin (jeep-sqlite) | Lưu trên IndexedDB. Chính repo đang có issue #693 đề xuất thay bằng sqlite-wasm + OPFS |
| `tauri-plugin-sql` | Issue #886 "Add support for transactions" vẫn mở, #1817 cho thấy lỗi `database is locked` khi BEGIN/COMMIT tách lệnh; thêm overhead của sqlx pool |
| sqlite-wasm/OPFS bên trong WebView của Capacitor/Tauri | NSE và FirebaseMessagingService không đọc được DB nằm trong storage riêng của WebKit; WKWebView có thể bị dọn website data; hỗ trợ OPFS trên WebKitGTK chưa chắc chắn |
| VFS `opfs` (bản thường) | Cần COOP/COEP (SharedArrayBuffer), mọi tài nguyên cross-origin như ảnh/CDN đều phải gửi header CORP; Safari dưới 17 lỗi |

### 2.3 FTS5 cho tiếng Việt (kết quả test thực tế, SQLite 3.53.1)

Dữ liệu test: "Đặng Thị Hồng đã gửi tin nhắn ổn định NGƯỜI dùng".

| Query | `unicode61 remove_diacritics 1` | `unicode61 remove_diacritics 2` | `trigram remove_diacritics 1` |
|---|---|---|---|
| `gui`, `nhan`, `nguoi`, `hong` | 0 (hỏng: ử, ắ, ườ, ồ là codepoint mang 2 dấu) | 1 | 1 |
| `dang` (cho "Đặng"), `dinh` (cho "định") | 0 | **0** (`đ` U+0111 không có decomposition) | 0 |
| `ôn` cho "ổn" | 0 | 1 | 0 (chuỗi dưới 3 ký tự không khớp với trigram) |
| Văn bản dạng NFD (gõ Unicode tổ hợp) | — | Khớp như NFC, trừ `đ` | — |

**Khuyến nghị:**
- Index một cột đã fold bằng một hàm TS duy nhất, dùng cho cả lúc ghi lẫn lúc query: `s.normalize('NFD').replace(/\p{M}/gu,'').replace(/[đĐ]/g,'d').toLowerCase()`. Vẫn khai báo `unicode61 remove_diacritics 2` làm lớp bảo vệ thứ hai.
- Dùng FTS5 external-content (`content='messages'`) đồng bộ bằng trigger, hoặc contentless-delete để tiết kiệm dung lượng. Query theo prefix (`term*`).
- Không dùng trigram làm mặc định: index lớn hơn nhiều và query từ 2 ký tự không hoạt động.
- Search cục bộ chỉ phủ phần lịch sử đã sync. Lịch sử đầy đủ vẫn cần server-side search.

### 2.4 Bẫy đã biết

- **Nhiều tab (web):** `opfs-sahpool` khởi tạo lần hai cùng origin sẽ lỗi. Dùng Web Locks (`navigator.locks.request('db-owner')`) để bầu một tab leader giữ DB worker và WebSocket; các tab khác proxy qua `BroadcastChannel`. Có thể dùng thêm pause/unpause từ 3.50 khi chuyển leader.
- **OPFS trong private mode:** Firefox và Safari không hỗ trợ (theo docs PowerSync). Khi đó fallback về DB trong bộ nhớ, coi web là cache.
- **COOP/COEP:** chỉ cần nếu dùng VFS `opfs`. Không cần với `sahpool`, nên tránh được việc header phá nhúng ảnh, video, OAuth popup.
- **Plugin và `invoke` chỉ chạy trên main thread:** Capacitor plugins và Tauri `invoke` không gọi được từ Worker. Vì vậy trên native, sync engine chạy ở main thread và phần nặng nằm ở native. Trên web, DB nằm trong worker. Phần xử lý nặng như giải mã hay crypto đưa vào worker riêng.
- **Chi phí JSON qua bridge/IPC:** phân trang khoảng 50 tin mỗi query, không trả về blob qua bridge (ảnh lưu file và tham chiếu bằng đường dẫn).

### 2.5 PowerSync / ElectricSQL

| | PowerSync | Electric | Giao thức seq tự viết |
|---|---|---|---|
| Mô hình | Postgres/Mongo/MySQL đồng bộ xuống SQLite client, theo sync rules | Chỉ read-path: "Shapes" từ Postgres qua HTTP; ghi đi qua API của bạn; client dùng PGlite | Server cấp `seq` theo user; client gửi `since` để lấy difference |
| Capacitor | Có, SDK beta (0.9.3), dựa trên plugin community; chưa mã hóa trên native, không multi-tab | Không có SDK riêng | Có |
| Tauri | Có nhưng "untested" trên Windows/iOS/Android, chỉ HTTP | Không | Có |
| Phù hợp chat | Trung bình: typing/presence/E2EE vẫn phải đi kênh khác | Thấp | Cao |

**Xếp hạng:** (1) giao thức seq tự viết, (2) PowerSync nếu backend dùng Postgres và muốn giảm phần tự viết, (3) Electric. Vẫn nên mượn pattern của chúng: local DB là nguồn render, có outbox cho tin chờ gửi, idempotency key cho mỗi tin.

## 3. Vòng đời kết nối realtime

### 3.1 Mobile (Capacitor)

- **Không cố giữ WebSocket ở background.** iOS suspend app sau vài giây, `beginBackgroundTask` chỉ kéo dài được tối đa khoảng 30 giây. Android Doze cũng cắt kết nối.
- **Khi `pause`** (`@capacitor/app` `appStateChange`): flush outbox, đóng socket gọn gàng, báo server "away" để server bắt đầu gửi push.
- **Khi `resume`/`online`:** render ngay từ SQLite, reconnect với `since=seq`. Server trả difference, hoặc trả "too long" để client tải lại snapshot danh sách chat. Backoff có jitter.
- **Keepalive do server chủ động ping, client trả lời trong `onmessage`.** Event mạng vẫn được giao khi timer JS bị throttle.

### 3.2 Push notifications

| Mảng | iOS | Android |
|---|---|---|
| Plugin | `@capacitor/push-notifications` 8.1.3 trả về **APNs token** | Plugin trả về FCM token |
| Hạn chế plugin | "does not support iOS Silent Push" | Data-only: "will NOT call `pushNotificationReceived` if the app has been killed" |
| Hiển thị phong phú hoặc giải mã | Notification Service Extension (target Swift, viết tay): `mutable-content: 1`, có alert, khoảng 30 giây để xử lý, đọc keys/DB qua App Group | `FirebaseMessagingService` tự viết (Kotlin): MessagingStyle, gom nhóm theo chat, inline reply |
| Badge | Server tính unread và gửi `badge` trong payload; app không tự cập nhật được khi đang bị suspend | Launcher tự đếm từ notification; đồng bộ lại khi resume |

- **Server phải gửi cả APNs lẫn FCM**, hoặc dùng `@capacitor-firebase/messaging` để thống nhất về FCM token.
- **Nếu có E2EE:** NSE phải giải mã bằng Swift, tức crypto phải viết hai lần (TS và Swift), trừ khi làm crypto core bằng Rust và bind qua UniFFI như hướng Element X / matrix-rust-sdk. Nếu không có E2EE, server tự dựng nội dung preview và NSE chỉ cần thiết cho avatar hay communication notification.
- **Chống trùng:** khi app đang foreground, đặt `presentationOptions: []` và hiển thị banner trong app. Server không gửi push nếu socket của user đang hoạt động.
- Gọi thoại (PushKit/CallKit) nằm ngoài phạm vi, nhưng sẽ cần thêm native code nếu có.

### 3.3 Desktop (Tauri v2)

| Nhu cầu | Giải pháp | Bẫy |
|---|---|---|
| Tray, close-to-tray | Tray có sẵn trong core (feature `tray-icon`) | Cinny issue #440 (+43) và #366 cho thấy người dùng kỳ vọng tính năng này ngay từ đầu |
| Autostart | `tauri-plugin-autostart` | Nên để mặc định tắt, người dùng tự bật |
| Một instance | `tauri-plugin-single-instance` (bật feature `deep-link`) | Phải là plugin đăng ký **đầu tiên** |
| Deep link | `tauri-plugin-deep-link` | macOS không đăng ký được lúc runtime, chỉ chạy khi app nằm trong `/Applications`; AppImage bị di chuyển thì link hỏng; phải validate URL |
| Thông báo | `tauri-plugin-notification` (chỉ local) | Windows chỉ hoạt động khi app đã được cài; Actions chỉ có trên mobile nên desktop không có inline reply; Web `Notification` API không xin được quyền (Cinny #360) |
| Badge | `setBadgeCount` (macOS/Linux), `setOverlayIcon` (Windows) | Cần cấp permission `core:window:allow-set-badge-count` |
| Auto-update | `tauri-plugin-updater` + JSON tĩnh trên object storage | Bắt buộc ký; mất private key thì không phát hành được update cho các bản đã cài |
| Mở link ngoài | `tauri-plugin-opener` | Cinny #544: link bị mở trong cửa sổ Tauri thay vì trình duyệt |
| Background | Config `backgroundThrottling: "disabled"` | Chỉ có tác dụng trên macOS ≥14 (và iOS ≥17); Windows/Linux phải dùng mẹo giữ một Web Lock đang chờ. Window bị ẩn khoảng 5 phút có thể bị suspend (issue #5250 vẫn mở) |

## 4. Hiệu năng trong WebView

| Engine | Cập nhật | Lưu ý |
|---|---|---|
| Android System WebView (Chromium) | Qua Play Store, khác nhau theo máy | Thường là engine mới nhất; nút thắt là CPU/GPU máy tầm thấp |
| WKWebView (iOS/macOS) | Chỉ theo phiên bản OS | Đặt min iOS sao cho có Safari ≥16.4 (OPFS, OffscreenCanvas); rAF có thể bị giới hạn 60 fps |
| WebView2 (Windows) | Evergreen | Ổn định nhất |
| WebKitGTK (Linux) | Theo distro, có thể khá cũ | Lỗi DMABUF/NVIDIA gây màn hình trắng (Cinny #227); WebRTC cần cấu hình thêm |

**Mẹo theo mức tác động:**
1. **Cache-first:** mở app là đọc 30–50 tin mới nhất và danh sách chat từ SQLite rồi paint ngay. Network chỉ làm nhiệm vụ bổ sung. Trên iOS, chỉ ẩn splash sau first paint từ DB.
2. **Virtualization:** `virtua` (~3 KB, có reverse scroll, prop `shift` để prepend lịch sử không bị nhảy, đo kích thước item động). Lưu ý: reverse scroll trên iOS Safari được đánh dấu "user must release scroll", cần test momentum scroll trên máy thật.
3. **Kích thước cố định:** server trả `w/h` và thumbhash cho media để chừa sẵn chỗ, tránh layout shift. Dùng `decoding="async"`, `loading="lazy"`, `createImageBitmap`/OffscreenCanvas trong worker để tạo thumbnail trước khi upload.
4. **Chỉ animate `transform`/`opacity`.** Tránh `backdrop-filter` và bóng đổ lớn trên Android. `contain: content` cho mỗi message row.
5. **120 Hz:** iOS cần khai báo `CADisableMinimumFrameDurationOnPhone` trong Info.plist. Dựa vào native scroll của compositor, không cuộn bằng JS.
6. **Bàn phím:** trên iOS, `@capacitor/keyboard` có `resize: 'none'`, tự dịch composer theo `keyboardHeight` trong `keyboardWillShow` cho mượt kiểu Telegram (hoặc dùng `native` cho đơn giản, nhưng nó làm thay đổi `vh`). Trên Android, `keyboardWillShow` và `keyboardDidShow` gần như bắn cùng lúc; dùng `visualViewport`, `resizeOnFullScreen` khi app full screen.
7. **Safe area:** `viewport-fit=cover` + `env(safe-area-inset-*)`. Capacitor 8 có SystemBars xử lý edge-to-edge trên Android 15+.
8. **Code-split** settings, media viewer, call. Bundle ban đầu chỉ gồm danh sách chat và màn chat.

## 5. Build và phân phối

### 5.1 Monorepo đề xuất (pnpm workspaces + Vite; chưa cần Turborepo)

```
chat-inet/
├─ apps/
│  ├─ web/        # Vite entry: main.ts → startApp(webPlatform); PWA tùy chọn
│  ├─ mobile/     # Capacitor 8: capacitor.config.ts, ios/ (App + NotificationService ext, SPM),
│  │              # android/ (FirebaseMessagingService), main.ts → startApp(capacitorPlatform)
│  └─ desktop/    # Tauri v2: src-tauri/ (rusqlite commands, tray, plugins), main.ts → startApp(tauriPlatform)
├─ packages/
│  ├─ core/       # TS thuần: protocol, sync engine, repository, migrations/*.sql, search fold
│  ├─ ui/         # Solid components: chat list, message list, composer
│  ├─ platform/   # interface Platform (SqlDriver, Push, Lifecycle, Notify, Badge, Files)
│  ├─ platform-web/        # sqlite-wasm worker, Web Locks leader
│  ├─ platform-capacitor/  # plugin community sqlite, push, keyboard, app lifecycle
│  └─ platform-tauri/      # invoke wrappers, notification, updater, deep-link
└─ pnpm-workspace.yaml
```

Adapter được tách thành package riêng để Vite của mỗi app chỉ kéo dependency nền tảng của chính nó. `startApp(platform)` là điểm DI duy nhất. Dùng SPM ngay từ đầu cho iOS: Capacitor 8 mặc định SPM, và CocoaPods trunk chuyển sang read-only từ 02/12/2026.

### 5.2 CI và ký số (repo trên GitLab nên dùng GitLab CI; `tauri-action` chỉ có cho GitHub)

| Target | Runner | Ký số |
|---|---|---|
| iOS | macOS | Apple Distribution cert, provisioning profile cho **cả app lẫn NSE**, dùng fastlane match và App Store Connect API key |
| Android | Linux | Upload keystore + Play App Signing, build AAB |
| macOS | macOS | Developer ID Application, hardened runtime, notarize bằng `notarytool`, universal binary |
| Windows | Windows (hoặc Linux nếu dùng `signCommand`) | OV/EV hoặc Azure Artifact Signing qua `signCommand`; từ 2024 EV không còn cho uy tín SmartScreen ngay lập tức |
| Linux | Linux | AppImage/deb/rpm; chữ ký updater |
| Updater desktop | Bất kỳ | `TAURI_SIGNING_PRIVATE_KEY` cất trong CI secret (không đọc từ `.env`), sao lưu offline |

### 5.3 OTA cho mobile

| | Capgo (`@capgo/capacitor-updater` 8.52.1) | Capawesome Live Update (8.6.0) | Ionic Appflow |
|---|---|---|---|
| Mức dùng | ~367k lượt tải/tuần | ~80k lượt tải/tuần | Đang ngừng (nguồn bên thứ ba nói EoL 31/12/2027, chưa kiểm được trên trang của Ionic) |
| Self-host | Có (plugin và backend open-source) | Chủ yếu dùng Capawesome Cloud | Không |
| Channel, rollback, mã hóa bundle | Có | Có | — |

**Chính sách:**
- Apple 2.5.2 cấm tải code "introduces or changes features". DPLA 3.3.1(B) cho phép interpreted code nếu không đổi mục đích chính, không tạo storefront, không vượt sandbox.
- Google Play cho phép: "does not apply to code that runs in a virtual machine or an interpreter… (such as JavaScript in a webview or browser)".
- Quy tắc nội bộ: OTA chỉ dành cho bugfix và tinh chỉnh UI. Tính năng mới hoặc thay đổi native phải qua store. Gắn mỗi bundle với dải `nativeBuild` tương thích. Không force update trên bản App Store. Ký hoặc mã hóa bundle.
- Desktop không cần OTA riêng vì Tauri updater đã cập nhật toàn bộ app.

**Xếp hạng:** (1) Capgo self-host hoặc cloud, (2) Capawesome, (3) tự viết. Appflow bị loại.

## 6. App thực tế và bài học

- **Telegram Web A (`Ajaxy/telegram-tt`):** web client ở quy mô Telegram. Dùng Teact (tự viết lại mô hình React, gần như không dependency), GramJS trong worker, cache nhiều tầng, UI optimistic và progressive. Bài học: kỷ luật kiến trúc quan trọng hơn lựa chọn framework.
- **Cinny Desktop (Tauri v2, Matrix, 864 sao, push gần nhất 09/2026):** các issue được vote nhiều nhất cho thấy những gì bọc web client vào Tauri **không tự có**: tray (#440), dán ảnh từ clipboard (#69), quyền notification (#360), voice/WebRTC (#545), link mở sai cửa sổ (#544), AppImage trắng màn hình (#227), mở trùng instance (#210). Đây là danh sách phải làm từ đầu, không phải việc để sau.
- **Element X / matrix-rust-sdk:** core Rust dùng chung giúp NSE giải mã được. Đây là hướng nên đi nếu có E2EE.
- **Capacitor:** không tìm thấy app chat production công khai nào dùng Capacitor. Kết quả tìm kiếm chỉ có tutorial và sample. Đây là khoảng trống bằng chứng và cũng là một rủi ro.
- **Capacitor push:** post-mortem trên DEV ghi nhận push hỏng khi lên TestFlight do hardcode môi trường APNs. Cần test trên máy thật và TestFlight sớm.

## 7. Rủi ro (xếp theo mức độ)

| # | Rủi ro | Mức | Giảm thiểu |
|---|---|---|---|
| 1 | Desktop Windows/Linux bị suspend khi ẩn xuống tray, gây mất thông báo | Cao | Mẹo Web Lock, server chủ động ping, soak test 1–2 giờ ở trạng thái minimize; nếu không đạt thì chuyển socket và notify xuống Rust |
| 2 | E2EE kéo theo crypto trùng lặp ở NSE (Swift) và Android service | Cao (nếu có E2EE) | Quyết định E2EE sớm; nếu có, làm crypto core bằng Rust + UniFFI |
| 3 | Chưa có tiền lệ chat dùng Capacitor; scroll và bàn phím trên Android tầm thấp chưa được kiểm chứng | Trung bình–Cao | Spike sớm: message list 10k tin + composer trên một máy Android tầm thấp và một iPhone |
| 4 | FTS5 trên iOS (SQLCipher binary) chưa xác minh; `đ` không được fold | Trung bình | Spike `PRAGMA compile_options`; dùng hàm fold TS duy nhất |
| 5 | WebKitGTK: màn hình trắng, DMABUF, WebRTC | Trung bình | Tài liệu fallback env var, test trên Ubuntu LTS + NVIDIA |
| 6 | Solid 2.0, Capacitor 9 (11/2026, iOS 27 bắt buộc scenes), Tauri v3 sắp ra | Trung bình | Cô lập framework trong `ui/`, adapter trong `platform-*` |
| 7 | OTA bị Apple từ chối | Thấp–Trung bình | Áp quy tắc ở mục 5.3, không đẩy tính năng qua OTA |
| 8 | Mất khóa ký updater hoặc keystore | Thấp, hậu quả nghiêm trọng | Vault + bản sao offline |
| 9 | Web nhiều tab tranh nhau DB | Thấp | Bầu leader bằng Web Locks |
| 10 | Overhead JSON qua bridge/IPC | Thấp | Phân trang, batch, không truyền blob |

## 8. Giới hạn của nghiên cứu

- Chưa benchmark trên thiết bị. Số kích thước framework là kết hợp tự đo (Vue, Preact signals) và số bundlephobia hoặc số phổ biến (React).
- Trang Apple về NSE render bằng JS nên không đọc được. Con số khoảng 30 giây lấy từ hiểu biết chung, cần đối chiếu tài liệu Apple.
- Nguồn về OTA phần lớn do vendor (Capgo, Capawesome) viết, nên có thiên lệch.
- Chưa thiết kế giao thức backend, gọi thoại/WebRTC, hay chi tiết E2EE.

## Câu hỏi chưa giải quyết

1. Có E2EE không? Đây là quyết định ảnh hưởng lớn nhất tới NSE và kiến trúc crypto.
2. Team mạnh Vue và có bắt buộc dùng `@inet/ui` không? Nếu có thì cân nhắc lại giữa Solid và Vue 3.6.
3. Backend đã có chưa? Có cấp được `seq` theo user và API difference không?
4. Phiên bản OS tối thiểu (đề xuất iOS 16.4+, Android 8+ với WebView ≥ Chromium hiện hành, Windows 10+, Ubuntu 22.04+)?
5. Có gọi thoại/video trong lộ trình không (cần PushKit/CallKit, WebRTC trên WebKitGTK)?
6. Có yêu cầu lưu trữ dữ liệu trong nước (data residency) không? Điều này ảnh hưởng việc chọn Capgo cloud hay self-host. Android vẫn bắt buộc dùng FCM.
7. GitLab có sẵn macOS runner (cho iOS và notarize) không?

## Nguồn

- SQLite WASM persistence: https://sqlite.org/wasm/doc/trunk/persistence.md
- FTS5: https://www.sqlite.org/fts5.html
- wa-sqlite: https://github.com/rhashimoto/wa-sqlite
- @capacitor-community/sqlite: https://github.com/capacitor-community/sqlite (issue #693)
- Tauri SQL: https://v2.tauri.app/plugin/sql/ và plugins-workspace issue #886, #1817
- rusqlite build.rs: https://github.com/rusqlite/rusqlite/blob/master/libsqlite3-sys/build.rs
- Capacitor push: https://capacitorjs.com/docs/apis/push-notifications
- Capacitor keyboard: https://capacitorjs.com/docs/apis/keyboard
- Capacitor 8: https://ionic.io/blog/announcing-capacitor-8
- Tauri deep-link, updater, notification, Windows signing, webview versions: https://v2.tauri.app/plugin/deep-linking/, https://v2.tauri.app/plugin/updater/, https://v2.tauri.app/plugin/notification/, https://v2.tauri.app/distribute/sign/windows/, https://v2.tauri.app/reference/webview-versions/
- Tauri background throttling: https://github.com/tauri-apps/tauri/issues/5250; push plugin request: https://github.com/tauri-apps/tauri/issues/11651
- PowerSync: https://docs.powersync.com/client-sdk-references/capacitor, https://docs.powersync.com/resources/supported-platforms
- Electric: https://electric.ax/docs/intro
- virtua: https://github.com/inokawa/virtua
- Telegram Web A: https://github.com/Ajaxy/telegram-tt
- Cinny Desktop: https://github.com/cinnyapp/cinny-desktop (issues)
- Apple App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
- Google Play Device and Network Abuse: https://support.google.com/googleplay/android-developer/answer/9888379
- Capgo live updates: https://capgo.app/docs/live-updates/; Vue 3.6 RC: https://newreleases.io/project/github/vuejs/core/release/v3.6.0-rc.1
- Capacitor push post-mortem: https://dev.to/mistakili/the-production-bug-no-capacitor-push-notification-tutorial-prepared-me-for-1386
- npm registry và api.npmjs.org (phiên bản, lượt tải tuần tới 13/10/2026)
