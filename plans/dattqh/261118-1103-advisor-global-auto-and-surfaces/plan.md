# Cố vấn: tự theo dõi cấp global và bề mặt cắm được cho mọi service

Tier: L (đổi proto + agent + web, một hợp đồng mới cho các màn). Trạng thái: việc 2 đã làm xong (18/11/2026, chọn công tắc theo tài khoản); việc 3 đã làm các bước 2-3 và bề mặt danh bạ/bot (18/11/2026); đích "Điền vào ô soạn tin" của chat đã làm; còn hỏi khi không có máy B.

## Hiện trạng (đã đọc code, 18/11/2026)

- Mascot đã có trên mọi màn sau đăng nhập (`advisor-mascot.tsx`, ADR 0020), kể cả chat, danh bạ, bot (`CHAT_ROUTES`). Copy ở các màn này được giữ,
  nhưng ngữ cảnh chỉ ghi "chat" (không id, không tên).
- Hỏi Cố vấn luôn đi qua **máy B**: `ThreadCreate{kind: ADVISOR, dir, provider}` rồi `ThreadSend`. Nghĩa là mọi câu hỏi cần một máy có AI + khoá Jev,
  và chạy trong một **thư mục**. Màn chat/danh bạ/bot không có thư mục nên hỏi từ đó rơi về thư mục tạm.
- Ngữ cảnh (`CopyContext`) là các trường cố định hướng lập trình: máy, thư mục, nhánh, phiên, khung, thao tác, mã lỗi, `failure_id`.
  Màn khác muốn nói thêm điều gì (cuộc trò chuyện nào, bot nào, liên hệ nào) thì phải sửa proto `AdvisorContext` + máy B.
- "Gửi sang phiên" chỉ biết một đích: ô nhập của phiên AI Agent (`store.fill(machine, threadId, text)`).
- "Tự theo dõi" là cờ **theo thread** trên máy B (`meta.advisor`, `ThreadSetAdvisor`), bật từ menu mascot cho phiên đang mở.

## Việc 2: Tự theo dõi cấp global

Khuyến nghị: **cấu hình ở máy B, một công tắc chung trong Cài đặt › Cố vấn**, bỏ công tắc trong menu mascot.

- Máy B giữ `advisorAuto` (một giá trị cho cả máy, lưu cạnh `advisor-secrets.json`), `autoAdvisor(t)` = `advisorAuto` (thay cho `meta.advisor`).
  Phiên mở ở terminal, phiên cũ và phiên tạo từ thiết bị khác đều theo ngay, không phải bật từng phiên.
- Proto: `AdvisorSetAuto{bool on}` (A → B, Ack) và `MachineInfo.advisor.auto`. `ThreadInfo.advisor` giữ lại, nay phản ánh cờ chung, nên
  thiết bị cũ vẫn hiện đúng.
- Cài đặt › Cố vấn: một công tắc "Tự theo dõi mọi phiên" gửi tới mọi máy đang online; máy offline lấy giá trị khi nó nối lại (thiết bị đối chiếu
  `MachineInfo.advisor.auto` với giá trị tài khoản lúc nối). Giá trị tài khoản nằm trong `advisor_profiles` (cột mới, đồng bộ mọi thiết bị).
- Công tắc theo phiên bỏ hẳn (không hai tầng, tránh "bật ở đâu thì thắng"). Phiên của AI không có MCP phiên vẫn không bật được: công tắc chung ghi
  rõ máy nào chưa áp dụng được (đã có `advisor.available`, `caps.sessionMcp`).

Quyết định cần đại ca xác nhận: **tài khoản hay máy**. Tài khoản (trên) là "global" thật, đổi một lần cho ba máy, nhưng cần đối chiếu khi nối.
Chỉ-máy đơn giản hơn nhưng phải bật ở từng máy trong phần khoá.

Cờ theo phiên cũ (`meta.advisor`) không cần migration: máy vẫn cộng cờ đó với công tắc chung (bật một trong hai là bật), nên phiên đã bật vẫn bật và thiết bị cũ vẫn dùng `ThreadSetAdvisor`.

## Việc 3: Cố vấn làm nền tảng cho mọi service

Mục tiêu: một service mới (chat, danh bạ, bot, kb, clip…) cắm vào Cố vấn bằng **khai báo**, không sửa lõi Cố vấn, không sửa proto mỗi lần.

Hợp đồng bề mặt (surface), phía web:

```ts
registerAdvisorSurface({
  id: "contacts",                       // định danh ổn định, dùng làm screen
  describe(scope): { label, subject? }, // một dòng cho chip/dòng "Đính kèm ghi ..."
  redact?(text): string,                // service tự che dữ liệu nhạy cảm của nó
  accepts?: ["answer-text"],            // đích nhận câu trả lời
  apply?(answer): void,                 // "Gửi sang…" của service (điền ô soạn tin, ô ghi chú…)
})
```

- `ScopeContext` mở rộng thành `{ surface, subject, fields: Record<string, string> }`; các trường lập trình hiện tại (dir, branch, failureId…) trở thành
  `fields` của surface `session`/`scm`. Proto `AdvisorContext` thêm `map<string,string> fields` (chỉ thêm, không phá).
- Máy B nhận `surface` + `fields` như dữ liệu không tin cậy, bọc cùng dấu ngăn hiện có; không surface nào được thêm quyền (guard chỉ-đọc không đổi).
- Hỏi không cần thư mục: surface khai `needsDir: false`, máy B chạy phiên Cố vấn trong thư mục tạm riêng (đã có đường "dir rỗng").
- "Gửi sang…" đa đích: `store.fill` tổng quát thành `store.deliver(target, text)`, mỗi surface đăng ký đích của mình (ô soạn chat, ô ghi chú bot).
- Quy tắc riêng tư giữ nguyên làm hợp đồng chung: `data-advisor-ignore`, mẫu bí mật dùng chung, bộ nhớ trang, không lưu.
- Server chat KHÔNG xem nội dung (vẫn chỉ qua máy B, mã hoá đầu cuối). Service muốn hỏi mà không có máy B (người dùng không có máy) là
  quyết định riêng, ngoài phạm vi: cần chỗ chạy AI khác và quyết định BYOK.

Các bước (mỗi bước độc lập, theo thứ tự):
1. Việc 2 (proto `AdvisorSetAuto`, agent, Cài đặt, bỏ công tắc theo phiên, migration cờ cũ).
2. Registry bề mặt + chuyển `session`, `scm`, `terminal` sang đăng ký (giữ nguyên hành vi, test hiện có là lưới an toàn).
3. Proto `fields`, máy B bọc `fields` làm nội dung không tin cậy.
4. Bề mặt thử đầu tiên: `chat` (đoạn tin nhắn, đích "điền ô soạn tin").
5. Danh bạ, bot dùng cùng hợp đồng.

Ngoài phạm vi: Cố vấn tự chạy không cần người hỏi ở màn chat, và bề mặt cho service chạy ngoài app Chat.

## Tiêu chí nghiệm thu

- Bật một công tắc trong Cài đặt, mọi phiên trên máy đã chọn (kể cả phiên terminal đang mở lại) tự hỏi Cố vấn; menu mascot không còn công tắc phiên.
- Thêm một bề mặt mới chỉ cần một lần gọi `registerAdvisorSurface` và một khai báo `useAdvisorScope`, không sửa `advisor-bubble.tsx`, không sửa guard máy B.
- Mọi test Cố vấn hiện có qua; test mới cho thứ tự ưu tiên khi hai công tắc cũ/mới xung đột (migration).

## Câu hỏi chưa chốt

- Tài khoản hay máy cho công tắc global (xem trên).
- Chat/danh bạ/bot hỏi Cố vấn khi người dùng không có máy B nào: để sau hay làm hướng khác?
