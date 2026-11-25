# ADR 0028: AI ngay trong hội thoại

Trạng thái: **đã chấp nhận** (25/11/2026, đại ca duyệt qua ba vòng hỏi), cài đặt theo [plan](../../../plans/dattqh/261125-0811-chat-ai-in-conversation/plan.md). Dựa trên [ADR 0012](./0012-mcp-endpoint.md) (MCP của Chat), [ADR 0013](./0013-remote-machines.md) và [ADR 0014](./0014-tunelo-machine-agent.md) (máy B), [ADR 0017](./0017-provider-neutral-ai-agent.md) (AI trung lập), [ADR 0026](./0026-session-mcp-over-loopback-http.md) (MCP của phiên).

## Bối cảnh

AI Agent đã chạy được trên máy B và mỗi phiên đã có nhóm tool `chat` (đọc chat, tìm tin, gửi tin qua thẻ duyệt). Nhưng muốn hỏi AI về một tin Telegram, người dùng phải rời hội thoại, sang `/ai`, rồi tự chép ngữ cảnh. Đại ca muốn hỏi AI ngay tại hội thoại và theo từng tin, và để AI đọc dữ liệu của Chat và Knowledge Base.

## Quyết định

- **AI chỉ chạy trên máy B của người dùng**, qua AI Agent sẵn có, bằng tài khoản AI của họ. Server không chạy AI, không giữ key AI. Máy tắt thì panel báo, không có dự phòng phía server.
- **Mỗi hội thoại một phiên.** `ThreadCreate.chat` (`ChatLink`: `chat_id`, tên, app) mở hoặc dùng lại đúng một phiên của chat đó; `dir` rỗng thì máy dùng thư mục riêng `chat-sessions/<chat_id>` trong dữ liệu của tunelo. `ThreadSummary.chat_id` cho thiết bị tìm lại phiên. Phiên hiện cả ở `/ai`. Máy cũ bỏ qua trường này; thiết bị thấy `chat_id` trả về bằng 0 thì báo cập nhật tunelo.
- **Ngữ cảnh đi trong tin đầu** do thiết bị soạn (tên, app, `chat_id`, luật), không thêm cơ chế lời dặn hệ thống riêng cho từng AI.
- **Panel cạnh hội thoại** (máy tính: panel phải kéo được độ rộng; điện thoại: sheet gần full màn). Mục «Hỏi AI» trong menu tin, lệnh `/ai …` trong ô soạn tin. Kết quả của AI không bao giờ vào luồng tin của hội thoại.
- **Bản nháp không qua tool.** Nút «Đưa vào ô soạn tin» chép câu trả lời vào ô soạn; người dùng tự gửi như tin thường. AI chỉ gửi khi người dùng yêu cầu rõ, luôn qua tool có thẻ duyệt.
- **Cờ «ẩn với AI» theo từng chat** (`chat_members.hidden_from_ai`, `Dialog.hidden_from_ai`, `SetDialogHiddenFromAI`, `UpdateDialogHiddenFromAI`). Chặn ở `/mcp`, một chỗ chung: tool nhận `chat_id`, `from_chat_id`, `to_chat_id`, `hook_id` (webhook gửi vào chat đó) hoặc `update_ids` (thư chết của bot) thuộc chat bị ẩn thì bị từ chối (`chat_hidden_from_ai`), `start_private_chat` cũng vậy khi chat 1-1 tìm được đang ẩn; tool trả nhiều chat thì lọc bỏ chat ẩn và những người chỉ chat ẩn nhắc tới. Rời chat không bỏ cờ. MCP không có tool đổi cờ này. Migration tách theo bảng (index dựng `CONCURRENTLY`, ràng buộc của `outbox` thêm `NOT VALID` rồi `VALIDATE`) để không khoá ba bảng lớn cùng lúc.
- **Tin gửi qua `/mcp` mang dấu `sent_via_ai`**, chỉ người gửi thấy (nhãn «qua AI»); người khác và app bridge không thấy. Không có chữ ký gửi cho người nhận.

## Hệ quả

- Không thêm trạng thái AI trên server; dữ liệu phiên vẫn nằm trên máy B và đi mã hoá đầu cuối.
- Mọi client MCP (không chỉ tunelo) đều chịu cờ «ẩn với AI».
- Giai đoạn sau (gửi tệp, kb, đẩy tin đến vào phiên) theo plan; tự động trả lời không cần duyệt nằm ngoài phạm vi.
