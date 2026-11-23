# ADR 0026: MCP của phiên đi qua HTTP loopback của dịch vụ

Trạng thái: **đã chấp nhận** (23/11/2026, đại ca duyệt kế hoạch). Thay cách nối MCP `tunelo` mô tả ở [ADR 0013](./0013-remote-machines.md#mcp-của-tunelo-trong-phiên-claude-09112026) và `tunelo-advisor` ở [ADR 0020](./0020-advisor-mascot-jev.md) cho Claude. Vé, nhóm tool, duyệt ghi và lời gọi không vé giữ nguyên.

## Bối cảnh

Đo ngày 23/11/2026 trên Mac mini, tunelo 3.24.0:

- Mỗi phiên AI do tunelo mở, cả phiên chat lẫn CLI ở terminal có Cố vấn, chạy một tiến trình `tunelo mcp` riêng. Mỗi tiến trình chiếm khoảng 43–46 MB.
- Tiến trình này chỉ là proxy stdio: mọi lệnh gọi tool chuyển tiếp qua kênh điều khiển (`/mcp/session`, `/mcp/tools`, `/mcp/call`) tới `McpHost` trong dịch vụ. Nó tốn RAM vì nạp cả binary Bun 92 MB.
- Cùng lúc đó, `tunelo-term-host` (Rust) giữ năm terminal chỉ với 17 MB.

## Quyết định

**Dịch vụ tự phục vụ MCP.** Dịch vụ phục vụ MCP Streamable HTTP trên `127.0.0.1:<cổng ngẫu nhiên>/mcp` (`apps/agent/src/mcp/session-mcp-http.ts`), trên một listener riêng, không gộp với kênh điều khiển.

**Xác thực bằng vé của phiên.**
- Mỗi request gửi `Authorization: Bearer <vé>`.
- Vé không sống thì trả 401.
- `Host` khác `127.0.0.1:<cổng>` thì trả 403, để chặn trang web dùng DNS rebinding.
- Phiên MCP của vé này không dùng được vé khác.

**Danh sách tool và lệnh gọi giống hệt bản stdio.**
- Phần đăng ký tool được gom vào `mcp/session-tool-registry.ts`. Cả `tunelo mcp` lẫn endpoint HTTP đều dùng chung hàm này.
- Chế độ được suy từ vé (`McpHost.toolMode`): `session`, `advisor` (thread của Cố vấn) hoặc `weigh` (CLI ở terminal, chỉ có `advisor_weigh`).
- Mọi lệnh gọi chạy qua `McpHost.call`, nên duyệt ghi, từ chối và che token đều đúng như trước.

**Vòng đời.**
- Phiên MCP đóng khi client gửi `DELETE` hoặc khi vé bị thu hồi (`McpHost.onRelease`). Tunnel do phiên mở đóng theo.
- Mỗi vé giữ tối đa 4 phiên MCP; client nối lại mà không xoá phiên cũ thì phiên cũ nhất bị đóng.
- Không có luồng SSE (`GET` trả 405), vì tunelo không gửi thông báo chủ động.

**Vé không còn nằm trong argv.**
- `--mcp-config` (terminal) và `mcpServers` (SDK) chỉ ghi `Authorization: Bearer ${TUNELO_MCP_HTTP_TICKET}`. Giá trị thật nằm trong biến môi trường của tiến trình claude.
- Đã thử: Claude Code 2.1.330 thay `${VAR}` trong header.
- Biến này cố ý khác `TUNELO_MCP_TICKET`. Lý do: một `tunelo mcp` mà người dùng tự thêm vào CLI thừa hưởng môi trường của claude; nếu dùng chung tên, nó sẽ lấy vé của phiên làm vé của mình và hỏng, ví dụ chỉ còn `advisor_weigh`.

**Không đi qua proxy.**
- Đã thử: khi có `HTTP(S)_PROXY`, Claude Code 2.1.330 gửi request MCP http tới `127.0.0.1` qua proxy, kèm cả header `Authorization`. Thêm `NO_PROXY=127.0.0.1` thì nó gọi thẳng.
- Vì vậy môi trường của claude luôn có `NO_PROXY`/`no_proxy` chứa `127.0.0.1,localhost`, cộng thêm vào giá trị sẵn có:
  - phiên SDK: agent thêm (`loopbackNoProxy`);
  - phiên terminal: `tunelo-term-host` thêm khi nhận vé.

**Terminal và `term-host`.**
- `tunelo-term-host` từ control `minor` 2 nhận `TUNELO_MCP_HTTP_TICKET` trong `env` của `open` (16–128 ký tự base64url, `docs/terminal-wire.md`).
- Daemon cũ có thể vẫn chạy sau khi cập nhật (`replaceIfIdle`). Agent đọc `minor` từ `hello`; daemon dưới 2 thì CLI mở với MCP qua stdio như cũ, không gửi biến này.

**Cổng chuyển tiếp localhost.** Cổng của endpoint được thêm vào danh sách cổng của chính tunelo mà `/.tunelo/forward` từ chối.

**Dự phòng và ngoài phạm vi.**
- Dịch vụ không mở được cổng thì phiên quay về `tunelo mcp` qua stdio như cũ.
- Antigravity (ACP) giữ stdio, vì chưa xác minh agy nhận MCP kiểu http.
- `claude mcp add tunelo -- tunelo mcp` (không vé) giữ nguyên.

## Hệ quả

- Mỗi phiên bớt một tiến trình khoảng 45 MB. Dịch vụ chỉ thêm một `McpServer` cho mỗi phiên.
- **Vé là bearer của phiên.** Ai cầm vé thì chạy được tool đọc của phiên (Chat, Localman, tunnel) và tool ghi khi thiết bị đã duyệt. Trước đây cũng vậy với tiến trình cùng user (đọc vé qua `ps` rồi gọi kênh điều khiển bằng `control.json`).
  - Khác trước: vé một mình đã đủ để gọi qua TCP loopback.
  - Vì thế vé được đưa ra khỏi argv. User khác trên cùng máy không đọc được biến môi trường của tiến trình người khác (macOS, và `/proc/<pid>/environ` trên Linux).
  - Bash trong chính phiên vẫn đọc được vé. Chạy `env` thì vé vào transcript của phiên. Vé hết hạn cùng phiên.
- Agent mới chạy được với `tunelo-term-host` cũ (quay về stdio cho terminal). `term-host` mới chạy được với agent cũ (agent cũ không gửi biến này).
