# Đặc tả khung Observatory (phiên bản 1, kèm Live Map)

Nguồn duy nhất cho **khung Observatory**: thiết bị (web, PWA, app) đọc dòng thời gian của một phiên Claude Code mà Observatory của agent (`tunelo`) đã lưu
trong SQLite trên máy, qua kênh E2E sẵn có (`proto/remote/v1/remote.proto`, mục "Observatory"). Agent và web viết theo file này; khi mã và file này lệch nhau
thì sửa file này cùng lúc với mã.

Có từ `AGENT_VERSION` **3.26.0** (`AGENT_OBSERVATORY` trong `apps/web/src/machines/agent-version.ts`), không đổi số giao thức. Phần Live Map (mục 6: trạng
thái sống, sự kiện tạm, điểm nghẽn, nội dung theo id, số khoan sâu, liệt kê theo luồng) phát hành cùng bản, cờ riêng `AGENT_LIVE_MAP` (cũng 3.26.0) để web bật tab
"Quan sát". Agent cũ gặp các khung này trả `Error` với `ERROR_REASON_UNSUPPORTED_REQUEST` như mọi khung lạ, nên web chỉ dùng tính năng khi máy đủ bản.

Mã agent: `apps/agent/src/observatory/hub/` (hub, ánh xạ ra khung, trạng thái sống `live-state.ts`), `apps/agent/src/observatory/store/timeline-reads.ts`
(đọc dòng thời gian không nội dung), `apps/agent/src/observatory/store/live-map-reads.ts` (luồng → phiên, nội dung theo id, số khoan sâu),
`apps/agent/src/observatory/live-map/model-window.ts` (cửa sổ ngữ cảnh), `apps/agent/src/link/connection.ts` (đăng ký khung).

## 1. Khái niệm

- **Phiên**: một phiên Claude Code, gọi bằng `session_id` của chính Claude Code, **không phải** `thread_id` của tunelo: phiên chạy trong terminal hay CLI ngoài
  tunelo không có thread. Phiên tạo bởi `/clear` mang `previous_session_id` của phiên trước để giao diện nối tiếp.
- **Dòng thời gian**: mọi dòng của các bảng sự kiện trong DB của phiên: lượt prompt, lời gọi tool, subagent, lượt gọi API, tệp hướng dẫn được nạp, commit git,
  sự kiện vòng đời (`session_events`). Mỗi dòng là một **sự kiện** có `id` ổn định; dòng được ghi lại (tool kết thúc, subagent dừng, OTel ghép thêm số) tới
  thiết bị như sự kiện **cùng `id`**, thiết bị thay bản đang giữ.
- **Thứ tự**: theo thời gian (`at`; subagent theo lúc bắt đầu), rồi theo loại (prompt, tool, subagent, API, hướng dẫn, git, sự kiện vòng đời), rồi theo khoá
  của dòng. Thứ tự toàn phần, nên trang cũ nối liền ảnh chụp, không sót không lặp, kể cả các dòng cùng một mili giây.
- **`epoch`**: epoch của Observatory trên máy (mili giây lúc đặt, luôn tăng). Đổi khi agent hay Observatory khởi động lại và sau khi xoá dữ liệu.
- **`seq`**: số thứ tự sự kiện của một phiên đang được xem, tăng đúng 1 mỗi sự kiện. Agent chỉ giữ trạng thái phát của phiên khi có ít nhất một kết nối đang
  xem; không còn ai xem thì bỏ hết, lần xem sau bắt đầu dãy mới. Thiết bị luôn bắt đầu bằng ảnh chụp và lấy `seq` của ảnh chụp làm mốc.
- Thời gian là Unix mili giây theo đồng hồ của máy.

## 2. Khung (thân `Frame` số 186 đến 196)

Số đã giữ: **186–192** (lớn nhất trước đó trên `origin/main` và nhánh `feat/observatory-store` là 185, kiểm 23/11/2026) và **193–196** cho Live Map (lớn nhất
trên `origin/main` là 185, trên nhánh `feat/observatory-store` là 192, trên các nhánh khác của `origin` không quá 184, kiểm 23/11/2026). Lý do lỗi mới: **91–93**;
Live Map không thêm lý do, yêu cầu sai dùng lại `ERROR_REASON_OBSERVATORY_INVALID` (93). Khung văn phòng cũ **168–170** và mọi thông điệp `Office*` đánh dấu
`deprecated`: không bao giờ dùng lại các số đó.

| Số | Thân | Chiều | Trả lời |
|---|---|---|---|
| 186 | `ObservatorySessionList {limit=1, thread_id=2}` | A → B | `ObservatorySessionListResult` |
| 187 | `ObservatorySessionListResult {sessions=1 (ObservatorySessionInfo)}` | B → A | |
| 188 | `ObservatoryWatch {session_id=1, on=2, limit=3}` | A → B | `on`: `ObservatorySnapshot`; tắt: `Ack` |
| 189 | `ObservatorySnapshot {session_id=1, epoch=2, seq=3, session=4 (ObservatorySessionState), events=5, earlier=6}` | B → A | |
| 190 | `ObservatoryEvents {session_id=1, epoch=2, events=3}` | B → A, không hỏi | |
| 191 | `ObservatoryEarlier {session_id=1, earlier=2, limit=3}` | A → B | `ObservatoryEarlierResult` |
| 192 | `ObservatoryEarlierResult {session_id=1, events=2, earlier=3}` | B → A | |
| 193 | `ObservatoryContent {session_id=1, event_id=2}` | A → B | `ObservatoryContentResult` |
| 194 | `ObservatoryContentResult {session_id=1, event_id=2, state=3, text=4}` | B → A | |
| 195 | `ObservatoryStation {session_id=1, station=2, at=3}` | A → B | `ObservatoryStationResult` |
| 196 | `ObservatoryStationResult {session_id=1, station=2, at=3, numbers=4, parts=5, slowest=6, recent=7, previous=8, bottlenecks=9}` | B → A | |

- `ObservatorySessionList`: phiên gần đây nhất của máy, **mới nhất trước** (theo `started_at`). `limit` 0 là 50, tối đa 200. Có cả phiên nội bộ (Cố vấn,
  `internal_label` khác rỗng): thiết bị tự quyết ẩn hay hiện. Có `thread_id`: chỉ các phiên Claude Code của luồng đó (mục 6.1); luồng của AI khác hay luồng máy
  không có: danh sách rỗng.
- `ObservatoryWatch{on}`: ảnh chụp gồm dòng của phiên và số tổng (`session`), cộng **N sự kiện mới nhất**, cũ trước (`limit` 0 là 200, tối đa 500; `seq` của
  chúng là 0). `earlier` khác rỗng khi còn sự kiện cũ hơn. Xem phiên chưa có trong DB vẫn được: ảnh chụp rỗng (`session.info` không đặt), sự kiện tới khi
  dòng được ghi.
- `ObservatoryWatch{on}` lần nữa cho phiên đang xem là **xin ảnh chụp mới** (khi hở `seq`, đổi epoch, nối lại). Không có khung xin ảnh chụp riêng.
- `ObservatorySnapshot.seq` là sự kiện cuối đã gộp vào ảnh chụp; `ObservatoryEvents` sau đó của cùng epoch bắt đầu từ `seq + 1`.
- `ObservatoryEarlier`: sự kiện trước `earlier` (lấy từ ảnh chụp hay trang trước, gửi lại nguyên văn), cũ trước, `limit` như trên. Không cần đang xem. Không
  dời mốc `seq`.
- Một kết nối xem được nhiều phiên; mỗi kết nối chỉ nhận `ObservatoryEvents` của phiên nó đang xem. Đóng kết nối là tắt mọi lượt xem của nó.
- Trần: **4** phiên mỗi kết nối, **16** phiên cho cả máy, **8** kết nối cùng xem một phiên. Vượt trần: `Error` (`ERROR_CODE_INVALID`,
  `ERROR_REASON_OBSERVATORY_WATCH_LIMIT`); không lượt xem nào bị đẩy ra. Xem lại phiên kết nối đang xem không bao giờ bị từ chối.
- Observatory tắt trên máy, hoặc DB chưa mở được: mọi khung trên trả `Error` (`ERROR_CODE_INVALID`, `ERROR_REASON_OBSERVATORY_OFF`).
- `session_id` rỗng, dài quá 200 ký tự hay có ký tự điều khiển, `earlier` hay `event_id` không do máy này tạo, `station` không phải tên trạm (chữ hoa và `_`,
  tối đa 32 ký tự), `at` âm: `Error` (`ERROR_CODE_INVALID`, `ERROR_REASON_OBSERVATORY_INVALID`).
- Sự kiện được gom tối đa 250 ms một khung. Không gửi khung rỗng.
- Kết nối đang nghẽn (socket còn trên 1 MiB chưa gửi) thì khung sự kiện của nó bị bỏ: thiết bị thấy hở `seq` và xin ảnh chụp mới. Agent đọc lại dòng từ DB
  bị lỗi cũng bỏ qua một `seq` cho cùng mục đích.

### Quy tắc phía thiết bị

1. Bỏ mọi khung có `epoch` khác epoch của ảnh chụp đang giữ; epoch khác thì xem lại (`ObservatoryWatch{on}`).
2. Sự kiện có `seq` ≤ seq đã áp: bỏ.
3. Sự kiện có `seq` > seq đã áp + 1: **hở** → xem lại, bỏ các sự kiện tới trước khi ảnh chụp về.
4. Ảnh chụp thay toàn bộ trạng thái của phiên. Sự kiện có `id` đã giữ thay bản cũ; `id` mới thì chèn theo thứ tự ở mục 1.
5. Sự kiện không có `kind` hoặc `kind` lạ (của agent mới hơn): chỉ tăng `seq` đã áp.
6. Nối lại kết nối thì xem lại.

## 3. Trạng thái (`ObservatorySessionState`) và sự kiện (`ObservatoryEvent`)

`ObservatorySessionState {info=1 (ObservatorySessionInfo), totals=2 (ObservatorySessionTotals), live=3 (ObservatoryLiveState, mục 6.3)}`.

`ObservatorySessionInfo {session_id=1, previous_session_id=2, previous_session_inferred=3, project_key=4, cwd=5, source=6, internal_label=7, started_at=8,
ended_at=9, main_model=10}`:

| Trường | Ý nghĩa |
|---|---|
| `previous_session_id` | Phiên trước `/clear`; rỗng khi không có. `previous_session_inferred`: nối bằng ghép thời gian, không phải Claude Code báo |
| `project_key` | Kho mã: remote `origin` đã bỏ mật khẩu (`github.com/acme/app`), `local:<tên thư mục>` khi không có remote, `scratch` cho thư mục tạm (`apps/agent/src/usage/repo-key.ts`) |
| `cwd` | Thư mục làm việc, thư mục nhà là `~` |
| `source` | `SDK` (tunelo chạy qua Agent SDK), `TERMINAL`, `CLI` (hook đã cài; phiên terminal của tunelo cũng có thể báo là `CLI` vì bản ghi giống nhau) |
| `internal_label` | Phiên nội bộ (Cố vấn), loại khỏi thống kê; rỗng với phiên thường |
| `ended_at` | 0 khi chưa kết thúc |

`ObservatorySessionTotals {prompts=1, tool_calls=2, tool_failures=3, subagents=4, api_requests=5, input_tokens=6, output_tokens=7, cache_read_tokens=8,
cache_write_tokens=9, cost_usd_estimate=10, has_cost=11, git_ops=12, session_events=13, last_event_at=14}`: số đếm và tổng của mọi dòng đã lưu của phiên.
`cache_write_tokens` gộp ghi cache 5 phút và 1 giờ; `cost_usd_estimate` là tổng ước tính của Claude Code, chỉ có nghĩa khi `has_cost`.

`ObservatoryEvent {seq=1, at=2, id=3, oneof kind, provisional=13}` (`provisional`: mục 6.2):

| Số | `kind` | `id` | Trường |
|---|---|---|---|
| 4 | `prompt` | `prompt:<prompt_id>` | `prompt_id`, `length` (độ dài, đơn vị UTF-16). **Không bao giờ chữ của prompt** |
| 5 | `tool_call` | `tool:<tool_use_id>` | `tool_use_id`, `prompt_id`, `agent_id` (rỗng: agent chính), `tool_name`, `mcp_server`, `target` (nhãn bộ lọc riêng tư giữ: tệp dạng `thư mục/tên`, tên miền, chương trình của lệnh, `server › tool`), `duration_ms`, `input_bytes`, `output_bytes`, `success` (không đặt khi chưa xong), `error` (mã cố định `failed`, `interrupted`, `permission denied`), `station`, `station_flags`, `target_key` (khoá có muối của tệp), `read_offset`, `read_limit` |
| 6 | `subagent` | `subagent:<agent_id>` | `agent_id`, `prompt_id`, `agent_type`, `started_at`, `ended_at` (0 khi đang chạy), `model`, `total_tokens`, `tool_count` |
| 7 | `api_request` | `api:<khoá chống trùng>` | `prompt_id`, `agent_id`, `model`, token theo loại, `cost_usd_estimate` (không đặt khi Claude Code không báo), `duration_ms`, `ttft_ms`, `query_source` |
| 8 | `instruction_loaded` | `instruction:<số>:<lý do>:<tệp>` | `file_path` (thư mục nhà là `~`), `memory_type`, `load_reason`, `load_seq` |
| 9 | `git_op` | `git:<số dòng>` | `prompt_id`, `sha`, `branch`, `kind` |
| 10 | `session_event` | `event:<khoá chống trùng>` | `kind`, `agent_id`, `tool_use_id`, `station`, `label`, `number`, `flag` |
| 11 | `session` | `session` | `ObservatorySessionState` mới (chỉ trong `ObservatoryEvents`, sau các sự kiện cùng khung, chỉ khi dòng phiên, số tổng hay trạng thái sống đổi) |
| 12 | `bottleneck` | `bottleneck:<quy tắc>:<khoá con>` | phát hiện điểm nghẽn (mục 6.4) |

- Trường số kiểu `optional` không đặt nghĩa là DB không có giá trị (khác 0).
- `station` là trạm Live Map (`CORE`, `FILES`, `MEMORY`, `TESTING`, `GIT`, `SANDBOX`, `MCP`, `EXTERNAL`, `SKILLS`, `ORCHESTRATOR`); `station_flags` là các bit
  `commit` 1, `push` 2, `deploy` 4, `write` 8, `memory` 16, `estimated` 32 (đặt theo nhãn đã lọc, có thể sai), `background` 64 (lệnh Bash/PowerShell chạy với `run_in_background`), `ci` 128 (lệnh theo dõi CI: `gh run watch|view|list|rerun`, `gh pr checks`,
  `glab ci …`, `glab pipeline …`; trạm vẫn `GIT`). Nguồn: `apps/agent/src/observatory/live-map/station-map.ts`.
- `session_event.kind`: `permission_request`, `permission_decision`, `permission_denied`, `hook_block`, `compact_start`, `compact_end`, `stop`, `stop_failure`,
  `notification`, `model_change`, `permission_mode`, `todo_counts`, `api_error`, `mcp_connection`, `ci_started`, `ci_finished`, `ci_cancelled` (`SESSION_EVENT_KINDS` trong
  `apps/agent/src/observatory/store/observatory-rows.ts`). Loại lạ: thiết bị bỏ qua.
- `ci_started` / `ci_finished`: một lượt chạy GitHub Actions sau `git push` của phiên (agent theo dõi bằng `gh run list` mỗi 15 giây, chỉ khi `project_key` là
  remote GitHub, `gh` đã đăng nhập và công tắc `observatory.ci.enabled` bật; `apps/agent/src/observatory/ci/ci-watcher.ts`). `label` là tên workflow,
  `station` là `GIT`; `ci_started` có `at` là lúc lượt chạy được tạo; `ci_finished` có `at` là lúc xong, `flag` là kết quả `success`, `number` là thời gian
  chạy (ms). Lượt chạy bị huỷ (thường vì có push mới hơn thay nó) ghi `ci_cancelled` thay cho `ci_finished`: `at` là lúc huỷ, `number` là thời gian chạy, **không
  đặt `flag`**; thiết bị hiện "đã huỷ" (không ✓ cũng không ✗) và không để nó thay trạng thái của lượt chạy mới hơn cùng workflow. Khoá trùng theo id lượt chạy và loại. Không có URL, commit message hay tên người. Lượt theo dõi kết thúc khi lượt chạy chưa xong (hết 30 phút,
  `gh` đăng xuất, agent dừng hoặc xoá dữ liệu) thì ghi `ci_finished` **không đặt `flag`** và không có `number`: kết quả không rõ, `at` là lúc
  agent bỏ theo dõi; khoá trùng riêng (id lượt chạy kèm `unknown`), nên kết quả thật đọc được sau vẫn được lưu và thắng. Thiết bị hiện `flag` không đặt là "không
  rõ" (không ✓ cũng không ✗), và coi một lượt `ci_started` chưa có `ci_finished` quá 45 phút là không rõ (agent khởi động lại giữa chừng, hoặc người dùng tắt
  công tắc: khi đã tắt, agent không ghi thêm dòng nào).
- Một dòng được ghi lại y hệt (đọc lại spool, nguồn thứ hai) không gửi sự kiện mới. Agent nhớ bản gửi cuối của 2 000 dòng gần nhất mỗi phiên; dòng cũ hơn ghi lại
  thì gửi lại cùng `id`, vô hại.

### Vòng đời

- Hub tạo cùng dịch vụ Observatory (`observatory-service.ts`) và chạy theo nó: `start` đặt epoch mới; `stop` (đầu tiên trong thứ tự dừng, trong cùng 5 giây chờ)
  bỏ phần chờ gửi và từ chối yêu cầu cho tới lần `start` sau; xoá dữ liệu (`wipe`) đặt epoch mới. Lượt xem vẫn giữ qua `stop`/`start`: thiết bị nhận khung có
  epoch mới và xem lại.
- Nguồn sự kiện là DB: mỗi lô ghi vào store báo hub các dòng vừa chạm; dòng của phiên đang xem được đọc lại đúng như đã lưu (đã gộp) rồi gửi. Phiên không ai xem:
  hub không đọc gì, không giữ gì.
- Người xem đầu tiên của một phiên bật đọc đuôi spool cho phiên đó (`watchSession`), người cuối rời thì tắt (`unwatchSession`); dòng đọc được tới thiết bị ngay
  dưới dạng sự kiện tạm (mục 6.2).
- Spool của phiên terminal và CLI được nạp vào DB chậm 5–75 giây; sự kiện tạm tới trước trong vòng nửa giây cộng thời gian gom, bản DB tới sau cùng `id`.

## 4. Cam kết dữ liệu không rời máy

Không khung Observatory nào chứa: chữ của prompt, input hay output của tool, nội dung tin nhắn, lỗi dạng chữ tự do, nội dung tệp, đường dẫn đầy đủ dưới thư mục nhà
(luôn là `~`), hay **bất kỳ định danh tài khoản nào** (email, mã tài khoản, `organization.id`, tên người dùng của hệ điều hành). Chỉ đi ra: id, nhãn bộ lọc riêng
tư đã giữ, số, cờ. Nội dung đã lưu (bản cắt ngắn khi dự án bật lưu nội dung) **ở lại DB**; đường duy nhất đưa nó ra là `ObservatoryContent` theo id (mục 6.5),
đọc DB lúc hỏi với công tắc nội dung của dự án.

Bảo đảm bằng mã: `timeline-reads.ts` bỏ `prompts.excerpt` và `tool_calls.content` ngay lúc đọc, `hub/observatory-wire.ts` chép từng trường theo tên (cột mới của
bảng không tự lên dây). Test `apps/agent/test/observatory/observatory-link.test.ts` bật lưu nội dung (mặc định), bơm chuỗi đánh dấu vào prompt, lệnh và output
cùng các định danh giả của `observatory-payloads.ts`, xác nhận bản xuất DB có chuỗi đánh dấu, rồi quét mọi khung hai thiết bị nhận (JSON và byte protobuf) để
khẳng định không có chuỗi đánh dấu, định danh hay tên khoá định danh nào; `observatory-hub.test.ts` làm tương tự với ảnh chụp, sự kiện và trang cũ.

## 5. Giới hạn

- Ảnh chụp và trang cũ tối đa 500 sự kiện (mặc định 200). Danh sách phiên tối đa 200 (mặc định 50).
- 4 phiên mỗi kết nối, 16 phiên cho cả máy, 8 kết nối mỗi phiên.
- Gom sự kiện 250 ms; `session` chỉ gửi khi đổi.
- Sự kiện tạm giữ tối đa 2 000 dòng mỗi phiên đang xem (cũ nhất bị bỏ). Trạng thái sống tính trên 200 sự kiện mới nhất cùng các dòng cũ hơn còn ảnh hưởng
  tới nó (mục 6.3), trong đó tối đa 200 lời gọi tool đang chạy.
- Khoan sâu: p50/p95 trên tối đa 10 000 thời lượng (lấy mẫu đều, cờ `sampled`); 20 phần, 5 mục chậm nhất, 20 sự kiện gần nhất, 5 phiên trước, 50 phát hiện.
  Đo: dưới 100 ms trên DB 200 000 dòng `tool_calls` (`live-map-hub.test.ts`).

## 6. Live Map

### 6.1 Luồng → phiên

`ObservatorySessionList{thread_id}`: agent lấy `session_id` mà từng đoạn (segment) của luồng tunelo ghi, chỉ đoạn của AI Claude Code (`claude`), rồi đi theo
`sessions.previous_session_id` **cả hai chiều**: lùi tới các phiên trước `/clear`, tiến tới phiên mới hơn (luồng có thể vẫn ghi phiên trước lần `/clear` cuối,
`agent-core.ts` chỉ ghi đè `sessionId` khi Claude Code báo). Phiên của đoạn chưa có trong DB vẫn được đi theo. Tối đa 500 phiên được xét; trả mới nhất trước,
theo `limit`. Nối suy đoán (`previous_session_inferred`) cũng được đi theo.

### 6.2 Sự kiện tạm (`provisional`)

Spool của phiên terminal và CLI vào DB chậm; với phiên đang có người xem, agent đọc đuôi các tệp phút chưa nạp (`spool/spool-live-tail.ts`, nửa giây một lần),
bỏ nội dung trước mọi bước, chuẩn hoá như lúc ghi DB và gửi **sự kiện tạm** (`provisional = true`) **cùng `id` mà dòng DB sẽ có**. Nhiều bản ghi của một dòng
(bắt đầu rồi kết thúc tool) gộp thành một sự kiện. Khi DB có dòng đó:

- DB có đủ những gì bản tạm biết: gửi bản DB (`provisional = false`) như sự kiện **cập nhật** cùng `id`; bản tạm bị bỏ.
- DB còn thiếu (đã có lúc bắt đầu, chưa có kết thúc): gửi bản DB đã điền phần bản tạm biết, vẫn `provisional = true`, tới khi DB đủ.

Ảnh chụp gồm cả sự kiện tạm chưa có trong DB, mới hơn sự kiện cũ nhất của ảnh chụp (có thể vượt `limit`). Lệnh commit không có sự kiện `git_op` tạm (khoá của
nó là số dòng DB): lời gọi tool mang cờ `commit` của trạm `GIT` đủ để cảnh chuyển động. Tệp hướng dẫn nạp được đánh số như ingest sẽ đánh (sau các lần nạp đã
lưu và đang giữ của cùng tệp, cùng lý do); số đoán sai thì bản DB tới với `id` khác. Thiết bị sắp sự kiện theo `(at, id)` như mục 1.

Spool reader chỉ xoá một tệp phút khi mọi bản ghi trong đó đã vào DB hoặc đã bị cách ly. Đuôi spool thấy tệp nó từng đọc biến mất thì báo hub
(`spoolFileTaken`); sự kiện tạm không còn tệp nào chưa được nạp thì:

- DB có dòng đó: gửi bản DB (`provisional = false`), kể cả khi bản DB thiếu phần chỉ bản tạm biết (bản ghi kết thúc bị cách ly). DB là sự thật cuối cùng.
- DB không có (bản ghi bị cách ly hay bị từ chối, tệp hướng dẫn bị đánh số khác lúc đoán): hub **rút lại** sự kiện tạm bằng cách bỏ qua một `seq` rồi gửi
  `session`. Thiết bị thấy khoảng trống, xin ảnh chụp mới, và ảnh chụp không còn sự kiện đó. Không cần trường hay loại sự kiện mới trên dây.

Sự kiện tạm bị đẩy khỏi giới hạn 2 000 dòng (mục 5) vẫn được bản DB thay khi DB nhận nó; chỉ khi bản ghi đó **cũng** bị cách ly thì thiết bị giữ nó tới ảnh
chụp kế tiếp. Lịch sử tua lại của thiết bị giữ những gì cảnh trực tiếp đã hiện, nên sự kiện đã rút vẫn có trong đó tới lần xem lại phiên.

### 6.3 Trạng thái sống (`ObservatoryLiveState`)

`{core=1, tokens_per_second=2, context_percent=3, context_tokens=4, context_window=5, context_window_assumed=6, main_model=7, running=8
(ObservatoryStationCount {station, count}), open_bottlenecks=9, subagents=10 (ObservatoryRunningSubagent {agent_id, agent_type}, tunelo 3.30.0+)}`. Agent tính bằng hàm thuần `hub/live-state.ts` trên 200 sự kiện mới nhất (cả sự kiện
tạm), đặt sau các dòng cũ hơn vẫn còn ảnh hưởng tới kết quả (`store/live-map-reads.ts` `readLiveCarry`): dòng mới nhất của mỗi loại đặt trạng thái lõi, lần
kết thúc lượt mới nhất, các subagent chưa dừng (tối đa 200, mới nhất), các lời gọi tool chưa kết thúc kể từ đó (tối đa 200, mới nhất) cùng sự kiện báo chúng không
chạy, và lượt API mới nhất của luồng chính (cả lượt mới nhất có tốc độ). Nhờ vậy kết quả bằng kết quả tính trên toàn bộ phiên, kể cả khi một lời gọi dài hay một
subagent chạy lâu bắt đầu trước 200 sự kiện gần nhất. `subagents` là các subagent đã bắt đầu, chưa dừng (rỗng khi phiên đã kết thúc): Live Map vẽ chúng quanh
model kể cả khi sự kiện bắt đầu không còn trong các sự kiện thiết bị giữ. Thiết bị tua
lại áp **cùng quy tắc** lên các sự kiện tới mốc thì ra cùng kết quả. Chỉ `open_bottlenecks` và ngữ cảnh lớn nhất của phiên
được đọc thêm từ DB (có thể cũ hơn 200 sự kiện); khi tua, thiết bị lấy từ sự kiện `bottleneck` (mở khi `opened_at ≤ mốc` và chưa `closed_at ≤ mốc`).

Trạng thái lõi (`ObservatoryCoreState`) theo sự kiện cuối có nói về nó:

| Sự kiện | Trạng thái |
|---|---|
| prompt, tool, subagent bắt đầu, lượt API của luồng chính (trừ việc phụ Claude Code chạy sau lượt: `query_source` là `prompt_suggestion` hoặc `generate_session_title`; một subagent chỉ có lúc dừng cũng không tính), `permission_decision`, `permission_denied`, `hook_block` | `THINKING` (hook và OTel không tách nghĩ với viết) |
| `permission_request`, `notification` nhãn `permission_prompt` | `WAITING_PERMISSION` |
| `compact_start` | `COMPACTING`; `compact_end` về `THINKING` nếu đang trong lượt, không thì `WAITING_USER` (hay `IDLE` nếu trước đó rảnh) |
| `stop`, `notification` nhãn `idle_prompt` | `WAITING_USER` (kết thúc lượt) |
| tool kết thúc với `error` = `interrupted` (người dùng bấm Esc/Ctrl+C; khi đó Claude Code không gửi `Stop`) | `WAITING_USER` (kết thúc lượt) |
| `stop_failure` | `FAILED` (kết thúc lượt) |
| đang `WAITING_USER` mà còn subagent đã bắt đầu, chưa dừng (`ended_at` = 0): Claude Code kết thúc lượt chính và chờ tác tử chạy nền | `THINKING` (việc vẫn tiếp diễn) |
| đang `WAITING_USER` mà còn lệnh shell chạy nền (cờ `background`) chưa biết là đã xong: Claude Code không gửi sự kiện khi shell kết thúc, nên lệnh coi là còn chạy tới khi có lượt (`prompt`) mới (thông báo hoàn tất của Claude Code mở một lượt) hoặc một lời gọi `KillShell` | `THINKING` (ước lượng) |
| không có sự kiện; phiên đã kết thúc (`ended_at` ≥ sự kiện cuối) | `IDLE` |

- `running`: lời gọi tool chưa kết thúc (`success` chưa đặt) kể từ lúc lượt bắt đầu, theo trạm; lời gọi có `permission_denied` hay `hook_block` cùng
  `tool_use_id` không tính; kết thúc lượt đặt về rỗng.
- `tokens_per_second`: lượt API mới nhất của luồng chính có `output_tokens` và `duration_ms`: `output_tokens / (duration_ms − ttft_ms)` giây (thiếu TTFT thì
  cả thời lượng).
- Ngữ cảnh: lượt API mới nhất của luồng chính: `input + cache_read + cache_write_5m + cache_write_1h`. `context_window` theo `model-window.ts`: model không
  phải id Claude (`claude-(opus|sonnet|haiku)-<số>…`) thì **không có phần trăm**; có `[1m]` hoặc ngữ cảnh lớn nhất của phiên đã vượt 200 000 thì 1 000 000;
  còn lại 200 000 với `context_window_assumed = true`. Lý do: bản ghi OTel `api_request` của Claude Code 2.1.330 mang cùng `model` (`claude-sonnet-5-5`) cho
  phiên thường và phiên `sonnet[1m]`, không có thuộc tính nào về cửa sổ (đo 23/11/2026), nên phiên 1M hiện đầy gấp năm lần cho tới khi vượt 200 000.
- `main_model`: model của lượt API mới nhất của luồng chính, không có thì `main_model` của phiên.

### 6.4 Điểm nghẽn (`ObservatoryBottleneck`)

`{rule=1, subkey=2, station=3, severity=4 ('warn'|'alert'), status=5 ('open'|'closed'), opened_at=6, updated_at=7, closed_at=8 (0 khi mở), value=9,
threshold=10, n=11, evidence_ids=12}`. Một dòng `bottlenecks` mỗi `(phiên, quy tắc, khoá con)`; mở, nâng mức, đóng đều tới thiết bị là sự kiện cùng `id`
`bottleneck:<rule>:<subkey>`, đứng ở `opened_at` trong dòng thời gian (có trong ảnh chụp và trang cũ). `evidence_ids`: tối đa 20 `id` sự kiện lấy từ khoá
`eventIds` của `evidence_json` (người ghi là bộ chạy quy tắc); chuỗi không phải `id` sự kiện bị bỏ, phần số đo khác của JSON không lên dây.

### 6.5 Nội dung theo id (`ObservatoryContent`)

Đường **duy nhất** đưa nội dung ra khỏi máy. Agent đọc DB lúc hỏi: `prompt:<id>` trả bản cắt của prompt, `tool:<id>` trả JSON `{"input","output","error",
"reason"}` đã che của lời gọi tool. `state`:

| `state` | Khi |
|---|---|
| `STORED` (1) | có nội dung, `text` là nội dung |
| `OFF` (2) | dự án của dòng tắt lưu nội dung (cùng quy tắc chặn của store `write-ops.ts`: dự án không xác định bị chặn khi có dự án nào tắt), kể cả trước khi `clearContent` xoá |
| `NONE` (3) | loại sự kiện không có nội dung, hoặc không lưu nội dung (đã xoá, chưa từng có) |
| `NOT_YET` (4) | dòng chưa có trong DB: sự kiện tạm, hoặc `id` máy không có |

`text` rỗng ở mọi trạng thái khác `STORED`.

### 6.6 Số khoan sâu (`ObservatoryStation`)

`ObservatoryStationNumbers {calls=1, failures=2, ended=3, p50_ms=4, p95_ms=5, sampled=6, api_requests=7, input_tokens=8, output_tokens=9,
cache_read_tokens=10, cache_write_tokens=11, cost_usd_estimate=12, has_cost=13, requests_without_cost=14}`; tỷ lệ lỗi là `failures / ended`.

- Mục của trạm là lời gọi tool có `station` đó (dòng lưu không có trạm tính theo trạm ước lượng). `EXTERNAL` thêm mỗi lượt API là một lời gọi (phần là model)
  và mỗi `api_error` là một lời gọi lỗi.
- Token và chi phí: `CORE` cộng lượt API của luồng chính, `ORCHESTRATOR` của subagent, `EXTERNAL` mọi lượt; trạm khác 0. `has_cost = false` thì "không có chi
  phí"; `requests_without_cost` đếm lượt thiếu ước tính (agent không tự tính).
- `parts` (`ObservatoryStationPart {kind, key, numbers}`), gọi nhiều nhất trước, tối đa 20; `kind`: `mcp_server` (MCP), `file` (`FILES`, `MEMORY`: `thư mục/tên`),
  `domain` (`EXTERNAL`), `program` (`SANDBOX`, `TESTING`, `GIT`), `tool` (trạm khác), `model` (lượt API).
- `slowest`: 5 mục chậm nhất; `recent`: 20 mục và sự kiện vòng đời của trạm mới nhất; đều là `ObservatoryEvent` không nội dung, `seq` 0.
- `previous`: tối đa 5 phiên cùng `project_key` bắt đầu trước, bỏ phiên nội bộ, mới nhất trước, chỉ `numbers` (cả phiên).
- `bottlenecks`: phát hiện của trạm trong phiên, đang mở trước, tối đa 50.
- `at` khác 0: chỉ tính dòng có thời điểm ≤ `at` (tua lại); phiên trước luôn tính cả.

### 6.7 Trạm

`station` là một trong: `CORE` (lõi AI), `FILES` (đọc, ghi, tìm tệp), `MEMORY` (ghi tệp hướng dẫn/bộ nhớ), `TESTING` (kiểm thử, lint, typecheck), `GIT` (git,
commit, push, deploy), `SANDBOX` (lệnh shell khác), `MCP`, `EXTERNAL` (web, API Anthropic), `SKILLS`, `ORCHESTRATOR` (subagent, TodoWrite, plan mode).
Nguồn: `apps/agent/src/observatory/live-map/station-map.ts`. Trạm thiết bị không biết vẽ ở `CORE`; yêu cầu khoan sâu cho trạm hợp lệ về tên nhưng không có dòng
trả số rỗng.

### 6.8 Cam kết "khung sự kiện không mang nội dung"

Mọi `ObservatoryEvent` (ảnh chụp, `ObservatoryEvents`, trang cũ, `slowest`/`recent` của khoan sâu), mọi trạng thái và mọi phát hiện chỉ mang id, nhãn đã lọc,
số, cờ, **cả đường DB lẫn đường đọc đuôi**. Nội dung chỉ đi qua `ObservatoryContentResult`. Bảo đảm bằng mã: đọc đuôi bỏ `c` trước mọi bước, `timeline-reads.ts`
bỏ `excerpt`/`content` ở cả dòng DB lẫn dòng dựng từ bản ghi tạm. Test: `live-map-link.test.ts` (dự án bật nội dung, tắt giữa phiên, nội dung đã xoá; quét mọi
khung trừ đúng một câu trả lời nội dung lúc còn bật, cả JSON lẫn byte, tìm chuỗi mẫu, định danh giả và tên khoá định danh), `live-map-hub.test.ts` (tắt mà chưa xoá
đã trả `OFF`).
