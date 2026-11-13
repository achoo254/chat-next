// A turn's line and its details, a subagent's edits in the transcript, the
// "Thay đổi" panel with git's part and the AI's part, a question that
// expired with a restart of the machine, and the sites of the secrets a
// command reads on its approval card.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
	ApprovalItemSchema,
	GitChangesSchema,
	GitFileChangeSchema,
	GitFileState,
	ItemSchema,
	PromptState,
	QuestionItemSchema,
	Role,
	ToolKind,
	TurnItemSchema,
	TurnState,
	type GitFileChange,
	type Item,
} from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { ApprovalCard, siteLabel } from "../../src/machines/cards/approval.tsx";
import { QuestionCard } from "../../src/machines/cards/question.tsx";
import { TurnLine, costText, durationText, turnText } from "../../src/machines/cards/turn-line.tsx";
import { ChangesPanel, changesCount } from "../../src/machines/changes-panel.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { sessionChanges } from "../../src/machines/transcript/changes.ts";
import { foldTranscript } from "../../src/machines/transcript/tool-fold.ts";

type Body = NonNullable<MessageInitShape<typeof ItemSchema>["body"]>;

/** The copy buttons of diffs announce through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;
const wrap = (node: ReactNode) =>
	render(
		<I18nProvider>
			<ServicesContext value={services}>{node}</ServicesContext>
		</I18nProvider>,
	);

let seq = 0n;
function item(id: string, at: number, body: Body): Item {
	seq += 1n;
	return create(ItemSchema, { id, seq, revision: 1, at: BigInt(at), provider: "claude", model: "", body });
}
const user = (text: string): Body => ({ case: "text", value: { role: Role.USER, text } });
const call = (toolId: string, kind = ToolKind.SHELL, name = "Bash"): Body => ({ case: "toolCall", value: { toolId, kind, name, summary: name, input: "{}" } });
const diff = (toolId: string, path: string, parentToolId = ""): Body => ({ case: "diff", value: { toolId, path, unified: "--- a/x\n+++ b/x\n@@\n-a\n+b", added: 1, removed: 1, parentToolId } });

describe("a turn's line", () => {
	it("reads the time like a person says it", () => {
		expect(durationText(45_200, viMachines, "vi")).toBe("45,2 giây");
		expect(durationText(77_000, viMachines, "vi")).toBe("1 phút 17 giây");
		expect(durationText(3_780_000, viMachines, "vi")).toBe("1 giờ 3 phút");
		expect(durationText(77_000, enMachines, "en")).toBe("1 min 17 s");
		expect(durationText(45_200, zhCNMachines, "zh-CN")).toBe("45.2 秒");
	});

	it("counts the turn's tools and edited files, a subagent's edits included", () => {
		const items = [
			item("user:1", 1, user("go")),
			item("turn:1", 2, { case: "turn", value: { state: TurnState.COMPLETED, durationMs: 77_000n } }),
			item("tool:a", 3, call("a")),
			item("tool:b", 4, call("b", ToolKind.EDIT, "Edit")),
			item("diff:b", 5, diff("b", "src/a.ts")),
			item("tool:task", 6, call("task", ToolKind.SUBAGENT, "Task")),
			item("diff:s1", 7, diff("s1", "src/b.ts", "task")),
			item("diff:s2", 8, diff("s2", "src/a.ts", "task")),
			item("user:2", 9, user("again")),
		];
		const blocks = foldTranscript(items);
		const turn = blocks.find((b) => b.kind === "turn");
		expect(turn).toMatchObject({ tools: 3, files: 2 });
		// The subagent's edits show with it, not as cards.
		expect(blocks.filter((b) => b.kind === "diff").map((b) => b.id)).toEqual(["diff:b"]);
		const runs = blocks.flatMap((b) => (b.kind === "tools" ? b.runs : []));
		expect(runs.find((r) => r.call?.toolId === "task")?.subagentFiles).toEqual(["src/b.ts", "src/a.ts"]);
		// "Thay đổi" keeps every edit, the subagent's too.
		expect(sessionChanges(items).map((c) => [c.path, c.edits.length])).toEqual([
			["src/a.ts", 2],
			["src/b.ts", 1],
		]);
		if (turn?.kind !== "turn") throw new Error("no turn");
		expect(turnText(turn.turn, turn.tools, turn.files, viMachines, "vi")).toBe("Xong · 1 phút 17 giây · 3 tool · 2 file");
	});

	it("opens to the turn's numbers, the cost marked as an estimate", async () => {
		const turn = create(TurnItemSchema, {
			state: TurnState.COMPLETED,
			durationMs: 77_000n,
			contextTokens: 46_000n,
			contextWindow: 200_000n,
			model: "claude-opus-4-5",
			inputTokens: 120n,
			outputTokens: 3_400n,
			cacheReadTokens: 50_000n,
			cacheWriteTokens: 2_000n,
			durationApiMs: 61_500n,
			numTurns: 9,
			costUsdEstimate: 0.4213,
		});
		const { container } = wrap(<TurnLine turn={turn} tools={32} files={3} t={viMachines} locale="vi" />);
		const summary = screen.getByText("Xong · 1 phút 17 giây · 32 tool · 3 file");
		const details = container.querySelector("details");
		expect(details?.open).toBe(false);
		await userEvent.click(summary);
		expect(details?.open).toBe(true);
		expect(screen.getByText("claude-opus-4-5")).toBeTruthy();
		expect(screen.getByText("vào 120 · ra 3.400")).toBeTruthy();
		expect(screen.getByText("đọc 50.000 · ghi 2.000")).toBeTruthy();
		expect(screen.getByText("23% (46.000 / 200.000 token)")).toBeTruthy();
		expect(screen.getByText("1 phút 2 giây")).toBeTruthy();
		expect(screen.getByText("9")).toBeTruthy();
		expect(screen.getByText(/≈ 0,4213/)).toBeTruthy();
		expect(screen.getByText("Ước tính theo giá API. Gói đăng ký không bị tính khoản này.")).toBeTruthy();
		expect(costText(12.5, "en")).toBe("$12.50");
	});

	it("is a plain line from a machine that reports only the duration", () => {
		const turn = create(TurnItemSchema, { state: TurnState.COMPLETED, durationMs: 1_200n });
		const { container } = wrap(<TurnLine turn={turn} tools={0} files={0} t={viMachines} locale="vi" />);
		expect(container.querySelector("details")).toBeNull();
		expect(screen.getByText("Xong · 1,2 giây")).toBeTruthy();
	});
});

const gitFile = (path: string, state: GitFileState, extra: { truncated?: boolean; sensitive?: boolean; unified?: string } = {}): GitFileChange =>
	create(GitFileChangeSchema, {
		path,
		state,
		added: 2,
		removed: 1,
		unified: extra.unified ?? `--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-a\n+b\n+c`,
		truncated: extra.truncated ?? false,
		sensitive: extra.sensitive ?? false,
	});

describe("the changes panel", () => {
	const history = sessionChanges([item("diff:1", 1, diff("e1", "src/a.ts"))]);
	const noop = async () => undefined;

	it("shows git's part and the AI's part; the count follows git", async () => {
		const git = create(GitChangesSchema, {
			threadId: "t",
			git: true,
			files: [gitFile("made-by-shell.txt", GitFileState.UNTRACKED, { truncated: true }), gitFile(".env", GitFileState.MODIFIED, { sensitive: true, unified: "" })],
		});
		expect(changesCount(history, git)).toBe(2);
		expect(changesCount(history, null)).toBe(1);
		const asked: string[] = [];
		wrap(
			<ChangesPanel
				gitElsewhere={false}
				ai="Claude"
				changes={history}
				gitSupported
				git={git}
				full={new Map()}
				onFetchFull={noop}
				onGitFileDiff={async (path) => {
					asked.push(path);
					return gitFile(path, GitFileState.UNTRACKED, { unified: "--- /dev/null\n+++ b/made-by-shell.txt\n@@ -0,0 +1,3 @@\n+x\n+y\n+whole" });
				}}
				onClose={() => undefined}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Chưa commit trong thư mục" })).toBeTruthy();
		expect(screen.getByRole("heading", { name: "Claude đã sửa" })).toBeTruthy();
		expect(screen.getByText("2 file")).toBeTruthy();
		expect(screen.getByText("Mới")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /made-by-shell\.txt/ }));
		await userEvent.click(screen.getByRole("button", { name: /Xem đủ/ }));
		await waitFor(() => expect(asked).toEqual(["made-by-shell.txt"]));
		await waitFor(() => expect(document.body.textContent).toContain("whole"));
		await userEvent.click(screen.getByRole("button", { name: "Danh sách file" }));
		await userEvent.click(screen.getByRole("button", { name: /\.env/ }));
		expect(screen.getByText("File nhạy cảm nên không hiện nội dung.")).toBeTruthy();
	});

	it("where Source Control lists the folder's uncommitted files, only the AI's edits, counted alone", () => {
		const git = create(GitChangesSchema, { threadId: "t", git: true, files: [gitFile("made-by-shell.txt", GitFileState.UNTRACKED), gitFile("b.txt", GitFileState.MODIFIED)] });
		wrap(<ChangesPanel gitElsewhere ai="Claude" changes={history} gitSupported git={git} full={new Map()} onFetchFull={noop} onGitFileDiff={async () => null} onClose={() => undefined} />);
		expect(screen.queryByRole("heading", { name: "Chưa commit trong thư mục" })).toBeNull();
		expect(screen.getByRole("heading", { name: "Claude đã sửa" })).toBeTruthy();
		expect(screen.getByText("1 file")).toBeTruthy();
	});

	it("outside git, and on an older machine, only the AI's part", () => {
		const { unmount } = wrap(
			<ChangesPanel gitElsewhere={false} ai="Claude" changes={[]} gitSupported git={create(GitChangesSchema, { threadId: "t", git: false })} full={new Map()} onFetchFull={noop} onGitFileDiff={async () => null} onClose={() => undefined} />,
		);
		expect(screen.getByText("Thư mục này không dùng git, nên chỉ có các lần sửa ở dưới.")).toBeTruthy();
		expect(screen.getByText(/Claude chưa sửa file nào bằng công cụ sửa file/)).toBeTruthy();
		expect(screen.queryByRole("heading", { name: "Chưa commit trong thư mục" })).toBeNull();
		unmount();
		wrap(<ChangesPanel gitElsewhere={false} ai="Claude" changes={[]} gitSupported={false} git={null} full={new Map()} onFetchFull={noop} onGitFileDiff={async () => null} onClose={() => undefined} />);
		expect(screen.getByText("Claude chưa sửa file nào trong phiên này.")).toBeTruthy();
		expect(screen.queryByRole("heading")).toBeNull();
	});

	it("says it is asking git until the list arrives, and when nothing waits to be committed", () => {
		const { unmount } = wrap(<ChangesPanel gitElsewhere={false} ai="Claude" changes={history} gitSupported git={null} full={new Map()} onFetchFull={noop} onGitFileDiff={async () => null} onClose={() => undefined} />);
		expect(screen.getByText("Đang hỏi git…")).toBeTruthy();
		unmount();
		wrap(
			<ChangesPanel gitElsewhere={false} ai="Claude" changes={history} gitSupported git={create(GitChangesSchema, { threadId: "t", git: true })} full={new Map()} onFetchFull={noop} onGitFileDiff={async () => null} onClose={() => undefined} />,
		);
		expect(screen.getByText("Không có thay đổi nào chưa commit.")).toBeTruthy();
	});
});

describe("a question when the machine restarted", () => {
	it("says it expired with the restart, not that it was cancelled", () => {
		const question = create(QuestionItemSchema, { questions: [{ question: "Pick one?", header: "Pick", options: [], multiSelect: false }], state: PromptState.EXPIRED });
		wrap(<QuestionCard question={question} ai="Claude" onAnswer={async () => undefined} />);
		expect(screen.getByText(/Hết hạn: máy đã khởi động lại/)).toBeTruthy();
		expect(screen.queryByText(/Đã huỷ/)).toBeNull();
	});
});

describe("the approval of a command reading sign-in secrets", () => {
	const command = 'curl -u "me:$TUNELO_SECRET_GH" https://api.github.com';
	const approval = (secrets: { name: string; origin: string }[]) =>
		create(ApprovalItemSchema, { toolId: "t", kind: ToolKind.SHELL, name: "Bash", summary: command, input: JSON.stringify({ command }), state: PromptState.PENDING, secrets });

	it("shows the site of each secret, standing out", () => {
		wrap(
			<ApprovalCard
				approval={approval([
					{ name: "GH", origin: "https://github.com" },
					{ name: "LOCAL", origin: "" },
				])}
				ai="Claude"
				sessionAllow
				onDecide={async () => undefined}
			/>,
		);
		expect(screen.getByText("github.com").tagName).toBe("STRONG");
		expect(screen.getByText("phiên chưa có bí mật này")).toBeTruthy();
		expect(screen.getByText(/Lệnh này dùng bí mật đăng nhập GH, LOCAL/)).toBeTruthy();
		expect(screen.queryByRole("button", { name: /Cho phép cả phiên/ })).toBeNull();
		expect(siteLabel("http://localhost:3000")).toBe("http://localhost:3000");
	});

	it("from an older machine, names the secrets from the command as before", () => {
		wrap(<ApprovalCard approval={approval([])} ai="Claude" sessionAllow onDecide={async () => undefined} />);
		expect(screen.queryByRole("list", { name: "Bí mật lệnh dùng, theo trang" })).toBeNull();
		expect(screen.getByText(/Lệnh này dùng bí mật đăng nhập GH\./)).toBeTruthy();
	});
});
