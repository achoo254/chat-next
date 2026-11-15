# Chat chỉ hiện cuộc trò chuyện sau /clear, và Terminal mode không mở tiến trình thứ hai

Repo `chat-next`, nhánh main. Không commit, không stage, không push, không deploy. Cỡ: M (agent, web, gói giao thức dùng chung, docs).

> Cập nhật sau review: mục ngắt **không còn** là loại mục proto riêng. Nó là một `StatusItem` rỗng với id có tiền tố dành riêng; proto và mã sinh giống hệt `HEAD`. Các mục "Giao thức" và "Mục ngắt" dưới đây mô tả lần làm đầu; trạng thái hiện tại nằm ở mục "Sửa theo review" cuối báo cáo.

## Kết quả

1. Khi CLI trong terminal của phiên chạy `/clear` (hoặc `/resume` sang cuộc khác), agent ghi một mục ngắt vào nhật ký trước mọi mục của cuộc trò chuyện mới. Web chỉ hiện cuộc trò chuyện từ mục ngắt mới nhất trở đi; phần trước nằm sau một dòng gập "Cuộc trò chuyện trước (n tin nhắn)", bấm thì mở ra ngay tại chỗ, bấm lần nữa thì gập lại. Nhật ký vẫn giữ nguyên mọi mục cũ.
2. Terminal mode từ chối mở `claude --resume` khi một tiến trình claude khác trên máy đang mở phiên đó, kể cả khi rảnh (ví dụ cửa sổ terminal riêng của chủ máy). Lỗi là `SESSION_OPEN_ELSEWHERE` (subject là thư mục). Web nói: "Phiên này đang mở trong một cửa sổ khác trên máy. Dùng tab Trò chuyện, hoặc đóng cửa sổ đó trước." (có bản en và zh-CN). Gắn lại terminal đang chạy của chính luồng vẫn chạy như cũ, vì `openAi` trả phiên đang chạy mà không gọi `launch` (đã đọc lại `terminal-service.ts:319-343`).
3. Mọi cổng kiểm tra đều xanh, trừ các test hỏng sẵn trên Windows. Tập test hỏng đó giống hệt trước và sau thay đổi (bảng ở dưới).

## Giao thức (lần làm đầu, đã thay; xem "Sửa theo review")

- `Item.conversation_break = 24` (`ConversationBreakItem {}`), có chú thích trong `proto/remote/v1/remote.proto`.
- Đã sinh lại mã bằng `pnpm proto:gen` cho TS (`packages/proto-ts`) và Go (`server/gen`).
- Go: `GOOS=linux go build ./...` exit 0 và `go vet ./gen/...` exit 0. Build gốc trên Windows hỏng ở hai gói không liên quan (`internal/media`, `internal/store/testdb`), vì chúng dùng `syscall.Statfs`/`Flock` chỉ có trên Unix.
- Thiết bị và web cũ không vỡ: protobuf bỏ qua trường lạ, nên thân mục là `undefined`. `foldTranscript` vẽ không có khối nào cho thân lạ; có test cho cả hai trường hợp. Web cũ vẫn hiện mọi thứ như trước, chỉ không gập.

## Agent

**Mục ngắt** (`core/agent-core.ts`)
- `followTerminal` gọi `breakConversation` khi luồng chuyển sang một đoạn mới. Đoạn mới chỉ được tạo khi phiên cũ đã có transcript; trường hợp thay phiên khởi động chưa từng ghi gì thì không có mục ngắt.
- Không ghi mục ngắt khi nhật ký chưa có nội dung.
- Id là `break:<số thứ tự đoạn>:<id phiên>`. `followTerminal` chỉ chuyển một lần cho mỗi đoạn, nên mục ngắt không bao giờ ghi trùng, kể cả khi đồng bộ lại. Đổi AI giữa luồng (~dòng 1627) không đụng tới.
- Mục ngắt được báo tới thiết bị qua `listeners` như mọi mục khác.

**Chia theo `seq`, không theo thời gian**
- Web xếp mục theo `at`. Mục đọc từ transcript mang giờ gốc của transcript, nên một cuộc trò chuyện cũ được `/resume` sẽ nằm trước mục ngắt nếu chia theo thời gian. Vì vậy thiết bị chia theo `seq`: mục nào có `seq` lớn hơn mục ngắt mới nhất thì thuộc cuộc trò chuyện hiện tại.
- `importHistory` chỉ coi là "đã có" những mục ghi sau mục ngắt mới nhất. Việc bỏ trùng theo nội dung cũng chỉ xét phần đó.
  - Quay lại một cuộc trò chuyện đã hiện thì các mục của nó được ghi lại thành revision mới sau mục ngắt, nên chat hiện lại cuộc đó.
  - Một câu giống hệt câu của cuộc trước (ví dụ "build it") không còn bị bỏ nhầm.
  - Luồng không có mục ngắt chạy y như cũ.

**Chặn tiến trình thứ hai** (`terminalLaunch`)
- Sau `await this.park(t)`, `refuseOpenInOtherProcess` hỏi `history.openInOtherProcess(sessionId, except)`. Đây là phương thức tùy chọn mới của `SessionHistory`. Bản Claude của nó nằm trong `providers/claude/local-sessions.ts`.
- Bản Claude chỉ tin hai nguồn: sổ đăng ký `<thư mục Claude>/sessions/<pid>.json` của tiến trình còn sống, và id phiên trên dòng lệnh (`--resume`, `--session-id`) của tiến trình không có bản ghi.
- `except` là CLI của chính terminal luồng. Nó được nhận ra theo thư mục và lúc khởi động (±10 giây), giống cách `terminalHeldSession` theo dõi `/clear`. Lấy từ `meta.terminal.startedAt`; nếu terminal vừa kết thúc thì lấy từ `Thread.lastTerminalStart` (giữ trong bộ nhớ). Vì vậy CLI đang thoát sau "Kết thúc", hay lúc thay tiến trình terminal, không bị tính là tiến trình khác.
- Nếu `park` vừa đóng phiên chat của máy, agent chờ tối đa 3 giây (mỗi 250 ms nhìn lại một lần) cho tiến trình đó thoát. `q.close()` của SDK không chờ tiến trình thoát hẳn.
- Sau bước kiểm tra, nếu trong lúc chờ một thiết bị khác đã mở lại phiên chat hay xếp một lượt, agent trả `THREAD_RUNNING`. Web coi lỗi này là "chờ lượt xong rồi mở".
- Những trường hợp không bị chặn: bản ghi của pid đã chết, cuộc trò chuyện khác mở trong cùng thư mục, luồng mới chưa có phiên (không hỏi gì), và AI không có phương thức này (Antigravity).

**Lệch so với gợi ý của brief (cố ý)**: tôi không dùng `liveness().held`, vì hai lý do.
- `held` gộp cả cách đoán theo thư mục và giờ sửa transcript (`heldSessions`). Một claude khác của chủ máy mở cuộc khác trong cùng thư mục dự án có thể bị đoán là đang giữ phiên của luồng, nên Terminal mode bị chặn nhầm.
- `held` không loại được CLI của chính luồng. `terminal-staged-replace.test.ts` cho thấy rõ điều này: phần lịch sử giả của nó báo `held: true` cho CLI của chính luồng, nên dùng `held` sẽ làm hỏng luồng thay tiến trình terminal.

**Nhật ký** (`threads/journal.ts`)
- `load()` dùng `ignoreUnknownFields: true`. Trước đây, khi đọc một dòng có loại mục do bản agent mới hơn ghi, `fromJsonString` ném lỗi, và vòng nạp cắt mất dòng đó cùng mọi dòng sau.
- Từ bản này trở đi, mục lạ được giữ (thân rỗng) thay vì bị cắt. Không chữa được trường hợp hạ về bản trước bản này (xem câu hỏi 2).

## Web

- `machines/transcript/conversation-break.ts` (mới) có hai hàm:
  - `splitConversations`: chia nhật ký theo `seq` của mục ngắt mới nhất và bỏ chính các mục ngắt.
  - `messageCount`: đếm tin của người dùng và của AI, không đếm phần suy nghĩ.
- `session-chat.tsx`:
  - Chỉ fold cuộc trò chuyện hiện tại. Thẻ chờ duyệt chỉ lấy từ cuộc này. Thanh trạng thái tính phần context đã dùng (`contextShare`) theo cuộc hiện tại.
  - `Transcript` nhận `previous`, có thể không truyền, nên test cũ không phải sửa. Dòng `PreviousRow` là một nút có `aria-expanded`, nằm chỗ cuộc hiện tại bắt đầu.
  - Khi mở, trang cuối của cuộc trước hiện phía trên dòng, đọc xuôi xuống cuộc hiện tại, và dùng chung cơ chế phân trang "Xem n mục trước".
  - Khi gập, cửa sổ giữ nguyên chỗ đang đọc trong cuộc hiện tại.
- `machines.css`: thêm `.mx-previous`, chỉ dùng token sẵn có của dự án (`--space-2`, `--c-text-muted`, `--c-border-subtle`, `--c-primary`, `--radius-sm`). Không có giá trị mới. Nút cao 44 px. Mũi tên xoay khi mở, cùng cách các `details` khác trong file.
- `terminal/terminal-dock.tsx`: `openErrorText` đổi `SESSION_OPEN_ELSEWHERE` sang câu riêng của terminal.
- Copy: thêm cùng lúc vào vi, en, zh-CN hai khóa `transcript.previous(n)` và `terminal.failed.openElsewhere`.
  - Bản en nói "Conversation tab", bản zh nói "聊天标签页", khớp nhãn công tắc hiện có.
  - check-brand không gặp chữ "Chat".

## Tài liệu

`docs/terminal-wire.md`, mục "Phiên AI trong terminal":
- Dòng "Từ chối" nêu thêm nghĩa mới của `SESSION_OPEN_ELSEWHERE`.
- Thêm một gạch đầu dòng về luật không có hai tiến trình cùng ghi một phiên, gồm những gì không bị tính.
- Thêm một gạch đầu dòng về `conversation_break`: id, chia theo `seq`, quay lại bằng `/resume`, và thiết bị cũ.

## Kiểm tra (lần làm đầu)

| Cổng | Kết quả |
|---|---|
| Agent vitest, toàn bộ (`--maxWorkers=2`), lần cuối | 101 file: 72 pass, 24 fail, 5 skip. Test: 870 pass, 69 fail, 52 skip. 5 lỗi ngoài test (đều là `listen EACCES ... control.sock`). |
| Đường cơ sở agent (stash riêng phần agent của tôi, chạy lại đúng 24 file hỏng) | 24 file fail. Test: 69 fail, 276 pass, 1 skip. Tập 69 test hỏng **giống hệt** sau thay đổi (so bằng `diff`). Đã `stash pop` và kiểm lại. |
| `terminal-ai-session.test.ts`, trước và sau | Đều 4 fail, 3 pass, cùng 4 tên: "the device names only the thread…", "a new session starts with an id…", "ending the terminal (TermClose)…", "refuses an unknown thread…". Nguyên nhân là môi trường Windows (Unix socket, `/bin/sh`), không phải hồi quy. |
| Web vitest, toàn bộ (`--maxWorkers=2`) | 120 file: 119 pass, 1 skip. Test: 1230 pass, 3 skip, 0 fail. |
| Typecheck `tsc --noEmit`, agent và web | 0 lỗi mỗi bên (exit 0). |
| `pnpm lint` | eslint `--max-warnings=0`: 0 lỗi, 0 cảnh báo. check-brand: "no hard-coded Chat". check-forbidden: bỏ qua vì `FORBIDDEN_PATTERNS` không đặt (kịch bản tự ghi là bình thường). Exit 0. |
| `perf-gate bundle` | Startup JS 149.2 / 150.0 KB. CSS 19.9 / 20.0 KB. Đạt. |
| `buf lint`, `buf breaking` (so với main) | Đều exit 0. |
| Go (`GOOS=linux`) | `go build ./...` và `go vet ./gen/...` exit 0. |

Các nhóm hỏng sẵn trên Windows:
- `terminal-agent` 16 test, `terminal-staged-replace` 5, `terminal-ai-session` 4, `terminal-units` 2: socket điều khiển và `/bin/sh`.
- `provider-contract` 11, `antigravity` 4: agy giả báo phiên bản 1.2.13.
- Liên kết tượng trưng (`symlink EPERM`), đường dẫn có `\`, `systemd`, `update`, `log-rotate`, v.v.

Test mới:
- Agent, `terminal-session-switch.test.ts`, 3 test:
  - `/clear` ghi đúng một mục ngắt nằm trước cuộc mới và giữ cuộc cũ; nhìn lại, theo lại hay kết thúc terminal cũng không ghi mục thứ hai.
  - Phiên khởi động chưa có transcript thì được thay mà không có mục ngắt.
  - `/resume` quay lại cuộc cũ: cuộc đó hiện lại sau mục ngắt thứ hai, và câu giống hệt câu cũ không bị bỏ.
- Agent, `terminal-launch-open-elsewhere.test.ts` (mới), 6 test:
  - Bị từ chối khi một claude khởi động từ một giờ trước đang mở phiên; mở được sau khi cửa sổ đó đóng.
  - CLI của chính luồng không bị tính, cả khi đang thoát lẫn khi `meta.terminal` vẫn còn.
  - Bản ghi của pid đã chết và cuộc khác cùng thư mục không bị tính.
  - Phiên chat của máy vừa đóng: chờ tiến trình đó thoát rồi mở; nếu nó không thoát thì từ chối.
  - Luồng mới: không hỏi gì.
- Agent, `running-claude.test.ts`, 1 test: đường dòng lệnh (macOS và Linux), loại CLI của terminal, không đoán theo thư mục.
- Agent, `journal-and-recovery.test.ts`, 1 test: mục loại lạ không cắt nhật ký.
- Web, `conversation-break.test.tsx` (mới), 6 test: chia theo `seq` kể cả ca `/resume`, đếm tin, thân lạ không vẽ gì, dòng gập (mở ra, vị trí trên và dưới, gập lại), và không có dòng khi không có mục ngắt.
- Web, `terminal-ui.test.tsx`, 1 test: câu từ chối mới trong Terminal mode.

Thay đổi phụ cho test:
- `test/support/claude-transcript.ts`: id tin nhắn API giờ là duy nhất theo phiên, như API thật. Trước đây mọi transcript giả đều dùng `msg_0001`, nên cuộc mới đè cuộc cũ.
- Hàm `heldByTerminal` chuyển sang `test/support/claude-terminal-thread.ts` để hai file test dùng chung.

## Chưa kiểm được

- Chưa chạy trên máy thật với `claude` và `tunelo-term-host`.
- Chưa chạy Playwright e2e.
- `terminal-staged-replace` (luồng thay tiến trình terminal) không chạy được trên Windows. Phần lịch sử giả của nó không có `openInOtherProcess` nên luồng ấy không bị chặn. CI Linux sẽ chạy nó.

## Câu hỏi còn mở (lần làm đầu; câu 2 đã giải quyết bằng C1, câu 1 xem "Sửa theo review")

1. Tôi không biết tiến trình claude do SDK mở (phiên chat của máy) có ghi bản ghi `sessions/<pid>.json` hay không. Nếu có, nó chỉ làm Terminal mode chờ tối đa 3 giây sau khi đóng phiên chat; nếu không thì không chờ. Thử trên máy thật sẽ rõ.
2. Nếu agent bị hạ về một bản **trước** bản này, bộ nạp nhật ký cũ sẽ cắt nhật ký từ mục ngắt trở đi. Rủi ro này đã có với mọi loại mục thêm trước đây; từ bản này trở đi thì không còn. Có cần chặn hạ bản ở bước cập nhật không?
3. Claude bản cũ, không ghi sổ đăng ký và cũng không có `--resume` trên dòng lệnh, sẽ không bị nhận ra. Tôi chấp nhận để lọt (không chặn) thay vì chặn nhầm. Hướng này có ổn không?

## Sửa theo review

Nguồn: `plans/reports/code-reviewer-261114-2350-clear-view-and-terminal-guard.md`. Tôi đã kiểm chứng từng phát hiện trong code trước khi sửa. Không có phát hiện nào sai. Tôi đã sửa C1, C2, M1–M6 và L1–L4; L5, L6, L7 để lại, có lý do ở dưới.

### Kiểm chứng phát hiện

- **C1 đúng.** Bộ nạp ở `HEAD` (`git show HEAD:apps/agent/src/threads/journal.ts`, dòng 30–35) gọi `fromJsonString(ItemSchema, line)` không kèm `ignoreUnknownFields`, rồi `break` và `truncateSync` ở dòng đầu tiên lỗi.
- **C2 đúng.** `registers()` chỉ kiểm `alive(pid)`. Trên Windows, `ClaudeProcesses.refresh()` không chạy gì. Sổ đăng ký thật có `procStart`. Tôi đã đo trên PC: `(Get-Process -Id 20964).StartTime.ToFileTimeUtc()` trả `134391447150113910`, khớp **chính xác** `procStart` trong `20964.json`; lệnh mất 0,2 giây.
- **M1 đúng về cơ chế.** `parked` chỉ đúng khi chính lần gọi đó đóng phiên. Tôi tìm trong mã của claude 2.1.325 (bản đã cài): sổ đăng ký ghi `entrypoint: CLAUDE_CODE_ENTRYPOINT`, và `kind` chỉ khác `"interactive"` với `bg`/`daemon`/`daemon-worker`. Tôi chưa xác định được claude chạy qua SDK có ghi sổ đăng ký hay không, vì đoạn kiểm điều kiện đã bị thu gọn tên. Trên PC này không có transcript nào của SDK để đối chiếu.
- **M2, M3, M4, M5, M6 đúng.** Tôi đã đọc lại đúng các dòng reviewer nêu.

### C1: mục ngắt là `StatusItem` rỗng, không còn là loại mục riêng

- Đã gỡ `ConversationBreakItem` và trường 24, rồi sinh lại bằng `pnpm proto:gen`. `git diff --quiet -- proto packages/proto-ts server/gen` cho kết quả rỗng, nghĩa là giống hệt `HEAD`. `buf lint` exit 0, `buf breaking` (so với main) exit 0.
- Quy tắc dùng chung đặt trong `packages/remote-protocol/src/journal-rules.ts`, nơi đã chứa các quy tắc nhật ký cả hai phía cùng theo:
  - `CONVERSATION_BREAK_ID_PREFIX = "conversation-break:"`;
  - `conversationBreakItem(segment, sessionId)` tạo `{ id: "conversation-break:<đoạn>:<phiên>", body: status { text: "" } }`;
  - `isConversationBreak(item)` nhận ra mục ngắt. Hàm này đòi đủ cả tiền tố, loại `status` và `text` rỗng, nên một dòng trạng thái thật không bao giờ bị coi là mục ngắt.
- Agent (`latestBreakSeq`, `breakConversation`) và web (`splitConversations`) đều dùng hàm này.
- **Bản cũ:**
  - Bộ nạp đã phát hành đọc được `StatusItem`. Test mô phỏng đúng vòng nạp ở `HEAD` (JSON chặt, cắt ở dòng lỗi đầu tiên) đọc đủ 3 mục và không cắt byte nào.
  - Web đã phát hành không vẽ gì cho dòng trạng thái rỗng (`git show HEAD:…/tool-fold.ts`, dòng 223–224: `text.trim() === "" ? null`). Web cũ vẫn hiện cả hai cuộc như trước, chỉ không gập.
  - Preview và bàn giao ở agent cũ bỏ qua `status`.
- Tôi giữ cải tiến bộ nạp: gặp loại mục lạ thì giữ lại, không cắt.
- Tài liệu `docs/terminal-wire.md` đã viết lại theo cách mã hoá này, kèm lý do.

### C2 và M1: sổ đăng ký chỉ được tính khi xác thực được tiến trình

- Hàm mới `providers/claude/process-start.ts` lấy giờ tạo của tiến trình trên Windows. Lệnh PowerShell chỉ nhận pid đã kiểm là số nguyên dương, có timeout 5 giây, lỗi nào cũng trả `undefined`.
- Trên macOS/Linux, giờ khởi động lấy từ danh sách `ps` (gồm các claude còn sống). Danh sách này vốn đã loại các tiến trình con của agent, tức tiến trình SDK.
- `openInOtherProcess` giờ là hàm async, và một bản ghi chỉ được tính khi `runsAsRecorded` xác thực được:
  - Nếu có cả `procStart` và FILETIME, hai giá trị phải lệch không quá 1 giây.
  - Nếu không, `startedAt` phải khớp giờ khởi động trong khoảng ±10 giây.
  - Không xác thực được thì **không tính**. Hướng này nghiêng về không chặn nhầm.
- **M1:**
  - Bản ghi có `entrypoint` bắt đầu bằng `sdk` không được tính.
  - Thời gian chờ không còn dựa vào `parked` mà vào `meta.closedAt`: phiên chat của máy đóng trong 3 giây gần nhất, vì bất kỳ lý do gì (`park` ở đây, `idleVictim`, `parkIdle`), đều được chờ cho tới hết 3 giây đó.
- Kiểm trên dữ liệu thật của PC: với 7 claude đang chạy, `openInOtherProcess` cho `true` cả 7 (đã xác thực qua `procStart`); với một id phiên lạ thì cho `false`.

### M2–M6 và các lỗi Thấp

- **M2:**
  - Vòng chờ kiểm `t.session` và mọi trạng thái bận **ở đầu mỗi lượt**, kể cả sau lượt chờ cuối. Một tin từ thiết bị khác trong lúc chờ làm yêu cầu mở terminal nhận `THREAD_RUNNING`.
  - Sau bước kiểm, cờ `t.launching` được bật cho tới `terminalStarted`. `ThreadSend` bị từ chối (`SESSION_OPEN_ELSEWHERE`) trong lúc cờ bật.
  - `terminal-service.openAi` gọi `ai.abandoned(threadId)` khi daemon không mở được, và `terminalLaunch` tự xoá cờ khi adapter lỗi, nên cờ không bao giờ kẹt.
- **M3:** hàm `turnHolds` mới gom mọi điều kiện chặn, thêm `t.reasks.size > 0`. Câu hỏi được hỏi lại sau khi khởi động lại phải trả lời bằng chat trước. Web nhận `THREAD_RUNNING` và hiện dòng "bận, thử lại" có sẵn.
- **M4:** trong `followTerminal`, `syncHistory` chạy cho đoạn cũ **trước khi** đẩy đoạn mới, nên lượt cuối của cuộc cũ vào nhật ký trước mục ngắt.
- **M5:** khung chat giờ theo từng cuộc trò chuyện, khoá theo `threadId` và id mục ngắt.
  - Một mục ngắt mới tới (lúc người dùng đang cuộn lên) sẽ đặt lại cửa sổ, đưa về cuối cuộc mới và bật lại chế độ bám đáy.
  - Thêm một chốt an toàn: chỉ số cửa sổ quá độ dài thì bỏ, quay về trang cuối.
- **M6:** bản bàn giao khi đổi AI dùng `journal.since(latestBreakSeq(...))`, tức chỉ phần chat đang hiện.
- **L1:** `prime()` được gọi trong mỗi lượt chờ.
- **L2:** CLI của chính luồng chỉ được miễn trong 15 giây sau khi terminal kết thúc (`lastTerminal.endedAt`, hằng `OWN_CLI_EXIT_MS`). Miễn trừ bị xoá khi terminal mới chạy. Một CLI mồ côi sống lâu hơn thế bị tính là tiến trình khác.
- **L3:** chỉ ghi mục ngắt khi phần đang hiện có ít nhất một tin của người dùng hay AI. Dòng "(0 tin nhắn)" không còn xuất hiện.
- **L4:** nhánh thay phiên khởi động (`/resume` ngay từ phiên chưa có transcript) cũng ghi mục ngắt khi phần đang hiện đã có tin nhắn.
- **Để lại:**
  - **L5:** câu "dùng tab Trò chuyện" cũng hiện cả khi một lượt đang chạy ở nơi khác. Câu chữ là quyết định đã chốt; tách lý do lỗi sẽ cần thêm `ErrorReason`.
  - **L6:** kích thước file. `agent-core.ts` hiện 2759 dòng, `session-chat.tsx` 863 dòng; cả hai vốn đã vượt 200 dòng từ trước. Tách `Transcript` nên làm thành một việc riêng.
  - **L7:** CSS dùng 44 px và outline 2 px theo quy ước vùng chạm; reviewer cũng ghi là không chặn.

### Test mới hoặc đã sửa

- `remote-protocol/test/journal-rules.test.ts`, +1: hình dạng mục ngắt, phân biệt với dòng trạng thái thật.
- `agent/test/journal-and-recovery.test.ts`, +1 (**C1**): bộ nạp như bản đã phát hành đọc nhật ký có mục ngắt, đủ 3 mục, không cắt.
- `agent/test/terminal-session-switch.test.ts`, 5 test về mục ngắt:
  - mục ngắt là status rỗng;
  - **M4**: lượt cuối trước `/clear`;
  - **L3**: không ghi mục ngắt khi chưa có gì hiện;
  - `/resume` quay lại;
  - **M6**: bàn giao chỉ có cuộc mới, cả trong tóm tắt lẫn tin đầu gửi AI mới.
- `agent/test/terminal-launch-open-elsewhere.test.ts`, 11 test:
  - **C2**: pid bị cấp lại cho chương trình khác;
  - **M1**: bản ghi SDK; phiên vừa bị máy đóng để lấy chỗ (`maxSessions: 1`);
  - **M2**: tin trong lúc chờ cho `THREAD_RUNNING`; khi CLI đang khởi động thì tin bị từ chối; sau `terminalAbandoned` thì gửi được;
  - **M3**: câu hỏi được hỏi lại;
  - cùng các trường hợp cũ.
- `agent/test/running-claude.test.ts`, +2:
  - xác thực bằng `procStart`: khớp, pid bị cấp lại, không có `procStart`, không xác thực được, SDK;
  - phân tích kết quả PowerShell: chỉ nhận pid số nguyên, lỗi thì trả `undefined`.
- `web/test/machines/conversation-break.test.tsx`, 9 test:
  - mục ngắt theo cách mã hoá mới;
  - dòng trạng thái thật giữ nguyên chỗ;
  - **M5**: `/clear` lúc đang cuộn lên vẫn hiện cuộc mới.

### Số liệu cổng kiểm tra (chạy tuần tự, `--maxWorkers=2`)

| Cổng | Kết quả |
|---|---|
| Agent vitest, toàn bộ | 101 file: 72 pass, 24 fail, 5 skip. Test: **880 pass, 69 fail, 52 skip** (1001). 5 lỗi ngoài test (`listen EACCES control.sock`). |
| So với đường cơ sở | `diff` danh sách test hỏng với lần chạy cơ sở (stash phần agent): **giống hệt 69 test, không thêm test nào**. |
| Web vitest, toàn bộ | 120 file: 119 pass, 1 skip. Test: **1232 pass, 3 skip, 0 fail**. |
| `@achoo254/chat-remote-protocol` vitest | 4 file, 22 test pass. |
| Typecheck `tsc --noEmit` | agent 0 lỗi, web 0 lỗi, remote-protocol 0 lỗi. |
| `pnpm lint` | eslint `--max-warnings=0` exit 0 (0 lỗi, 0 cảnh báo); check-brand đạt; check-forbidden bỏ qua (`FORBIDDEN_PATTERNS` không đặt). |
| Bundle gate | JS 149.2 / 150.0 KB, CSS 19.9 / 20.0 KB: đạt. |
| `buf lint`, `buf breaking` (so với main) | 0 / 0. Proto và mã sinh giống hệt `HEAD`. |
| Go `GOOS=linux go build ./...` | exit 0. |

### Câu hỏi còn mở

1. **M1, phần chưa có dữ liệu:** claude chạy qua SDK (phiên chat của máy) có ghi `sessions/<pid>.json` không, và nếu có thì `entrypoint` có bắt đầu bằng `sdk` không? Mã của claude ghi đúng biến môi trường `CLAUDE_CODE_ENTRYPOINT` (SDK đặt là `sdk-ts`). Nếu SDK ghi mà không có tiền tố đó, lớp chắn còn lại là 3 giây chờ sau `closedAt`. Kiểm trên Mac đang chạy agent: mở một phiên chat rồi xem `~/.claude/sessions/`.
2. **C2, điều kiện gốc:** claude bị giết cứng (ConPTY đóng) có để lại `sessions/<pid>.json` không? Bản sửa đã đúng cho cả hai trường hợp; câu hỏi này chỉ để biết mức rủi ro thật.
3. **L5:** có cần một câu riêng cho trường hợp "một lượt đang chạy ở nơi khác" không (khi đó tab Trò chuyện cũng không gửi được)? Làm thế cần thêm một lý do lỗi.

Status: DONE
Summary: Đã sửa đủ C1, C2, M1–M6 và L1–L4. Mục ngắt giờ là `StatusItem` rỗng mà bộ nạp và web đã phát hành đọc an toàn; proto giống hệt `HEAD`. Bản ghi sổ đăng ký chỉ được tính khi xác thực được tiến trình qua `procStart` hoặc `startedAt`, và tiến trình SDK không bị tính. Mọi cổng đều xanh, trừ đúng 69 test hỏng sẵn trên Windows, giống hệt đường cơ sở.
Concerns/Blockers: Chưa thử trên máy thật với agent đang chạy. Việc SDK có ghi sổ đăng ký hay không còn chưa xác nhận (câu hỏi 1).
