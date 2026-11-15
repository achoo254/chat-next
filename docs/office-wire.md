# Đặc tả khung Văn phòng (phiên bản 1)

Nguồn duy nhất cho **khung Văn phòng**: thiết bị (web, PWA, app) xem một phiên AI dưới dạng một toà nhà văn phòng nhỏ, agent (`tunelo`) chuẩn hoá hoạt động của
phiên trên máy rồi gửi qua kênh E2E sẵn có (`proto/remote/v1/remote.proto`, mục "the office of a session"). Agent và web viết theo file này; khi mã và file này lệch
nhau thì sửa file này cùng lúc với mã.

Có từ `AGENT_VERSION` **3.6.0**, không đổi số giao thức. Agent cũ gặp `OfficeWatch` trả `Error` với `ERROR_REASON_UNSUPPORTED_REQUEST` như mọi khung lạ, nên web
cổng tab Văn phòng theo phiên bản agent và không gửi khung cho máy cũ.

## 1. Khái niệm

- **Văn phòng**: trạng thái của MỘT luồng (thread) trên máy. Agent chính là **Giám đốc** (`OFFICE_ROLE_DIRECTOR`, id `director`, luôn có); mỗi subagent là một
  **nhân viên** (`OFFICE_ROLE_EMPLOYEE`, id là id của lời gọi tool đã tạo nó); mỗi lệnh shell hay Monitor chạy nền là một **máy** (`OFFICE_ROLE_MACHINE`, id là
  id của lời gọi tool). Người dùng (Chủ tịch) không phải actor: web vẽ Chủ tịch khi `OfficeSession.waiting_for_user` bật.
- **Hoạt động** (`OfficeActivity`): việc một actor đang làm, kèm **nhóm hoạt ảnh** (`OfficeAnimGroup`) và **phòng** (`OfficeRoom`) mà agent đã chọn trên máy.
  Mỗi actor hiện tối đa MỘT hoạt động; id hoạt động là id lời gọi tool, hoặc id cố định `think`, `arrive`, `hand-in`.
- **`epoch`**: epoch của core agent (như `Cursor.epoch`), đổi mỗi lần agent khởi động lại.
- **`seq`**: số thứ tự sự kiện của văn phòng một luồng trong một epoch, tăng đúng 1 mỗi sự kiện, bắt đầu từ 1. Agent giữ văn phòng của một luồng chỉ khi có ít nhất
  một kết nối đang xem; không còn ai xem thì văn phòng bị huỷ, lần xem sau dựng lại từ đầu (seq lại từ 1) nên thiết bị luôn bắt đầu bằng ảnh chụp.
- Thời gian là Unix mili giây theo đồng hồ của máy.

## 2. Khung (thân `Frame` số 168 đến 170)

| Số | Thân | Chiều | Trả lời |
|---|---|---|---|
| 168 | `OfficeWatch {thread_id=1, on=2}` | A → B | `on`: `OfficeSnapshot`; tắt: `Ack`. Luồng lạ: `Error` `THREAD_NOT_FOUND` |
| 169 | `OfficeSnapshot {thread_id=1, epoch=2, seq=3, state=4 (OfficeState)}` | B → A | |
| 170 | `OfficeEvents {thread_id=1, epoch=2, events=3 (OfficeEvent)}` | B → A, không hỏi | |

- Xem được nhiều luồng cùng lúc trên một kết nối; mỗi kết nối chỉ nhận `OfficeEvents` của luồng nó đang xem. Đóng kết nối là tắt mọi lượt xem của nó.
- `OfficeWatch{on}` lần nữa cho luồng đang xem là **xin ảnh chụp mới** (dùng khi hở `seq` hay nối lại). Không có khung xin ảnh chụp riêng.
- `OfficeSnapshot.seq` là sự kiện cuối đã gộp vào ảnh chụp (0 khi chưa có sự kiện nào); `OfficeEvents` sau đó của cùng epoch bắt đầu từ `seq + 1`.
- Sự kiện được gom tối đa 250 ms một khung. Không gửi khung rỗng.
- Kết nối đang nghẽn (socket còn trên 1 MiB chưa gửi) thì khung sự kiện của nó bị bỏ, không giữ lại: thiết bị sẽ thấy hở `seq` và xin ảnh chụp mới.

### Quy tắc phía thiết bị

1. Bỏ mọi khung có `epoch` khác epoch của ảnh chụp đang giữ; epoch mới hơn thì xem lại (`OfficeWatch{on}`).
2. Sự kiện có `seq` ≤ seq đã áp: bỏ (trùng hoặc cũ).
3. Sự kiện có `seq` > seq đã áp + 1: **hở** → xem lại để lấy ảnh chụp mới, bỏ các sự kiện tới trước khi ảnh chụp về.
4. Ảnh chụp thay toàn bộ trạng thái. Ảnh chụp cộng các sự kiện sau nó cho ra đúng một trạng thái, không phụ thuộc giờ máy xem (phát lại được).
5. Mất kết nối với máy quá 30 giây là "mất điện" (web tự quyết theo nhịp `Ping` sẵn có; không có khung nhịp tim riêng). Nối lại thì xem lại.

## 3. Trạng thái (`OfficeState`) và sự kiện (`OfficeEvent`)

`OfficeState {actors=1, reports_staff=2, session=3 (OfficeSession)}`. `actors`: Giám đốc trước, rồi theo thứ tự vào. Tối đa 64 actor; actor vượt quá không được
gửi, chỉ đếm ở `OfficeSession.hidden_actors`. `reports_staff`: AI có báo subagent (Claude: có; Antigravity: không, web hiện "AI này chưa báo cáo nhân viên" thay vì
văn phòng trống; agent suy ra từ việc adapter có `SessionHistory.subagentActivity`).

`OfficeSession {busy=1, waiting_for_user=2, started_at=3, tasks_done=4, background_machines=5, todo=6, usage=7, checks=8, hidden_actors=9}`:

| Trường | Ý nghĩa |
|---|---|
| `busy` | Có một lượt đang chạy, trên máy (`ThreadSummary.state` RUNNING, WAITING, QUEUED) hay nơi khác (`busy_elsewhere`) |
| `waiting_for_user` | AI chờ người dùng: duyệt quyền, câu hỏi, bí mật đăng nhập (`ThreadSummary.state` WAITING, hoặc `pending` > 0 khi chạy nơi khác) |
| `started_at` | Lúc lượt đầu tiên agent thấy bắt đầu (từ nhật ký của luồng khi dựng văn phòng); 0 trước đó |
| `tasks_done` | Số subagent đã nộp hồ sơ cộng số mục todo đã xong (bảng tường ở Sảnh) |
| `background_machines` | `ThreadSummary.background_tasks` (shell và subagent chạy nền chưa báo xong) |
| `todo` | `OfficeTodoCounts {pending=1, in_progress=2, done=3}`: CHỈ SỐ, không bao giờ chữ của mục |
| `usage` | `OfficeUsage {input_tokens=1, output_tokens=2, cost_usd_estimate=3, has_cost=4, available=5}`, xem mục 6 |
| `checks` | `OfficeChecks {passed=1, failed=2, last_ok=3}`: hoạt động ở phòng `QA` đã kết thúc (qua/trượt theo `ok` của tool) |
| `hidden_actors` | Actor vượt giới hạn 64 |

`OfficeActor {id=1, role=2, agent_type=3, description=4, parent_id=5, spawn_depth=6, state=7, activity=8, entered_at=9, done_at=10}`:

- `agent_type`: loại agent như AI gọi (`code-reviewer`, `general-purpose`), cắt 60 ký tự; với máy là tên tool (`Bash`, `Monitor`); rỗng với Giám đốc hoặc khi
  không biết (web dùng loại "lạ").
- `description`: mô tả ngắn của subagent cấp 1 (chính dòng thẻ subagent trong chat đã hiện), cắt 80 ký tự. Rỗng với subagent lồng (chat không hiện mô tả đó) và máy.
- `parent_id`: id actor đã tạo actor này (subagent do subagent khác tạo); `workflow:<id>` cho agent thuộc một workflow (không phải actor nào); rỗng khi Giám
  đốc tạo. `spawn_depth`: 1 cho subagent của Giám đốc, từ 2 cho subagent lồng; 0 cho Giám đốc và máy. Web đặt actor có `spawn_depth` > 1 hoặc `parent_id` khác
  rỗng vào Phòng họp.
- `state` (`OfficeActorState`): `IDLE` (Giám đốc lúc phiên rảnh), `WORKING`, `DONE` (nhân viên đã xong, ở lại tới khi phiên rảnh quá 10 phút thì `actor_leave`),
  `AWAITING_APPROVAL` (có tool đang chờ duyệt). Máy không bao giờ `DONE`: máy xong là `actor_leave` ngay.

`OfficeActivity {id=1, tool=2, group=3, room=4, subject=5, started_at=6}`; `subject` theo mục 5, chỉ cho tool của Giám đốc.

`OfficeEvent {seq=1, at=2, oneof kind}`:

| Số | Sự kiện | Áp vào trạng thái |
|---|---|---|
| 3 | `actor_enter (OfficeActor)` | Thêm actor (đủ trường) |
| 4 | `actor_update (OfficeActor)` | Thay toàn bộ actor cùng id (kể cả `activity`) |
| 5 | `actor_leave {actor_id=1}` | Bỏ actor |
| 6 | `activity_start {actor_id=1, activity=2}` | `activity` của actor là hoạt động này (thay hoạt động đang hiện) |
| 7 | `activity_end {actor_id=1, activity_id=2, ok=3}` | Xoá `activity` của actor CHỈ KHI `activity.id == activity_id`; web có thể diễn qua/trượt theo `ok` |
| 8 | `turn_start {}` | Lượt mới bắt đầu (cạnh rảnh → bận): Sảnh có khách |
| 9 | `approval {actor_id=1, state=2}` | `WAITING`: actor thành `AWAITING_APPROVAL`; `ALLOWED`/`DENIED`/`CANCELLED`: actor về trạng thái trước đó (web diễn `DENIED` là bị chặn ở cửa Bảo vệ) |
| 10 | `session (OfficeSession)` | Thay toàn bộ `OfficeState.session`; chỉ gửi khi một số đổi |

Hoạt động song song của một actor (Claude gọi nhiều tool cùng lúc): hoạt động mới nhất được hiện; khi nó kết thúc mà còn hoạt động khác đang mở, agent gửi
`activity_end` rồi `activity_start` cho hoạt động mở gần nhất (giữ `started_at` cũ).

### Vòng đời

- **Giám đốc**: `WORKING` khi phiên bận, `IDLE` khi rảnh. Bận mà không có tool nào mở thì hoạt động là `think` (`THINK`, `DIRECTOR`).
- **Nhân viên**: vào với hoạt động `arrive` (`ARRIVE`, `LOBBY`); mỗi tool bên trong subagent là một hoạt động (chỉ tên tool, nhóm và phòng; không chủ đề). Xong thì
  `actor_update` với `state` `DONE`, `done_at`, hoạt động `hand-in` (`HAND_IN`, `DIRECTOR`): web cho người đi nộp hồ sơ rồi về bàn. Subagent chạy nền
  (`run_in_background`) xong khi AI báo tác vụ nền kết thúc, không phải khi lời gọi tool trả về (lời gọi đó trả về ngay lúc khởi chạy).
- **Máy**: vào khi một lệnh shell có `run_in_background` hoặc một `Monitor` bắt đầu, hoạt động `MACHINE` ở phòng theo tiền tố lệnh (mục 4); rời khi AI báo
  tác vụ nền kết thúc, hoặc khi `background_tasks` về 0 (rời hết), hoặc giảm thấp hơn số máy đang có (máy cũ nhất rời trước).
- **Phiên hết bận**: mọi hoạt động còn mở được đóng (`activity_end`, `ok = true`, không tính vào `checks`); nhân viên đang làm chuyển `DONE`, trừ subagent chạy nền
  khi `background_tasks` > 0.
- **Duyệt quyền**: mục duyệt mới là `WAITING`, gắn vào actor có hoạt động mang đúng id tool cần duyệt (kể cả tool bên trong subagent), không khớp thì gắn Giám
  đốc; trả lời cho `ALLOWED` hoặc `DENIED`, huỷ hoặc hết hạn cho `CANCELLED`. Câu hỏi (`AskUserQuestion`) chỉ bật `waiting_for_user`, không phải duyệt.

## 4. Phân phòng (agent, trên máy)

Hàm thuần `classifyActivity` (`apps/agent/src/office/office-activity-map.ts`). Agent không gửi `PANTRY` (lớp diễn lúc rảnh do web chọn) và không áp phòng gốc
theo loại agent (web áp, chỉ thay `WORK`). Web đọc phòng lạ hoặc `UNSPECIFIED` là `WORK`.

| Loại tool (`ToolKind`) | Ví dụ (Claude / Antigravity) | Nhóm | Phòng |
|---|---|---|---|
| `read` | Read, NotebookRead | `READ` | `LIBRARY` |
| `search` | Grep, Glob, LS, LSP, ToolSearch | `READ` | `LIBRARY` |
| `web` | WebFetch, WebSearch; `fetch`, `search_web` | `PHONE` | `LIBRARY` |
| `edit` | Write, Edit, MultiEdit, NotebookEdit | `TYPE` | `WORK` |
| `todo` | TodoWrite | `TYPE` | `PLANNING` |
| `mcp` | `mcp__<server>__<tool>`; tên có `__` | `TYPE` | `POST`; riêng tiền tố `mcp__tunelo__` (MCP của chính tunelo, gửi tin cho người dùng) là `LOBBY` |
| `shell` | Bash, PowerShell, BashOutput, KillShell, Monitor; `execute`, `run_command` | `MACHINE` | theo lệnh, bảng dưới |
| `subagent` | Agent, Task (tạo nhân viên) | `ARRIVE` | `LOBBY` |
| `other` và tool lạ | Skill, ExitPlanMode, … | `TYPE` | `WORK` |
| (subagent xong) | | `HAND_IN` | `DIRECTOR` |
| (suy nghĩ, viết trả lời) | | `THINK` | `DIRECTOR` |

**Lệnh shell** (`classifyCommand`): chỉ đọc trên máy, chuỗi lệnh không đi vào trường nào của khung.

1. Lệnh ghép (`&&`, `||`, `;`, `|`, xuống dòng): lấy lệnh đầu.
2. Bỏ các từ đứng trước: gán biến môi trường (`FOO=1`), `sudo`, `env`, `time`, `npx`, `bunx`, `pnpx`; với `pnpm`/`npm`/`yarn`/`bun` thì bỏ thêm `run`/`exec`/`x`
   và các cờ (`--filter x`, `-C dir`, …). Từ đầu còn lại so theo tên tệp, chữ thường, bỏ `.exe`/`.cmd`.
3. Theo thứ tự:

| Điều kiện | Phòng |
|---|---|
| Từ đầu là `git`, `gh`, `rsync`, `scp`; hoặc một từ của lệnh có chữ `deploy` | `POST` |
| Từ đầu là `vitest`, `jest`, `pytest`, `eslint`, `tsc`; hoặc `go test`, `cargo test`; hoặc tên script sau trình quản lý gói bắt đầu bằng `test`, `lint`, `typecheck`, `tsc`, `vitest`, `jest`, `eslint` (`pnpm test`, `pnpm run lint:fix`, `npm run typecheck`) | `QA` |
| Còn lại (kể cả lệnh rỗng, lệnh lạ) | `SERVER` |

Tool bên trong subagent được phân phòng giống hệt (lệnh shell của subagent cũng chỉ đọc trên máy).

## 5. Chủ đề rút gọn (`OfficeActivity.subject`)

Chỉ cho tool của Giám đốc; tool bên trong subagent, máy, `think`, `arrive`, `hand-in` luôn rỗng. Tối đa 40 ký tự (cắt, thêm `…`), bỏ ký tự điều khiển.

| Loại | Chủ đề |
|---|---|
| `read`, `edit` | Tên tệp, không thư mục (`agent-core.ts`) |
| `shell` | Từ đầu của lệnh sau khi bỏ biến môi trường và `sudo` (`pnpm`, `git`) |
| `search` | Rỗng |
| `web` | Tên miền của URL (`docs.example.com`); câu tìm kiếm thì rỗng |
| `mcp` | Tên tool sau `mcp__<server>__` |
| Khác | Rỗng |

Lời gọi tool mà core đánh dấu nhạy cảm (`mentionsSensitive`, cờ `sensitive` của thẻ tool) thì chủ đề rỗng, bất kể loại.

## 6. Token và chi phí (`OfficeUsage`)

- Lượt do máy chạy: cộng `input_tokens`, `output_tokens`, `cost_usd_estimate` của các `TurnItem` đã kết thúc trong nhật ký luồng (phần của lượt mà core đã tính;
  token là của cuộc hội thoại chính, chi phí gồm cả subagent).
- Lượt chạy nơi khác (Claude): cộng token từ transcript của phiên và của các subagent (`input_tokens`, `output_tokens` của từng lần gọi API, bỏ trùng theo id tin
  và id request), CHỈ cho các lần gọi nằm ngoài khoảng thời gian của các lượt do máy chạy, để không đếm hai lần. Transcript không có chi phí.
- `has_cost`: có ít nhất một lượt do máy chạy báo chi phí khác 0 (Antigravity luôn báo 0 nên luôn `false`: web chỉ hiện token).
- `available`: agent có số nào cho phiên này chưa (có lượt kết thúc hoặc có lần gọi đọc được). `false` thì web hiện "chưa có số liệu", không hiện số 0.

## 7. Tín hiệu theo loại phiên

| Tín hiệu | Claude do máy chạy | Claude chạy nơi khác (terminal, IDE) | Antigravity |
|---|---|---|---|
| Giám đốc, tool của Giám đốc, chủ đề | Có (trực tiếp) | Có (đọc transcript mỗi 1,5 giây khi có thiết bị xem) | Có |
| Nhân viên, loại agent | Có (luồng SDK, kể cả subagent chạy nền) | Có (`subagents/agent-*.meta.json`) | Không (`reports_staff = false`) |
| Tool bên trong subagent | Có (luồng SDK) | Có (đuôi `subagents/agent-*.jsonl`, chỉ tên tool) | Không |
| Máy (shell nền) | Có (lời gọi tool + báo kết thúc tác vụ nền của SDK) | Có (lời gọi tool trong transcript); rời theo `background_tasks` | Không |
| Duyệt quyền gắn đúng người, từ chối | Có | Không: chỉ có số chờ (bí mật đăng nhập); Giám đốc đứng thay, không có `DENIED` | Có |
| Todo | Có | Có | Có khi AI gửi |
| Token / chi phí | Có / Có | Có / Không | Có / Không |
| Qua/trượt kiểm thử | Có | Có (kết quả tool đọc lại từ transcript) | Có |

Văn phòng dựng khi thiết bị bắt đầu xem, từ nhật ký của luồng (tool, kết quả, subagent, todo, duyệt, lượt): nhân viên đã xong trong 10 phút rảnh gần nhất vẫn có
mặt. Phiên chạy nơi khác đang giữa chừng khi bắt đầu xem chỉ có những gì nhật ký đã đọc vào; phần còn lại tới theo nhịp đọc transcript.

## 8. Cam kết dữ liệu không rời máy

Không khung văn phòng nào chứa: input của tool (lệnh đầy đủ, nội dung tệp, câu tìm kiếm, câu hỏi, URL đầy đủ), output của tool, chữ của todo, nội dung tin
nhắn hay suy nghĩ của AI, đường dẫn thư mục. Chỉ đi ra: tên tool, nhóm hoạt ảnh, mã phòng, chủ đề rút gọn theo mục 5, loại agent và mô tả ngắn của subagent cấp 1
(vốn đã hiện trong chat), các số đếm, token và chi phí. Test `apps/agent/test/office-connection.test.ts` bơm chuỗi đánh dấu vào lệnh, todo, input, output và
quét mọi khung văn phòng đã mã hoá để khẳng định chuỗi đó không có mặt.

## 9. Giới hạn

- 64 actor mỗi văn phòng (Giám đốc luôn có chỗ); dư thì đếm ở `hidden_actors`.
- Gom sự kiện 250 ms; `session` chỉ gửi khi một số đổi.
- Transcript của subagent chỉ đọc phần mới từ vị trí đã nhớ; lần đầu đọc tối đa 4 MiB cuối của mỗi tệp. Định dạng `subagents/` của Claude Code không có tài liệu
  chính thức: agent đọc phòng thủ (thiếu trường thì bỏ qua hoặc loại "lạ"), lỗi đọc chỉ ảnh hưởng văn phòng.
