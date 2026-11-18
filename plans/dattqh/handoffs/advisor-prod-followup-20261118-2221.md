---
handoff-version: 1
generated: 2026-11-18T15:21:00Z
generator: ak-handoff
focus: "ghi ra rồi commit và push để làm tiếp trên máy Windows"
workspace: chat-next
branch: main
head: a7663ab3
---

# HANDOFF: Cố vấn — công tắc tự theo dõi, khoá khi đang hỏi, bấm câu trả lời về đúng phiên

## Mission and current status

Yêu cầu của người dùng: "ghi ra rồi commit và push để làm tiếp trên máy Windows".

Kết quả mong muốn: mọi thay đổi Cố vấn của ngày 18/11/2026 chạy đúng trên prod, được người dùng xác nhận trên giao diện thật (web và PWA), rồi đóng việc.

Done:
- Công tắc "Tự theo dõi mọi phiên" (Cài đặt › Cố vấn) lưu được trên tài khoản. Mac mini đã nhận giá trị. PWA đã bật được sau khi tải lại.
- Commit `edc9766c`: khi một câu hỏi của tab đang chờ trả lời (`busy`), Cố vấn không ghi nhận đoạn copy mới, không hiện dòng tóm tắt hay chấm báo của phiên khác. Đã lên prod (bundle công khai chứa `remember(e,t){if(this.state.busy)return`).
- Commit `b82cfa7f`: bấm một câu trả lời trong "Câu trả lời gần đây" về đúng phiên của câu trả lời, không về trang đang mở lúc câu trả lời đến (hàm `pageOfSession`). Đã push lên `origin/main`.

Remaining:
- Xác nhận `b82cfa7f` đã lên prod (xem Verification) và người dùng thử bấm câu trả lời trên giao diện thật.
- Người dùng tự chạy `tunelo update` trên máy PC (cần từ 3.20.0 trở lên, mới nhất 3.21.0) để máy đó nhận công tắc.

Urgency: thấp. Không có sự cố đang diễn ra.

## Scope and guardrails

Workspace: repo `chat-next`, nhánh `main`, làm trực tiếp trên nhánh hiện tại.

In scope: phía web của Cố vấn trong `apps/web/src/advisor/` và test tương ứng; theo dõi CI và deploy của các commit trên.

Out of scope: code bridge (`server/internal/bridge/**`) và các file giao diện đang sửa dở của phiên bridge. Không sửa, không stage, không revert chúng.

Constraints (người dùng đã quyết):
- Khoá toàn bộ khung Cố vấn khi có câu hỏi đang chạy (không chỉ chặn câu thứ hai).
- Cố vấn xử lý từng câu một, không bất đồng bộ.
- Không tạo nhánh, worktree hay PR trừ khi người dùng yêu cầu.
- Commit theo conventional commit, không nhắc tới AI, không để mã kế hoạch hay mã audit trong tên test hay commit.

Safety boundaries:
- Chỉ stage đúng file của việc đang làm. Kiểm `git diff --cached` trước mỗi commit (nhiều phiên dùng chung thư mục).
- Không ghi địa chỉ máy chủ, khoá, đường dẫn credential vào repo (repo công khai).
- Không chạy test nặng song song. Giới hạn worker khi chạy toàn bộ test.

## Current state

Branch: `main`.

HEAD: `a7663ab3` lúc ghi (local chậm hơn `origin/main` 2 commit: `67378405`, `638c8b52`, đều của phiên khác về office).

Working tree: 4 file sửa dở thuộc phiên khác, không phải của việc này:
- `apps/web/src/machines/project-tree-view.tsx`
- `apps/web/src/messaging/ui/dialogs.tsx`
- `apps/web/src/styles/messaging.css`
- `apps/web/test/visual/render-check.ts`

Untracked files: tệp bàn giao này.

Intentional local modifications: no (đối với việc Cố vấn). Bốn file trên là của phiên khác.

Các commit của việc này, đều đã nằm trên `origin/main`:
- `edc9766c` fix(advisor): khoá Cố vấn khi một câu hỏi đang chờ.
- `b82cfa7f` fix(advisor): bấm câu trả lời về đúng phiên.

## Decisions and rationale

| Decision | Rationale | Alternative rejected | Reference |
| --- | --- | --- | --- |
| Khoá toàn bộ khung khi có câu hỏi đang chạy | Đúng ý "từng câu một"; sửa ở giao diện, ít rủi ro cho máy | Chỉ chặn câu thứ hai; xếp hàng ở máy (sửa tunelo và hợp đồng giao tiếp) | `apps/web/src/advisor/advisor-store.ts` (`busy`, `remember`) |
| `target` của câu trả lời là địa chỉ của chính phiên đó | Địa chỉ trang đang mở lúc ghi nhận có thể là phiên khác hoặc màn khác khi mở nhiều tab hoặc chia khung | Giữ `window.location` như cũ | `apps/web/src/advisor/use-advisor-presence.ts` (`pageOfSession`) |
| Không sửa lỗi lint hay test của bridge | Thuộc phiên bridge đang hoạt động, người dùng chọn để phiên đó xử lý | Sửa chen vào | CI run của `d7d102d4`, `4db5514b` |
| Dùng `git pull --rebase --autostash` khi cây làm việc có file của phiên khác | Rebase thường bị từ chối; đã so mã băm `git diff` trước và sau để chắc file của phiên khác không đổi | Stash tay, hoặc tạo worktree | lệnh đã chạy ở phiên này |

Nguyên nhân gốc của "bấm không về đúng phiên" là một giả thuyết suy ra từ mã. Chưa tái hiện được lỗi trên giao diện thật.

## Work performed

- Điều tra công tắc không bật được. Loại trừ: mã web, bundle prod, mô tả proto, logic server (chạy test tạm qua lớp RPC thật, rồi xoá), schema prod. Lần bật thất bại đầu là do trạng thái cũ của trang quanh lúc đổi bản; tải lại thì chạy.
- Phát hiện Mac mini chạy tunelo 3.19.0 không có khung `AdvisorSetAuto`; sau khi người dùng cập nhật thì Mac mini nhận giá trị.
- Thêm cờ `busy` vào `AdvisorStore`, chặn `remember()` khi `busy`, bỏ qua dòng tóm tắt và chấm báo khi `busy`. Thêm `apps/web/test/advisor/advisor-busy.test.ts`.
- Thêm `pageOfSession` và dùng nó cho `target` của câu trả lời. Thêm `apps/web/test/advisor/advisor-verdict-page.test.ts`.
- Commit và push cả hai. Với `b82cfa7f` phải rebase `--autostash` vì có 3 commit mới của bridge.
- Theo dõi CI và deploy. Hai lần CI đỏ do lỗi của bridge (lint `QF1001` ở `server/internal/bridge/contracttest/conformance.go`, sau đó phiên bridge tự sửa; rồi hai test chập chờn trong `server/internal/bridge/engine`).

0 redactions applied.

## Verification

| Check | Command | Outcome | When |
| --- | --- | --- | --- |
| Test Cố vấn (web) | `cd apps/web && npx vitest run test/advisor --maxWorkers=2` | 10 file, 90 test qua | sau khi rebase, trước khi push `b82cfa7f` |
| Kiểu | `cd apps/web && npx tsc --noEmit` | không báo lỗi | trước khi commit |
| Lint | `cd apps/web && npx eslint --max-warnings=0 src/advisor test/advisor/<file>` | không báo lỗi | trước khi commit |
| `edc9766c` trên prod | tải bundle công khai và tìm `remember(e,t){if(this.state.busy)return` | thấy trong chunk `advisor-store` | khoảng 21:42 ngày 18/11 |
| CI của `b82cfa7f` | `gh run view 44330799398` | đỏ: job `go`, hai test của `server/internal/bridge/engine`; các job còn lại xanh | 22:09 |
| CI của `a7663ab3` | `gh run view 44332158684` | xanh | 22:20 |

Not run:
- Toàn bộ test suite của web và Go: chỉ chạy test Cố vấn, vì thay đổi chỉ nằm trong thư mục Cố vấn.
- Thử trên giao diện thật khi có câu hỏi đang chạy rồi đổi phiên: chưa làm.
- Thử bấm câu trả lời gần đây trên giao diện thật sau khi deploy bản `b82cfa7f`: chưa làm.

Lưu ý quan trọng khi đọc danh sách deploy: nhãn `headSha` của một lần chạy deploy là sha của nhánh lúc kích hoạt, không phải sha được deploy. Bản thật nằm ở bước checkout `ref:` trong log của run đó. Một lần chạy mang nhãn `b82cfa7f` thực chất đã deploy `5f991b06`.

## Open risks and blockers

- Type: risk. Owner: unknown. Impact: không biết `b82cfa7f` đã lên prod chưa. Lúc ghi, CI của `a7663ab3` (chứa `b82cfa7f`) đã xanh và một lần deploy (run `44334213214`) đang chạy; chưa xác minh sha được checkout của nó.
- Type: risk. Owner: phiên bridge. Impact: hai test của `server/internal/bridge/engine` chập chờn (`TestWhileAChangeWaitsToGoOutTheOtherAppsOlderStateDoesNotOverwriteIt` đã thất bại hai lần, một lần qua khi chạy lại; `TestRenamingAndClosingATopicInChatReachTheOtherAppAndStayThere`). Có thể chặn deploy bất cứ lúc nào.
- Type: question. Owner: người dùng. Impact: máy PC cần `tunelo update` lên 3.20.0 trở lên thì mới nhận công tắc; người dùng nói sẽ tự làm.
- Type: question. Owner: người dùng. Impact: chưa rõ lỗi "bấm câu trả lời không về đúng phiên" có hết sau bản sửa không (nguyên nhân mới là giả thuyết).
- Type: risk. Owner: unknown. Impact: các mục lịch sử đã nằm sẵn trong tab trước khi sửa vẫn mang địa chỉ cũ cho tới khi tải lại trang.

## Exact next actions

1. **First safe step**: đồng bộ rồi xem trạng thái CI và deploy, chưa sửa gì: `git fetch && git log origin/main --oneline -6 && gh run list --limit 8`. Để biết sha thật của một lần deploy: `gh run view <id> --log | grep -E "ref: [0-9a-f]{40}"`.
2. Xác minh bản trên prod chứa `pageOfSession`. Tải bundle công khai của web, tìm chunk `use-advisor-presence` hoặc chunk Cố vấn và tìm chuỗi `/s/` ghép với `startsWith`. Nếu chưa có thì chưa deploy xong hoặc bị chặn.
3. Nếu deploy bị chặn bởi CI đỏ ở bridge: hỏi người dùng có muốn chạy lại job `go` hay chờ phiên bridge. Không tự sửa file bridge khi phiên bridge còn hoạt động (kiểm mốc sửa file gần nhất và commit mới trên `origin/main`).
4. Khi `b82cfa7f` đã lên prod, báo người dùng tải lại web và PWA (Cmd+R, hoặc bấm thanh "Đã có bản mới"), rồi thử bấm một câu trả lời trong "Câu trả lời gần đây" khi đang ở màn khác. Nếu vẫn sai, hỏi: bấm xong trang hiện ra là gì (cùng màn Cài đặt hay một phiên khác) để chốt nguyên nhân.
5. Đóng việc khi người dùng xác nhận cả công tắc và câu trả lời đều đúng. Không cần ADR, tài liệu hiện có đã mô tả công tắc ở ADR 0020.

## Source pointers

- `apps/web/src/advisor/advisor-store.ts`: trạng thái Cố vấn (`busy`, `remember`, `setBusy`).
- `apps/web/src/advisor/use-advisor-presence.ts`: câu hỏi đang chờ, `useVerdictFlash`, `pageOfSession`.
- `apps/web/src/advisor/advisor-bubble.tsx`: khung hỏi, `RecentAnswers` (xử lý bấm câu trả lời).
- `apps/web/src/screens/settings/advisor-settings.tsx`: công tắc "Tự theo dõi mọi phiên".
- `apps/web/src/advisor/use-advisor-auto-sync.ts`: đẩy giá trị công tắc xuống từng máy.
- `apps/web/test/advisor/advisor-busy.test.ts`, `apps/web/test/advisor/advisor-verdict-page.test.ts`: test mới.
- `docs/adr/0020-advisor-mascot-jev.md`: quyết định về công tắc tự động theo tài khoản.
- `.github/workflows/deploy.yml`: deploy chạy sau CI xanh và checkout `workflow_run.head_sha`.
- Lệnh trên Windows (đường dẫn thư mục theo ghi chú riêng của người dùng): chạy test Go của chat-next trong WSL bằng tài khoản riêng, theo ghi chú vận hành; test web chạy trực tiếp bằng `npx vitest` trong `apps/web`. Credential prod đọc qua biến môi trường `ALL_IN_ONE_STAGING_DEV` của kỹ năng `chat-ops-prod` (`.claude/skills/chat-ops-prod/scripts/`); phiên macOS gần đây bị chặn đọc tệp này, nên có thể cần quyền truy cập lại.
