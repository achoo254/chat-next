# Review: chat chỉ hiện cuộc sau /clear, và Terminal mode không mở tiến trình thứ hai

Repo `chat-next`, thay đổi chưa commit trên `main`. Chỉ đọc; không sửa, không stage. Đã bỏ qua `apps/web/package.json`, `apps/web/test/app-switcher.test.tsx`, `pnpm-lock.yaml`.

## Kết luận

**Chưa nên commit nguyên trạng.** Phần web (chia theo `seq`, dòng gập, i18n) và tính idempotent của mục ngắt đều đúng. Tôi đã đọc code và chạy test để xác nhận. Có một lỗi Cao dẫn tới **mất dữ liệu nhật ký**: chạy `tunelo update --rollback` về một bản agent trước bản này thì bộ nạp cũ cắt nhật ký từ mục ngắt đầu tiên trở đi. Có thêm một lỗi Cao (có điều kiện) về chặn nhầm Terminal mode trên Windows, và năm lỗi Trung bình. Phần lớn lỗi sửa gọn được, xem mục "Việc nên làm".

Đã kiểm chứng:
- 4 file test agent liên quan đều qua (`terminal-launch-open-elsewhere`, `terminal-session-switch`, `journal-and-recovery`, `running-claude`): 32/32 test, chạy với `--maxWorkers=2`.
- File test web `conversation-break.test.tsx` qua 6/6.
- Không chạy lại toàn bộ suite, lint, tsc. Kết quả các bước đó lấy từ báo cáo của người làm, tôi chưa kiểm lại.
- Đã đọc trực tiếp sổ đăng ký thật `~/.claude/sessions/*.json` trên PC (Claude 2.1.325) để kiểm các giả định về sổ đăng ký.

## Phát hiện, xếp theo mức độ

### Cao

**C1. Rollback agent làm mất nhật ký: bộ nạp cũ cắt từ mục ngắt trở đi.**
- Vị trí: `apps/agent/src/threads/journal.ts:32` (bản mới đã sửa) và bản cũ của chính dòng đó. Mục ngắt được ghi ở `apps/agent/src/core/agent-core.ts:2564`.
- Kịch bản:
  1. Người dùng cập nhật lên bản này, rồi chạy `/clear` trong terminal. Agent ghi dòng `{"conversationBreak":{}}` vào `journal.jsonl`.
  2. Bản mới lỗi, người dùng chạy `tunelo update --rollback` (`apps/agent/src/update.ts:709`).
  3. Bản cũ gọi `fromJsonString(ItemSchema, line)` mà không có `ignoreUnknownFields`, nên ném lỗi ở dòng đó. Vòng nạp coi đó là dòng bị xé, `break`, rồi `truncateSync(file, good)`.
  4. Mọi mục từ mục ngắt trở đi bị xóa vĩnh viễn trên đĩa: cả cuộc trò chuyện mới lẫn mọi revision sau.
- Báo cáo của người làm (câu hỏi 2) có nêu rủi ro này. Nhưng "đã có với mọi loại mục thêm trước đây" không làm nó nhẹ đi: đây là đường mất dữ liệu đi qua một lệnh được hỗ trợ chính thức.
- Cách sửa, chọn một:
  - (a) Tách hai bản phát hành. Bản N chỉ chứa bộ nạp `ignoreUnknownFields`. Bản N+1 mới bắt đầu ghi `conversationBreak`. Rẻ nhất, và chặn được mọi loại mục mới về sau.
  - (b) Cho `rollback` từ chối hạ xuống dưới phiên bản tối thiểu đọc được nhật ký hiện có, ghi trong một file định dạng nhật ký.
  - (c) Bộ nạp cũ không bao giờ `truncate` một dòng đầy đủ (có `\n`) parse lỗi, chỉ bỏ qua dòng đó. Nhưng (c) chỉ có tác dụng từ bản này trở đi, nên vẫn cần (a).

**C2 (có điều kiện). Windows: chặn nhầm Terminal mode khi file sổ đăng ký cũ còn lại và pid đã bị dùng lại.**
- Vị trí: `apps/agent/src/providers/claude/local-sessions.ts:293` (`openInOtherProcess`) và `:601` (`registers()` chỉ kiểm `alive(pid)`).
- Bằng chứng trên PC: mỗi bản ghi thật có `procStart` (FILETIME lúc tiến trình tạo), `kind: "interactive"`, `entrypoint: "cli"`. Code bỏ qua cả ba trường.
- Trên Windows, `ClaudeProcesses.refresh()` không chạy (`running-claude.ts:121`), nên sổ đăng ký là nguồn duy nhất. Lớp kiểm theo `ps` không tồn tại để gỡ sai.
- Kịch bản:
  1. CLI của luồng bị giết cứng (ConPTY đóng khi "Kết thúc", hoặc host terminal chết). Nếu claude không kịp dọn `sessions/<pid>.json` thì file còn lại với `sessionId` của luồng.
  2. Agent khởi động lại (cập nhật), nên `lastTerminalStart` (chỉ nằm trong RAM) mất.
  3. Windows dùng lại pid rất nhanh: một tiến trình bất kỳ nhận đúng pid đó, nên `process.kill(pid,0)` trả true.
  4. `terminalLaunch` trả `SESSION_OPEN_ELSEWHERE` mãi cho tới khi tiến trình lạ kia thoát. Web bảo người dùng "đóng cửa sổ đó trước", trong khi không có cửa sổ nào. Không có cách vượt.
- Chưa xác minh claude có để lại file khi bị giết hay không: cả 7 file trên PC lúc review đều của tiến trình `claude.exe` còn sống.
- Cách sửa: khi có bản ghi khớp (đường hiếm, nên chi phí nhỏ), xác minh thêm `procStart` hoặc tên ảnh của pid. Ví dụ `tasklist /FI "PID eq n"` phải ra `claude.exe`/`node.exe`, hoặc so `procStart` với giờ tạo tiến trình. Không khớp thì không tính.

### Trung bình

**M1. Tiến trình SDK của chính agent có thể bị tính là "cửa sổ khác".**
- Vị trí: `agent-core.ts:2398-2401`, `:2440-2445`.
- `parked` chỉ là true khi chính lần gọi này đóng phiên. Danh sách theo `ps` tự loại con của agent (`parsePs`, `exceptParent`), nhưng đường sổ đăng ký không loại gì.
- Nếu claude do SDK mở cũng ghi sổ đăng ký (người làm chưa biết; xem câu hỏi 1), có hai kịch bản lỗi:
  - (a) Phiên chat vừa bị `parkIdle`, `idleVictim` hay `switchProvider` đóng trước đó vài trăm ms. Lúc mở terminal thì `parked=false`, nên bị từ chối ngay.
  - (b) Tiến trình SDK thoát chậm hơn 3 giây, chẳng hạn vì đóng MCP server hay chạy hook SessionEnd (PC này có nhiều hook). Kết quả là từ chối nhầm, kèm câu "đang mở trong cửa sổ khác".
- Cách sửa:
  - Ghi lại pid tiến trình SDK agent tự sinh (SDK có tùy chọn spawn riêng) và loại chúng khỏi `openInOtherProcess`.
  - Hoặc dùng `kind`/`entrypoint` của bản ghi để nhận ra tiến trình SDK.
  - Tối thiểu: thay `parked` bằng "phiên của máy đóng trong vòng `PARKED_EXIT_MS` gần nhất", dựa trên `t.meta.closedAt`.

**M2. Thiết bị khác gửi tin trong lúc chờ 3 giây thì nhận sai lý do, và vẫn còn khe để hai tiến trình cùng ghi một phiên.**
- Vị trí: `agent-core.ts:2440-2445`, `:2403`, và đoạn từ `:2406` tới `terminalStarted` (`:2486`).
- Kịch bản (a):
  1. Trong lúc vòng chờ chạy, `t.meta.terminal` chưa đặt, nên `ThreadSend` (`:1333`) cho qua. `ensureSession` mở một claude SDK `--resume S`.
  2. Nếu tiến trình đó ghi sổ đăng ký, vòng lặp tiếp tục thấy "mở nơi khác" và sau 3 giây ném `SESSION_OPEN_ELSEWHERE` thay vì `THREAD_RUNNING`. Web hiện câu "đóng cửa sổ đó" sai sự thật.
- Kịch bản (b), có từ trước nhưng trái với nguyên tắc "terminal và chat chỉ là hai giao diện của một phiên":
  1. Sau bước kiểm tra ở `:2403` còn hai `await`: `provider.terminal.command` và `call("open")` trong `terminal-service.ts:330`.
  2. `ThreadSend` vẫn lọt được vào giữa hai `await` đó, nên chat SDK và CLI terminal cùng chạy trên phiên S.
- Cách sửa:
  - Kiểm `t.session || t.starting || t.running || t.queued` ngay trong mỗi vòng lặp và ném `THREAD_RUNNING`.
  - Đặt cờ `t.launching` từ đầu `terminalLaunch` tới `terminalStarted`, xóa khi lỗi, và cho `ThreadSend`/`ensureSession` từ chối khi cờ bật.

**M3. Revision mới của một mục trước mục ngắt nhảy sang cuộc trò chuyện hiện tại.**
- Vị trí: `apps/web/src/machines/transcript/conversation-break.ts:28` (chia theo `seq` của revision mới nhất), `journal.ts:50-64` (mỗi revision lấy `seq` mới), `agent-core.ts:2100-2104` (`expirePending`) và `:2146-2149` (`cancelReasks`).
- Kịch bản:
  1. Agent khởi động lại khi đang có một câu hỏi chờ, nên `reaskQuestion` tạo thẻ `ask:again:*`.
  2. `terminalLaunch` kiểm `t.pending` mà không kiểm `t.reasks` (`:2379`), nên mở terminal được.
  3. Người dùng `/clear`, mục ngắt được ghi sau thẻ đó, thẻ bị gập vào "Cuộc trò chuyện trước".
  4. Khi dịch vụ dừng hoặc luồng bị dừng, `update` đổi thẻ thành EXPIRED/CANCELLED với `seq` mới. Web đưa thẻ cũ lên giữa cuộc mới.
- Đây là bất biến dễ vỡ: mọi `journal.update` sau này trên mục cũ đều mắc lỗi này.
- Cách sửa:
  - Tối thiểu: `terminalLaunch` từ chối khi `t.reasks.size > 0`, hoặc hủy reask khi terminal mở.
  - Lâu dài: thiết bị chia theo `seq` của revision đầu tiên. Có thể thêm `Item.first_seq`, hoặc agent ghi lại mục bị cập nhật dưới id mới.

**M4. Đoạn cuối của cuộc trước bị mất khi `/clear` xảy ra trong 5 giây sau lần đọc gần nhất.**
- Có từ trước, nhưng giờ người dùng nhìn thấy, và trái với tài liệu ("Mục trước nó vẫn nằm trong nhật ký").
- Vị trí: `agent-core.ts:657-660` (`followElsewhere` gọi `followTerminal` trước), `:2538-2540`, `:1181-1189` (`syncHistory` chỉ đọc đoạn cuối).
- Kịch bản:
  1. Người dùng gõ một câu trong terminal và AI trả lời xong.
  2. Chưa tới 5 giây sau (`ELSEWHERE_POLL_MS`), người dùng gõ `/clear`.
  3. Lần nhìn sau, `followTerminal` đẩy đoạn mới và ghi mục ngắt. `syncHistory` chỉ đọc phiên mới, nên câu hỏi và câu trả lời cuối của phiên cũ không bao giờ vào nhật ký. Dòng "Cuộc trò chuyện trước" thiếu đúng lượt cuối.
- Cách sửa: trong `followTerminal`, trước khi `push` đoạn mới, gọi `syncHistory(t)` cho đoạn cũ. Điều kiện chặn `running`/`starting`/`switching` đã có sẵn.

**M5. Đang cuộn lên đọc thì `/clear` xảy ra: khung chat trống.**
- Vị trí: `apps/web/src/machines/session-chat.tsx:635`, `:718`.
- Trước đây `blocks` chỉ tăng nên chỉ số `from.start` (`fixed`) luôn hợp lệ. Giờ `blocks` (cuộc hiện tại) có thể co lại khi có mục ngắt mới.
- Kịch bản:
  1. Người dùng cuộn lên trong luồng chỉ đọc khi terminal đang giữ, nên `fixed = 25`.
  2. Trên máy, `/clear` chạy, và cuộc hiện tại chỉ còn 2 khối.
  3. `shown = all.slice(25)` rỗng, `before (0) < start (25)` nên không có dòng gập, chỉ còn nút "Xem 25 mục trước" trên nền trống.
- Cách sửa: reset `from` khi mục ngắt mới nhất đổi (lưu `seq` của mục ngắt trong state), hoặc kẹp `start` về `min(fixed, all.length - 1)`. Cần thêm test.

**M6. Đổi AI sau `/clear` vẫn chuyển nội dung đã clear cho AI mới.**
- Đây là câu hỏi sản phẩm, có hậu quả hành vi.
- Vị trí: `agent-core.ts:1641` (`buildHandoff({ items: t.journal.all() })`).
- Kịch bản: người dùng `/clear` để bỏ ngữ cảnh, gõ 1 câu, rồi đổi sang AI khác. Bản tóm tắt bàn giao gồm tới 10 câu của người dùng, phần lớn thuộc cuộc đã clear, và AI mới tiếp tục việc cũ.
- Nguyên tắc "terminal và chat là một phiên" gợi ý chỉ nên dùng `journal.since(latestBreakSeq)`.

### Thấp

- **L1.** `refuseOpenInOtherProcess` gọi `prime()` một lần trước vòng lặp. Trên macOS/Linux, danh sách `ps` được giữ 5 giây (`FRESH_MS`), nên trong 3 giây chờ, danh sách theo dòng lệnh không đổi. Nếu cửa sổ chủ máy vừa đóng chưa tới 5 giây trước đó, lệnh vẫn bị từ chối. Ít gặp. (`agent-core.ts:2439`)
- **L2.** `lastTerminalStart` không bao giờ được xóa và chỉ nằm trong RAM. Nếu CLI cũ của luồng còn sống mồ côi (host chết mà con không chết), nó được miễn mãi, nên vẫn có hai tiến trình cùng ghi. Sau khi agent khởi động lại thì ngược lại: CLI đang thoát không còn được miễn. (`agent-core.ts:2437`, `:2587`)
- **L3.** `breakConversation` ghi mục ngắt khi nhật ký có bất kỳ mục nào không phải mục ngắt, kể cả chỉ có `status`/`error`. Khi đó dòng gập hiện "Cuộc trò chuyện trước (0 tin nhắn)". Nên dùng điều kiện "có ít nhất một tin nhắn", giống `messageCount`. (`agent-core.ts:2561`)
- **L4.** Một luồng đã có nội dung, nhưng đoạn hiện tại chưa có `sessionId` (vừa đổi sang Claude, hoặc phiên khởi động bị bỏ). Nếu người dùng `/resume` sang một cuộc cũ thì nhánh `else seg.sessionId = held` (`:2541-2542`) không ghi mục ngắt, nên cuộc lạ trộn vào cuộc đang hiện. Nên kiểm: nếu nhật ký đã có tin nhắn thì vẫn ghi mục ngắt.
- **L5.** `openErrorText` (`terminal-dock.tsx:132`) đổi mọi `SESSION_OPEN_ELSEWHERE` sang câu "cửa sổ khác… dùng tab Trò chuyện". Trường hợp có sẵn `busyElsewhere` (`agent-core.ts:2382`, một lượt đang chạy nơi khác) cũng nhận câu này, trong khi lúc đó tab Trò chuyện cũng bị từ chối gửi (`:1491`).
- **L6.** Kích thước file: `agent-core.ts` 2696 dòng (+80), `session-chat.tsx` 848 dòng (+72). Cả hai vốn đã vượt ngưỡng 200 dòng. Phần `Transcript` cùng dòng gập nên tách ra file riêng khi chạm tới lần sau. Không chặn.
- **L7.** CSS `.mx-previous` dùng `min-height: 44px` và `outline: 2px` cứng. Phù hợp quy ước vùng chạm, không chặn.

## Những điểm đã kiểm và không có lỗi

- **Mục ngắt idempotent.** Id `break:<len-1>:<session>` gắn với số đoạn, nên ghi một lần cho mỗi đoạn. Agent chết giữa lúc ghi nhật ký và `saveMeta`: khi chạy lại, `followTerminal` đẩy lại đúng đoạn có cùng chỉ số, `journal.get(id)` thấy mục cũ và bỏ qua. `startedSeq` lệch đi nhưng không ai đọc trường này.
- **Thứ tự.** Mục ngắt được `put` trước `syncHistory` của phiên mới, nên `seq` đúng thứ tự.
- **`/resume` quay về cuộc cũ.** Các mục của cuộc đó có `found.seq < shownFrom`, nên được `put` lại thành revision có `seq` sau mục ngắt. Lần nạp sau bỏ qua chúng, không ghi trùng. Chỉ phần "recent" của transcript được ghi lại; phần cũ hơn nằm ở "cuộc trước", chấp nhận được.
- **Thân lạ.**
  - Web: `single()` có `default: return null`, có test.
  - Server Go: không có `switch` nào trên thân `Item` ngoài mã sinh ra. Mã TS và Go sinh lại nhất quán (chỉ dịch chỉ số message).
  - Web không lưu `Item` dạng JSON nên không có rủi ro tương tự C1 phía web.
  - `ignoreUnknownFields` của protobuf-es còn bỏ qua cả giá trị enum lạ, có ích thêm.
- **Đường dẫn Windows trong `isExcept`.** `dirComparer` gập hoa/thường trên win32 và so cả đường dẫn thật (`realpathSync.native`), nên hai kiểu dấu `\` và `/` khớp nhau khi thư mục còn tồn tại. `sessionId` hai phía đều được hạ chữ thường.
- **Sổ đăng ký thật.** Hai tiến trình `claude.exe` còn sống có thể giữ **cùng một** `sessionId` (đã thấy trên PC). Vậy kịch bản "hai tiến trình cùng ghi một phiên" mà guard nhắm tới là có thật.
- **Test hỗ trợ (id tin nhắn duy nhất theo phiên).** Khớp với API thật, nơi id tin nhắn là duy nhất toàn cục. Thay đổi không che lỗi: trước đây `msg_0001` trùng giữa các transcript giả làm cuộc mới ghi đè cuộc cũ, tức test cũ sai chứ không phải code sai. Rủi ro còn lại ngoài phạm vi: phiên fork (`--fork-session`) chép lại id cũ.
- **Test không rỗng.** Test web kiểm vị trí DOM, `aria-expanded`, đóng và mở. Test agent kiểm số mục ngắt, thứ tự, và số lần hỏi.
- **i18n.** Ba file có cùng hai khóa. Kiểu `MachinesCopy` buộc en và zh khớp vi. Nhãn tab khớp `mode.chat` của từng ngôn ngữ ("Trò chuyện", "Conversation", "聊天"). Chuỗi mới không có chữ "Chat".
- **Code.** Không có `any`, không có `!` non-null, không có `eslint-disable`, không có nhãn plan/phase trong comment hay tên test. Không thấy code chết.

## Việc nên làm, theo thứ tự

1. C1: tách phát hành (bộ nạp chịu được loại mục lạ ra trước, ghi mục ngắt ở bản sau), hoặc chặn `rollback` về bản không đọc được nhật ký.
2. C2 và M1: xác minh bản ghi sổ đăng ký bằng `procStart` hoặc tên ảnh tiến trình, và loại tiến trình SDK do chính agent sinh ra. Hoặc ít nhất dùng `closedAt` thay cho `parked`.
3. M2: kiểm tra phiên trong vòng lặp chờ, và thêm cờ `launching` để đóng khe cho tới `terminalStarted`.
4. M4: `syncHistory` đoạn cũ trước khi chuyển đoạn.
5. M5: reset hoặc kẹp `from.start` khi mục ngắt mới nhất đổi, kèm test.
6. M3: chặn Terminal mode khi còn reask, hoặc hủy reask khi terminal mở.
7. M6: quyết định sản phẩm về handoff (xem câu hỏi 3).

## Câu hỏi còn mở

1. Claude khi bị giết cứng trên Windows (ConPTY đóng) có để lại `sessions/<pid>.json` không? Điều này quyết định C2 là Cao hay Thấp. Thử trên PC: mở claude trong terminal của tunelo, bấm "Kết thúc", xem file còn không.
2. Claude do SDK mở (phiên chat của máy) có ghi sổ đăng ký không, và nếu có thì với `kind`/`entrypoint` gì? Điều này quyết định M1 và M2(a), và cho biết có lọc được theo `kind` không.
3. M6: sau `/clear`, bàn giao khi đổi AI nên chỉ lấy cuộc hiện tại (đề xuất, khớp nguyên tắc "một phiên") hay cả nhật ký như bây giờ?
4. C1: chọn tách phát hành (đề xuất, rẻ nhất) hay chặn `rollback` theo phiên bản tối thiểu?

Status: DONE_WITH_CONCERNS
Summary: Mục ngắt idempotent, chia theo `seq` đúng, và phía web/i18n ổn; các test liên quan qua (agent 32/32, web 6/6). Nhưng còn đường mất dữ liệu nhật ký khi rollback agent (C1), nguy cơ chặn nhầm Terminal mode trên Windows do sổ đăng ký cũ hoặc tiến trình SDK (C2, M1), và năm lỗi Trung bình (M2–M6) nên sửa trước khi commit.
