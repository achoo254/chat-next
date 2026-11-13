# ADR 0017: AI Agent không gắn với một AI, Antigravity qua ACP

- Trạng thái: Đã chấp nhận
- Ngày: 2026-11-13
- Bổ sung [ADR 0013](./0013-remote-machines.md) và [ADR 0014](./0014-tunelo-machine-agent.md).

## Bối cảnh

AI Agent sinh ra với một AI (Claude Code). Lõi `tunelo`, proto và web có nhiều chỗ mặc định hoặc rẽ nhánh theo `"claude"`:
`provider || "claude"`, chuỗi `bypassPermissions`, `claude_version` trong heartbeat, "Claude on %s" trong push, `ClaudeProfile`
trong proto, `CLAUDE_MODES` trên web. Chủ sở hữu chốt ngày 13/11/2026 thêm Antigravity (`agy` của Google) làm AI thứ hai, theo
cách Orca IDE làm, và không giữ tương thích với agent hoặc web bản cũ (chưa có người dùng ngoài chủ sở hữu).

## Quyết định

- Không có AI mặc định. Yêu cầu mở hoặc liệt kê phiên phải nêu AI (`ERROR_REASON_PROVIDER_REQUIRED`); dự án lưu AI của nó
  (`ProjectDefaults.provider`).
- Thứ riêng của từng AI nằm trong adapter (`apps/agent/src/providers/<ai>/`) và lộ ra bằng capability trung lập:
  `permission_modes`, `bypass_mode_id` (chế độ không hỏi gì, chỉ giữ được khi chính cài đặt của máy khởi động ở đó),
  `session_mcp`, `accounts`, `terminal`, `commit_message`. Lõi và web chỉ đọc capability.
- Tài khoản là facet `accounts` của adapter (`AccountsFacet`): mỗi AI một danh sách, một lựa chọn; trạng thái tài khoản trong
  lõi khoá theo `(provider, id)`, đổi tài khoản AI này không đụng phiên AI khác. Một tệp chung `ai-accounts/ai-accounts.json`
  không chứa credential; đường dẫn suy từ `(provider, id)` đã kiểm. Proto: `AiAccount`, `Account*`, `MachineAccounts`.
- Push "cần bạn" mang `provider_id`; server tra tên từ bảng cố định của nó, id lạ hoặc nhiều AI gộp trong một cửa sổ thì nói
  "AI". `claude_version` bị bỏ khỏi heartbeat, server và schema (migration `0040`).
- Antigravity chạy `agy acp` của máy qua một client ACP dùng chung (JSON-RPC theo dòng qua stdio), không tải binary ACP của
  Google. Một tiến trình `agy acp` cho mọi phiên. `toolPermission: "always-proceed"` của agy là "máy tự bật toàn quyền".
  "Luôn cho phép" chỉ nhớ phía tunelo. Bản đầu không có MCP `tunelo` và mật khẩu đã lưu cho Antigravity.
- Tài khoản Antigravity: agy giữ một đăng nhập chung trong Keychain (spike 13/11: không có cách lưu đăng nhập theo thư mục),
  nên đổi tài khoản là ghi đăng nhập đã lưu vào Keychain có bảo vệ (tuần tự, đọc lại để kiểm, đặt lại khi sai) và bị từ chối
  khi agy đang chạy (`ERROR_REASON_ACCOUNT_SWITCH_BLOCKED`).

## Hệ quả

- Thêm AI mới (Codex) là thêm adapter và một dòng ở registry, qua bộ test hợp đồng; không sửa lõi hay web.
- Agent, web và server phát hành cùng lúc; máy đang chạy bản cũ phải gỡ và cài lại, tài khoản Claude đăng nhập lại.
- Đổi tài khoản Antigravity ảnh hưởng mọi `agy` của người dùng trên máy (kể cả ngoài tunelo), nên chỉ làm khi không có agy chạy.
- Google có thể hạn chế tài khoản dùng client bên thứ ba; chấp nhận như Orca.
