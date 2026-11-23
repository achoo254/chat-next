# Đặc tả khung Observatory (phiên bản 1)

Nguồn duy nhất cho **khung Observatory**: thiết bị (web, PWA, app) đọc dòng thời gian của một phiên Claude Code mà Observatory của agent (`tunelo`) đã lưu
trong SQLite trên máy, qua kênh E2E sẵn có (`proto/remote/v1/remote.proto`, mục "Observatory"). Agent và web viết theo file này; khi mã và file này lệch nhau
thì sửa file này cùng lúc với mã.

Có từ `AGENT_VERSION` **3.26.0** (`AGENT_OBSERVATORY` trong `apps/web/src/machines/agent-version.ts`), không đổi số giao thức. Agent cũ gặp các khung này trả
`Error` với `ERROR_REASON_UNSUPPORTED_REQUEST` như mọi khung lạ, nên web chỉ dùng tính năng khi máy đủ bản.

Mã agent: `apps/agent/src/observatory/hub/` (hub và ánh xạ ra khung), `apps/agent/src/observatory/store/timeline-reads.ts` (đọc dòng thời gian không nội
dung), `apps/agent/src/link/connection.ts` (đăng ký khung).

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

## 2. Khung (thân `Frame` số 186 đến 192)

Số đã giữ: **186–192** (lớn nhất trước đó trên `origin/main` và nhánh `feat/observatory-store` là 185, kiểm 23/11/2026). Lý do lỗi mới: **91–93**.

| Số | Thân | Chiều | Trả lời |
|---|---|---|---|
| 186 | `ObservatorySessionList {limit=1}` | A → B | `ObservatorySessionListResult` |
| 187 | `ObservatorySessionListResult {sessions=1 (ObservatorySessionInfo)}` | B → A | |
| 188 | `ObservatoryWatch {session_id=1, on=2, limit=3}` | A → B | `on`: `ObservatorySnapshot`; tắt: `Ack` |
| 189 | `ObservatorySnapshot {session_id=1, epoch=2, seq=3, session=4 (ObservatorySessionState), events=5, earlier=6}` | B → A | |
| 190 | `ObservatoryEvents {session_id=1, epoch=2, events=3}` | B → A, không hỏi | |
| 191 | `ObservatoryEarlier {session_id=1, earlier=2, limit=3}` | A → B | `ObservatoryEarlierResult` |
| 192 | `ObservatoryEarlierResult {session_id=1, events=2, earlier=3}` | B → A | |

- `ObservatorySessionList`: phiên gần đây nhất của máy, **mới nhất trước** (theo `started_at`). `limit` 0 là 50, tối đa 200. Có cả phiên nội bộ (Cố vấn,
  `internal_label` khác rỗng): thiết bị tự quyết ẩn hay hiện.
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
- `session_id` rỗng, dài quá 200 ký tự hay có ký tự điều khiển, hoặc `earlier` không do máy này tạo: `Error` (`ERROR_CODE_INVALID`,
  `ERROR_REASON_OBSERVATORY_INVALID`).
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

`ObservatorySessionState {info=1 (ObservatorySessionInfo), totals=2 (ObservatorySessionTotals)}`.

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

`ObservatoryEvent {seq=1, at=2, id=3, oneof kind}`:

| Số | `kind` | `id` | Trường |
|---|---|---|---|
| 4 | `prompt` | `prompt:<prompt_id>` | `prompt_id`, `length` (độ dài, đơn vị UTF-16). **Không bao giờ chữ của prompt** |
| 5 | `tool_call` | `tool:<tool_use_id>` | `tool_use_id`, `prompt_id`, `agent_id` (rỗng: agent chính), `tool_name`, `mcp_server`, `target` (nhãn bộ lọc riêng tư giữ: tệp dạng `thư mục/tên`, tên miền, chương trình của lệnh, `server › tool`), `duration_ms`, `input_bytes`, `output_bytes`, `success` (không đặt khi chưa xong), `error` (mã cố định `failed`, `interrupted`, `permission denied`), `station`, `station_flags`, `target_key` (khoá có muối của tệp), `read_offset`, `read_limit` |
| 6 | `subagent` | `subagent:<agent_id>` | `agent_id`, `prompt_id`, `agent_type`, `started_at`, `ended_at` (0 khi đang chạy), `model`, `total_tokens`, `tool_count` |
| 7 | `api_request` | `api:<khoá chống trùng>` | `prompt_id`, `agent_id`, `model`, token theo loại, `cost_usd_estimate` (không đặt khi Claude Code không báo), `duration_ms`, `ttft_ms`, `query_source` |
| 8 | `instruction_loaded` | `instruction:<số>:<lý do>:<tệp>` | `file_path` (thư mục nhà là `~`), `memory_type`, `load_reason`, `load_seq` |
| 9 | `git_op` | `git:<số dòng>` | `prompt_id`, `sha`, `branch`, `kind` |
| 10 | `session_event` | `event:<khoá chống trùng>` | `kind`, `agent_id`, `tool_use_id`, `station`, `label`, `number`, `flag` |
| 11 | `session` | `session` | `ObservatorySessionState` mới (chỉ trong `ObservatoryEvents`, sau các sự kiện cùng khung, chỉ khi dòng phiên hay số tổng đổi) |

- Trường số kiểu `optional` không đặt nghĩa là DB không có giá trị (khác 0).
- `station` là trạm Live Map (`CORE`, `FILES`, `MEMORY`, `TESTING`, `GIT`, `SANDBOX`, `MCP`, `EXTERNAL`, `SKILLS`, `ORCHESTRATOR`); `station_flags` là các bit
  `commit` 1, `push` 2, `deploy` 4, `write` 8, `memory` 16, `estimated` 32 (đặt theo nhãn đã lọc, có thể sai). Nguồn: `apps/agent/src/observatory/live-map/station-map.ts`.
- `session_event.kind`: `permission_request`, `permission_decision`, `permission_denied`, `hook_block`, `compact_start`, `compact_end`, `stop`, `stop_failure`,
  `notification`, `model_change`, `permission_mode`, `todo_counts`, `api_error`, `mcp_connection` (`SESSION_EVENT_KINDS` trong
  `apps/agent/src/observatory/store/observatory-rows.ts`). Loại lạ: thiết bị bỏ qua.
- Một dòng được ghi lại y hệt (đọc lại spool, nguồn thứ hai) không gửi sự kiện mới. Agent nhớ bản gửi cuối của 2 000 dòng gần nhất mỗi phiên; dòng cũ hơn ghi lại
  thì gửi lại cùng `id`, vô hại.

### Vòng đời

- Hub tạo cùng dịch vụ Observatory (`observatory-service.ts`) và chạy theo nó: `start` đặt epoch mới; `stop` (đầu tiên trong thứ tự dừng, trong cùng 5 giây chờ)
  bỏ phần chờ gửi và từ chối yêu cầu cho tới lần `start` sau; xoá dữ liệu (`wipe`) đặt epoch mới. Lượt xem vẫn giữ qua `stop`/`start`: thiết bị nhận khung có
  epoch mới và xem lại.
- Nguồn sự kiện là DB: mỗi lô ghi vào store báo hub các dòng vừa chạm; dòng của phiên đang xem được đọc lại đúng như đã lưu (đã gộp) rồi gửi. Phiên không ai xem:
  hub không đọc gì, không giữ gì.
- Người xem đầu tiên của một phiên bật đọc đuôi spool cho phiên đó (`watchSession`), người cuối rời thì tắt (`unwatchSession`). Giai đoạn này chỉ bật/tắt; sự
  kiện tạm từ đuôi spool chưa lên dây (giai đoạn Live Map thêm).
- Spool của phiên terminal và CLI được nạp chậm 5–75 giây, nên sự kiện của các phiên đó tới thiết bị chậm tương ứng.

## 4. Cam kết dữ liệu không rời máy

Không khung Observatory nào chứa: chữ của prompt, input hay output của tool, nội dung tin nhắn, lỗi dạng chữ tự do, nội dung tệp, đường dẫn đầy đủ dưới thư mục nhà
(luôn là `~`), hay **bất kỳ định danh tài khoản nào** (email, mã tài khoản, `organization.id`, tên người dùng của hệ điều hành). Chỉ đi ra: id, nhãn bộ lọc riêng
tư đã giữ, số, cờ. Nội dung đã lưu (bản cắt ngắn khi dự án bật lưu nội dung) **ở lại DB**; xin nội dung theo id là việc của giai đoạn sau.

Bảo đảm bằng mã: `timeline-reads.ts` bỏ `prompts.excerpt` và `tool_calls.content` ngay lúc đọc, `hub/observatory-wire.ts` chép từng trường theo tên (cột mới của
bảng không tự lên dây). Test `apps/agent/test/observatory/observatory-link.test.ts` bật lưu nội dung (mặc định), bơm chuỗi đánh dấu vào prompt, lệnh và output
cùng các định danh giả của `observatory-payloads.ts`, xác nhận bản xuất DB có chuỗi đánh dấu, rồi quét mọi khung hai thiết bị nhận (JSON và byte protobuf) để
khẳng định không có chuỗi đánh dấu, định danh hay tên khoá định danh nào; `observatory-hub.test.ts` làm tương tự với ảnh chụp, sự kiện và trang cũ.

## 5. Giới hạn

- Ảnh chụp và trang cũ tối đa 500 sự kiện (mặc định 200). Danh sách phiên tối đa 200 (mặc định 50).
- 4 phiên mỗi kết nối, 16 phiên cho cả máy, 8 kết nối mỗi phiên.
- Gom sự kiện 250 ms; `session` chỉ gửi khi đổi.
- Không có bảng điểm nghẽn (`bottlenecks`) và sự kiện tạm từ đuôi spool trên dây; giai đoạn Live Map thêm khung, không đổi các số trên.
