# ADR 0020: Cố vấn: mascot trên mọi màn, phiên chỉ đọc theo thư mục, Jev bằng khoá của người dùng

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-17
- Bổ sung [ADR 0013](./0013-remote-machines.md), [ADR 0017](./0017-provider-neutral-ai-agent.md) và [ADR 0018](./0018-office-view-babylon-normalized-agent-stream.md).

## Bối cảnh

Người dùng hay phân vân giữa vài cách làm (một lỗi git, một bước tiếp theo của phiên AI) và muốn hỏi ngay tại chỗ, kèm đoạn vừa copy, mà
không phải tự kể lại bối cảnh. Jev (mô hình của TypeSafe) cho xác suất từng phương án của một câu hỏi lựa chọn nhưng không tự điều tra; AI
lập trình trên máy của người dùng điều tra được nhưng không cho xác suất. Ràng buộc có sẵn: nội dung phiên chỉ đi giữa thiết bị và máy qua kênh
mã hoá đầu cuối (ADR 0013), không AI nào được gắn cứng (ADR 0017), hệ sinh thái không có khoá AI dùng chung cho người dùng (chỉ BYOK).

## Quyết định

- **Mascot trên mọi màn của Chat.** Gắn bên trong `MachineLinksProvider` nên chỉ có sau khi đăng nhập và có cả ở màn chat thường; tải lười qua
  `apps/web/src/advisor/advisor-loader.tsx` để không làm nặng bundle khởi động. Kéo được, hít mép, vị trí nhớ theo thiết bị. Kết nối tới máy
  đích chỉ mở khi mở bong bóng hoặc còn câu hỏi đang chờ. Người dùng tuỳ chỉnh tên, 4 ngoại hình mẫu và giọng văn; hồ sơ lưu theo tài khoản trên
  server chat (`AdvisorService`, bảng `advisor_profiles`), không chứa bí mật, máy hay AI. Chữ "Jev"/"TypeSafe" chỉ xuất hiện ở mục nhập khoá.
- **Ngữ cảnh copy do màn khai báo, chỉ trong bộ nhớ, chỉ gửi khi người dùng gửi câu hỏi; đoạn vừa copy tự nằm trong ô hỏi (18/11/2026: bỏ bước bấm "Đính kèm", đỡ một thao tác).** Mỗi màn gắn ngữ cảnh có cấu trúc lên phần tử gốc của nó
  (`useAdvisorScope`, `apps/web/src/advisor/advisor-context.tsx`): máy, thư mục, nhánh, phiên, khung, thao tác, mã lỗi, `failure_id`. Bộ nghe copy
  giữ 5 lần copy gần nhất trong bộ nhớ của trang (`advisor-store.ts`), đính sẵn lần copy mới nhất (trong 10 phút) vào câu hỏi khi mở bong bóng, người dùng bấm ✕ để bỏ, không giữ gì ở vùng
  `data-advisor-ignore` (token bot, webhook, bí mật đăng nhập, khoá Cố vấn), ô mật khẩu hay chuỗi khớp bộ mẫu bí mật dùng chung. Màn chat thường
  chỉ ghi "một tin nhắn chat", không id hay tên. Không có chế độ trỏ chọn phần tử hay chụp màn hình: copy là cử chỉ người dùng đã chủ ý làm.
- **Bề mặt cắm được (18/11/2026).** Một service muốn dùng Cố vấn gọi một lần `registerAdvisorSurface` (`apps/web/src/advisor/advisor-surfaces.ts`: id, tên chỗ đó theo từng ngôn ngữ, khoá các trường phụ được gửi) rồi khai báo ngữ cảnh bằng `useAdvisorScope`; không sửa bong bóng, store hay máy B. Trường phụ đi trong `AdvisorContext.fields` (tối đa 8, khoá là tên, giá trị một dòng ≤200 ký tự): trang chỉ gửi trường mà bề mặt đã liệt kê và bỏ trường trông như bí mật; máy B coi chúng là chữ không tin cậy (YAML trong phần mô tả đính kèm, khoá bị chặn nếu không phải tên) và từ chối câu hỏi có nhiều hoặc dài hơn mức. Không bao giờ đặt id, tên hay bí mật của màn vào trường. Danh bạ và bot nay có bề mặt riêng (chỉ nêu chỗ, không id, không tên); phiên gửi thêm `ai`. Câu hỏi về một tin nhắn chat được trả lời vào ô soạn của chính cuộc trò chuyện đang mở ("Điền vào ô soạn tin": điền sau chữ đang gõ, không tự gửi; `AdvisorStore.chat` chỉ ở bộ nhớ trang). Chưa làm: hỏi khi người dùng không có máy B.
- **Phiên Cố vấn riêng, chỉ đọc, theo (máy, thư mục, AI).** Câu hỏi đi bằng RPC thread sẵn có: `ThreadCreate{kind: ADVISOR}` rồi `ThreadSend`
  với `client_msg_id` làm id câu hỏi, Dừng bằng `ThreadInterrupt{client_msg_id}`; không thêm bộ RPC hỏi/đáp riêng. Câu hỏi xếp hàng FIFO, mỗi câu
  một lượt có hạn; câu trả lời nằm trong journal nên thiết bị ngủ hay mất kết nối vẫn đọc lại được, kèm Web Push "Cố vấn đã trả lời" khi không
  ai đang xem. Thread ADVISOR bị ẩn khỏi danh sách phiên, push "cần bạn", thư mục gần đây, văn phòng và thống kê dùng AI (lượt của phiên Cố vấn
  vẫn ghi vào sổ, chỉ báo cáo bỏ ra). Thiết bị không báo biết loại thread này (web cũ) không bao giờ thấy nó. Chọn phiên riêng thay vì đưa câu hỏi
  vào phiên làm việc vì phiên làm việc có quyền ghi và lịch sử riêng của người dùng; câu trả lời cần đưa sang thì "Gửi sang phiên" chỉ điền ô
  nhập, người dùng tự bấm gửi.
- **tunelo ép chỉ đọc, không qua chế độ quyền của AI.** `apps/agent/src/advisor/advisor-guard.ts` quyết định cho mọi AI: đọc và tìm trong thư mục
  của phiên (không tệp bí mật, không ra ngoài kể cả qua symlink), todo, và ba tool của tunelo (`advisor_weigh`, `advisor_git`, `advisor_grep`);
  mọi thứ khác bị từ chối ngay kèm câu giải thích cho AI, không thẻ duyệt, không gì chờ người dùng. Chế độ `plan` không được dùng vì AI tự rời được.
  Grep có sẵn của AI chỉ trả tên tệp hoặc số đếm; tìm nội dung đi qua `advisor_grep`, lọc theo đúng luật của Read. Git đi qua `advisor_git`, chạy
  bằng runner git an toàn của workspace (không hook, không chương trình cấu hình của repo), không bao giờ qua Bash.
- **Antigravity có phiên Cố vấn khi agy xin quyền.** Thử tay 17/11/2026 trên agy 1.5.8 với `toolPermission: "request-review"`: agy gửi
  `session/request_permission` trước shell, tool tạo/sửa tệp riêng và tool MCP; bị từ chối thì tool không chạy và MCP server không nhận lời
  gọi. Đọc tệp agy chạy không hỏi. Với `always-proceed` agy không hỏi gì, nên `start()` từ chối phiên Cố vấn ở máy đó (`strict` và
  `proceed-in-sandbox` chưa thử). Cờ `advisorSession: true` ở `apps/agent/src/providers/antigravity/index.ts`.
- **Lỗi git đầy đủ ở lại trên máy.** Thiết bị chỉ nhận dòng cuối của lỗi kèm `Error.failure_id`; máy giữ toàn văn trong bộ nhớ 10 phút
  (`git-failure-memory.ts`). Câu hỏi đính kèm `failure_id` thì máy bổ sung toàn văn đã làm sạch (`scrub-git-output.ts`: bỏ đường dẫn tuyệt đối,
  user/token trong URL, chuỗi giống bí mật), chỉ khi lỗi thuộc đúng thư mục của phiên Cố vấn.
- **Đính kèm là nội dung không tin cậy.** Máy bọc mỗi đính kèm giữa dấu ngăn có tag ngẫu nhiên kèm dòng dặn AI không làm theo chỉ dẫn bên trong;
  câu hỏi luôn mở đầu bằng dòng của tunelo nên câu bắt đầu bằng `/` không chạy thành lệnh. Giọng văn đi bằng enum `ThreadSend.advisor_tone`, máy
  đổi thành một dòng cố định; thiết bị không bao giờ gửi chữ tự do vào prompt.
- **Nhóm MCP ticket `advisor`.** `advisor_weigh` chạy trong dịch vụ tunelo, chỉ cấp cho ticket của phiên do tunelo mở; `tunelo mcp` không ticket
  không thấy nó. `advisor_git`/`advisor_grep` chỉ cấp cho thread ADVISOR, và thread ADVISOR không nhận nhóm nào khác.
- **Gửi ra ngoài: chỉ câu hỏi, phương án và bối cảnh tóm tắt do AI viết, đã che.** `advisor-outbound.ts` che bí mật đã biết, JWT, Bearer; còn
  chuỗi khớp bộ mẫu bí mật thì từ chối cả lời gọi, không gửi gì. Tool hiện nguyên body đã gửi trong kết quả, và thẻ chỉ hiện body đó, không bao
  giờ hiện đầu vào thô của lời gọi bị từ chối. Jev có 8 giây (`JEV_TIMEOUT_MS`); hết giờ, lỗi, hay lượt bị Dừng thì thẻ ghi lý do, không gợi ý.
- **Khoá TypeSafe BYOK trên máy B.** Kho riêng `advisor-secrets.json` (seal như bí mật đăng nhập, một `SecretStore` riêng) mà `request_secret` và
  env lệnh của phiên không đọc, nên AI không xin hay thấy được khoá. Khoá đặt từ thiết bị qua kênh mã hoá đầu cuối (`AdvisorSetKey`) hoặc
  `tunelo advisor set-key` (chỉ trong terminal thật, không qua pipe); khoá ngắn hơn 32 ký tự bị từ chối mà không được nhớ để che (che một chữ ngắn
  như "test" sẽ xoá nó khỏi mọi đầu ra). Thiết bị chỉ thấy dấu vân tay, thiết bị đặt và thời điểm; đặt/xoá ghi audit trên máy. Từ 18/11/2026
  (tunelo 3.23.0+) có thêm khoá chung của tài khoản: dán một lần, rồi máy niêm phong khoá cho khoá X25519 tạm của máy nhận (thiết bị lấy khoá
  công khai đó qua chính kênh mã hoá đầu cuối tới máy nhận, không từ danh sách của server), trình duyệt và server chỉ chuyển khối đã niêm phong
  (`AdvisorKeyShareBegin`, `AdvisorKeySeal`, `AdvisorKeyShareOpen`); khoá riêng của máy ghi đè khoá chung và không bao giờ được chuyển; khoá có
  từ trước được nâng thành khoá chung khi người dùng đồng ý (`AdvisorKeyPromote`); xoá khoá chung ghi `key_removed_at` vào hồ sơ Cố vấn để máy
  nối lại sau cũng bị xoá và khoá đó không bao giờ được chuyển tiếp. Lệnh đọc Keychain
  của tunelo và `tunelo advisor` bị coi là nhạy cảm. Giới hạn: AI chạy cùng user hệ điều hành với tunelo, nên khoá không cô lập tuyệt đối; lớp
  chặn còn lại là bộ lọc lệnh nhạy cảm (`apps/agent/src/safety/sensitive-paths.ts`) và thẻ duyệt Bash của phiên làm việc.
- **Chế độ tự động theo phiên, kênh chỉ dẫn theo từng AI.** Một công tắc chung cho cả tài khoản (18/11/2026, thay công tắc theo phiên ở menu mascot): Cài đặt › Cố vấn › "Tự theo dõi mọi phiên" lưu ở hồ sơ Cố vấn (`auto_session`); mỗi máy giữ bản của mình (`AdvisorSetAuto`, `MachineInfo.advisor.auto`, trong config của tunelo) và áp cho mọi phiên của máy, kể cả phiên terminal và phiên mở từ trước; thiết bị đang nối tới máy đối chiếu bản của máy với hồ sơ (`useAdvisorAutoSync`), chỉ sau khi hồ sơ đã tải xong, nên máy đang tắt nhận giá trị khi nối lại. `ThreadSetAdvisor` còn đó cho thiết bị cũ (cờ theo phiên cộng với công tắc chung, bật một trong hai là bật). Chỉ khi AI có MCP phiên. Claude nhận
  chỉ dẫn qua hook `UserPromptSubmit` (`additionalContext`): phiên được resume dùng lại system prompt đã ghi, nên đổi system prompt không có tác
  dụng giữa phiên, còn hook thì có tác dụng từ lượt sau mà không mở lại phiên. AI không có kênh ghi chú (Antigravity) nhận chỉ dẫn sau dấu ngăn
  cố định trong tin. Cả hai kênh không vào journal, lịch sử CLI hay `/compact`; tin bắt đầu bằng `/` không bị chèn.
- **Phiên Claude mở ở terminal cũng có chế độ tự động** (`ProviderCapabilities.terminal_advisor`; Claude bật, AI khác không). Chỉ khi máy
  có khoá Cố vấn lúc mở CLI ở terminal, core xin một vé MCP phạm vi "advisor-weigh" cho thread (giữ từ lúc mở tới khi terminal kết thúc, bị
  bỏ dở, thread bị xoá hay dịch vụ dừng); máy không có khoá thì lệnh terminal giữ nguyên như trước Cố vấn, và khoá đặt sau khi terminal đã mở
  có tác dụng từ lần mở terminal kế tiếp. Có vé thì `terminalCommand` thêm vào cùng một chuỗi `--settings` hook `UserPromptSubmit` chạy
  `tunelo advisor note <thread>` và quyền cho sẵn `mcp__tunelo-advisor__advisor_weigh`, rồi `--mcp-config` với server **`tunelo-advisor`**
  (`tunelo mcp` mang vé và `TUNELO_MCP_ADVISOR_WEIGH=1`). Tên riêng, không phải `tunelo`, để MCP `tunelo` người dùng tự thêm
  (`claude mcp add tunelo -- tunelo mcp`) vẫn chạy song song, không bên nào che bên nào; chỉ dẫn gửi cho CLI này nêu đúng tên đầy đủ
  `mcp__tunelo-advisor__advisor_weigh` (phiên chat giữ `tunelo`). Vé phạm vi này chỉ có `advisor_weigh`: dịch vụ từ chối mọi nhóm khác (bí
  mật, trình duyệt, Chat, Localman, đường hầm, `advisor_git`/`advisor_grep`) và không liệt kê tool của app.
- **Chỉ dẫn ở terminal.** `tunelo advisor note` (không chạy bước chuẩn bị nào khác của CLI) gửi qua control socket (`POST /advisor/note`) 64
  ký tự đầu của tin, `session_id` của CLI và mốc nó thôi chờ; core trả cùng chỉ dẫn như đường chat (`advisorNote`). Tin bắt đầu bằng `/`,
  `!` (shell của CLI) hay `#` (bộ nhớ) không nhận gì và không đổi trạng thái. `session_id` khác lần trước (sau `/clear`, `/resume` sang hội
  thoại khác) nghĩa là hội thoại mới chưa nghe gì: bản chỉ dẫn đầy đủ được gửi lại. Hook không xác nhận AI đã nhận, nên trạng thái "đã báo"
  đổi khi dịch vụ trả ghi chú; quá mốc thì dịch vụ không trả và không đổi gì, còn câu trả lời tới đúng lúc hook vừa bỏ cuộc (khe dưới
  0,2 giây) thì vẫn có thể bị tính là đã báo. Không có dịch vụ, lỗi hay quá 1,5 giây thì in `{}` và thoát 0: tin của người dùng không bao
  giờ bị chặn. Lệnh hook dùng đường dẫn tuyệt đối của tunelo, từng đối số trong nháy đơn cho `sh`/Git Bash, và trên macOS/Linux có tiền tố
  `TUNELO_HOME='…'` để hỏi đúng dịch vụ khi thư mục cấu hình không phải mặc định; trên Windows không có tiền tố này (dịch vụ ở thư mục khác
  mặc định thì hook không tìm thấy nó, in `{}`), và không có Git Bash (CLI dùng PowerShell) thì hook không chạy được, lỗi đó không chặn tin.
- **Giới hạn của đường terminal.** Vé nằm trong argv của `claude` (JSON của `--mcp-config`), nên mọi tiến trình cùng user, kể cả Bash của AI
  trong terminal, đọc được bằng `ps`; với vé đó chỉ gọi được `advisor_weigh` cho đúng thread (tốn lượt TypeSafe, có thể thêm thẻ nhận định),
  không chạm bí mật, Chat hay Localman. Vé chỉ sống trong bộ nhớ: dịch vụ khởi động lại khi CLI còn chạy thì CLI đó mất Cố vấn (không nhận
  chỉ dẫn, `advisor_weigh` báo vé đã hết) tới lần mở lại terminal, dù web vẫn cho bật công tắc. Thẻ nhận định của phiên terminal dựng từ
  transcript khi máy đọc lại (lời gọi `advisor_weigh` cùng kết quả), không gắn lượt nào nên không có `advisor_missed`. Web chỉ làm mờ công tắc
  ở phiên terminal khi máy không báo `terminal_advisor` cho AI của phiên.
- **Tự cho phép khi được phép.** `advisor_weigh` được tự cho phép (không thẻ duyệt) chỉ khi chế độ tự động bật hoặc thread là ADVISOR; tắt thì
  từ chối không thẻ. Phiên làm việc gọi `advisor_git`/`advisor_grep` cũng bị từ chối không thẻ.
- **Ngưỡng `confident`:** phương án cao nhất ≥ 0,6, hơn phương án nhì ≥ 0,2 và độ tin của Jev ≥ 0,5 (`advisor-verdict.ts`); còn lại `unsure`.
  AI chỉ làm theo khi `confident` và việc không phá huỷ, trong phạm vi yêu cầu; còn lại hỏi người dùng. Kết quả là `AdvisorVerdictItem` gắn
  `tool_id` và `turn_id`; lượt `COMPLETED` không hỏi `next_steps` thì có `advisor_missed`. Chip gợi ý bấm là gửi, khoá khi lượt chạy hoặc đã có
  tin mới sau thẻ, không bao giờ mang lệnh `/` hay `!`.
- **Văn phòng:** Cố vấn ngồi ghế đầu bàn Phòng họp (`meeting-0`) khi chế độ tự động bật, không theo lịch sống, không trò chuyện; bố cục tầng không
  đổi để giữ ảnh đã bake. Khung không mang tên hay ngoại hình: web lấy từ hồ sơ của người xem. Mọi cảnh suy từ journal nên dựng lại được
  ([`office-wire.md`](../office-wire.md)).
- **Thứ tự phát hành: server → web → tunelo.** Web phát hành trước biết bỏ vai trò văn phòng lạ và thread ADVISOR; tunelo mới chỉ gửi những thứ đó
  cho thiết bị báo đã biết (`OfficeWatch.advisor_role`, `ThreadList.advisor`). Web mới gặp tunelo cũ thì mascot ngủ kèm "Máy cần cập nhật tunelo".

## Hệ quả

- Mỗi câu hỏi tốn token của AI người dùng đang dùng (một lượt điều tra trong phiên Cố vấn) và một lời gọi Jev bằng khoá của người dùng; chế độ
  tự động thêm ít nhất một lời gọi mỗi lượt. Ngữ cảnh thread Cố vấn giữ chung cho mọi câu hỏi trong cùng (máy, thư mục, AI), nên câu sau không phải
  đọc lại từ đầu nhưng ngữ cảnh của thread lớn dần.
- `claude --resume` của người dùng trên máy vẫn thấy các phiên Cố vấn (Claude tự ghi transcript); app loại chúng khỏi danh sách và lịch sử phiên
  local nhưng không xoá được ở chỗ của Claude.
- Câu hỏi đang chờ cùng đính kèm nằm trên đĩa của máy tới khi bắt đầu chạy; dữ liệu và thời hạn: [`privacy/data-inventory.md`](../privacy/data-inventory.md).
- Cố vấn chỉ có trên chat-next cá nhân; adapter AI mới có Cố vấn khi có MCP phiên và (cho phiên Cố vấn) xin quyền từng tool.
