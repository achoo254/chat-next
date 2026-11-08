// The remote chat's journal reducer and how items fold into what the chat
// draws: merge by id keeping the highest revision, display order by creation,
// reset, tool grouping with results, turn outcomes, AI/model dividers.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Decision, ItemSchema, PromptState, Role, ToolKind, TurnState, type Item } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { applyItems, EMPTY_JOURNAL, orderedItems, resetJournal } from "../../src/machines/transcript/reducer.ts";
import { contextShare, currentModel, foldTranscript, turnRunning } from "../../src/machines/transcript/tool-fold.ts";

type Body = NonNullable<MessageInitShape<typeof ItemSchema>["body"]>;

let seq = 0n;
function item(id: string, at: number, body: Body, revision = 1, extra: { provider?: string; model?: string } = {}): Item {
	seq += 1n;
	return create(ItemSchema, { id, seq, revision, at: BigInt(at), provider: extra.provider ?? "claude", model: extra.model ?? "", body });
}
const text = (role: Role, value: string, partial = false, clientMsgId = ""): Body => ({ case: "text", value: { role, text: value, partial, clientMsgId } });
const call = (toolId: string, kind = ToolKind.READ, name = "Read"): Body => ({ case: "toolCall", value: { toolId, kind, name, summary: `${name} ${toolId}`, input: "{}" } });
const result = (toolId: string, ok = true): Body => ({ case: "toolResult", value: { toolId, ok, output: "out" } });
const turn = (state: TurnState, extra: { contextTokens?: bigint; contextWindow?: bigint } = {}): Body => ({
	case: "turn",
	value: { state, durationMs: 1200n, contextTokens: extra.contextTokens ?? 0n, contextWindow: extra.contextWindow ?? 0n },
});
const cursor = (s: bigint, epoch = 1n) => ({ epoch, seq: s });

describe("journal reducer", () => {
	it("keeps the highest revision of an item and ignores repeats", () => {
		const a1 = item("text:a", 10, text(Role.ASSISTANT, "Hel", true), 1);
		const a2 = item("text:a", 10, text(Role.ASSISTANT, "Hello", false), 2);
		let j = applyItems(EMPTY_JOURNAL, [a1], cursor(a1.seq));
		j = applyItems(j, [a2], cursor(a2.seq));
		const stale = applyItems(j, [a1], undefined);
		expect(stale).toBe(j);
		expect(orderedItems(j).map((i) => (i.body.case === "text" ? i.body.value.text : ""))).toEqual(["Hello"]);
		expect(j.cursor).toEqual(cursor(a2.seq));
	});

	it("orders by creation time, then by first seen seq, whatever revision arrives last", () => {
		const user = item("user:1", 100, text(Role.USER, "hi"));
		const turnItem = item("turn:1", 100, turn(TurnState.RUNNING));
		const answer = item("text:b", 101, text(Role.ASSISTANT, "", true));
		const tool = item("tool:t1", 102, call("t1"));
		// The answer's later revision takes a newer seq than the tool call.
		const answerDone = item("text:b", 101, text(Role.ASSISTANT, "done"), 2);
		const j = applyItems(EMPTY_JOURNAL, [user, turnItem, answer, tool, answerDone], cursor(answerDone.seq));
		expect(j.order).toEqual(["user:1", "turn:1", "text:b", "tool:t1"]);
		// A snapshot after a reset carries only the latest revisions, in seq order: same display order.
		const snapshot = applyItems(resetJournal(), [user, turnItem, tool, answerDone], cursor(answerDone.seq, 2n));
		expect(snapshot.order).toEqual(["user:1", "turn:1", "text:b", "tool:t1"]);
		expect(snapshot.cursor).toEqual(cursor(answerDone.seq, 2n));
	});

	it("moves the cursor forward only, and to another epoch at once", () => {
		const a = item("a", 1, text(Role.ASSISTANT, "a"));
		let j = applyItems(EMPTY_JOURNAL, [a], cursor(5n));
		j = applyItems(j, [], cursor(3n));
		expect(j.cursor).toEqual(cursor(5n));
		j = applyItems(j, [], cursor(1n, 2n));
		expect(j.cursor).toEqual(cursor(1n, 2n));
	});

	it("reset forgets every item", () => {
		const j = applyItems(EMPTY_JOURNAL, [item("a", 1, text(Role.USER, "x"))], cursor(1n));
		const reset = resetJournal();
		expect(reset.items.size).toBe(0);
		expect(reset.cursor).toBeNull();
		expect(j.items.size).toBe(1);
	});
});

describe("folding the transcript", () => {
	it("groups consecutive tool calls with their results and hides the todo tool", () => {
		const items = [
			item("user:1", 1, text(Role.USER, "fix it")),
			item("text:a", 2, text(Role.ASSISTANT, "Looking.")),
			item("tool:1", 3, call("1")),
			item("tool:2", 4, call("2", ToolKind.SEARCH, "Grep")),
			item("result:1", 5, result("1")),
			item("tool:todo", 6, call("todo", ToolKind.TODO, "TodoWrite")),
			item("result:2", 7, result("2", false)),
			item("text:b", 8, text(Role.ASSISTANT, "Found it.")),
			item("tool:3", 9, call("3", ToolKind.EDIT, "Edit")),
			item("diff:3", 10, { case: "diff", value: { toolId: "3", path: "a.ts", unified: "+x", added: 1, removed: 0 } }),
			item("result:3", 11, result("3")),
			item("todo", 12, { case: "todo", value: { entries: [{ text: "Run tests", state: 2 }] } }),
		];
		const blocks = foldTranscript(items);
		expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "tools", "text", "tools", "diff", "todo"]);
		const tools = blocks[2];
		if (tools?.kind !== "tools") throw new Error("expected tools");
		expect(tools.runs.map((r) => [r.call?.toolId, r.result?.ok, r.resultId])).toEqual([
			["1", true, "result:1"],
			["2", false, "result:2"],
		]);
		const edit = blocks[4];
		if (edit?.kind !== "tools") throw new Error("expected tools");
		expect(edit.runs[0]?.result?.ok).toBe(true);
	});

	it("shows a turn's outcome where the turn ends, not where it started", () => {
		const items = [
			item("user:1", 1, text(Role.USER, "one")),
			item("turn:1", 1, turn(TurnState.COMPLETED)),
			item("text:a", 2, text(Role.ASSISTANT, "answer one")),
			item("user:2", 3, text(Role.USER, "two")),
			item("turn:2", 3, turn(TurnState.RUNNING)),
			item("text:b", 4, text(Role.ASSISTANT, "partial", true)),
		];
		const blocks = foldTranscript(items);
		expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "turn", "user", "text"]);
		expect(turnRunning(items)).toBe(true);
		const last = blocks.at(-1);
		expect(last?.kind === "text" && last.partial).toBe(true);
	});

	it("draws model-change and handoff dividers and names the AI when it changed", () => {
		const items = [
			item("user:1", 1, text(Role.USER, "go")),
			item("turn:1", 1, turn(TurnState.COMPLETED)),
			item("text:a", 2, text(Role.ASSISTANT, "first"), 1, { model: "opus" }),
			item("model:1", 3, { case: "modelChange", value: { from: "opus", to: "sonnet" } }),
			item("user:2", 4, text(Role.USER, "again")),
			item("turn:2", 4, turn(TurnState.COMPLETED)),
			item("text:b", 5, text(Role.ASSISTANT, "second"), 1, { model: "sonnet" }),
			item("handoff:1", 6, { case: "agentHandoff", value: { from: "Claude Code", to: "Codex", summary: "goal", filesChanged: ["a.ts"] } }),
			item("turn:3", 6, turn(TurnState.COMPLETED)),
			item("text:c", 7, text(Role.ASSISTANT, "third"), 1, { provider: "codex", model: "gpt" }),
		];
		const blocks = foldTranscript(items);
		expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "turn", "model", "user", "who", "text", "turn", "handoff", "who", "text", "turn"]);
		const whos = blocks.filter((b) => b.kind === "who");
		expect(whos.map((b) => (b.kind === "who" ? `${b.provider}/${b.model}` : ""))).toEqual(["claude/sonnet", "codex/gpt"]);
	});

	it("shows a sent message until the machine echoes it", () => {
		const pending = [
			{ clientMsgId: "c1", text: "echoed" },
			{ clientMsgId: "c2", text: "still going" },
		];
		const items = [item("user:x", 1, text(Role.USER, "echoed", false, "c1"))];
		const blocks = foldTranscript(items, pending);
		expect(blocks.map((b) => (b.kind === "user" ? [b.text, b.pending] : null))).toEqual([
			["echoed", false],
			["still going", true],
		]);
	});

	it("keeps approvals and questions with their revision, drops thinking and empty status", () => {
		const items = [
			item("text:t", 1, text(Role.THINKING, "hmm")),
			item("status:1", 2, { case: "status", value: { text: " " } }),
			item("ask:1", 3, { case: "approval", value: { toolId: "1", kind: ToolKind.SHELL, name: "Bash", summary: "ls", state: PromptState.PENDING, sensitive: true } }, 3),
			item("ask:2", 4, { case: "question", value: { questions: [{ question: "Which?", options: [{ label: "A" }] }], state: PromptState.PENDING } }, 1),
			item("error:1", 5, { case: "error", value: { message: "boom" } }),
		];
		const blocks = foldTranscript(items);
		expect(blocks.map((b) => b.kind)).toEqual(["approval", "question", "error"]);
		expect(blocks[0]?.kind === "approval" && blocks[0].revision).toBe(3);
	});

	it("reads the context share of the latest turn that reported it", () => {
		const items = [
			item("turn:1", 1, turn(TurnState.COMPLETED, { contextTokens: 50_000n, contextWindow: 200_000n })),
			item("turn:2", 2, turn(TurnState.RUNNING)),
		];
		expect(contextShare(items)).toBe(0.25);
		expect(contextShare([])).toBeNull();
	});

	it("folds an answered prompt into its tool's row and keeps one tool a run of its own", () => {
		const ask = (toolId: string, state: PromptState, decision = Decision.UNSPECIFIED): Body => ({
			case: "approval",
			value: { toolId, kind: ToolKind.SHELL, name: "Bash", summary: "rm -rf dist", state, decision },
		});
		const items = [
			item("tool:1", 1, call("1", ToolKind.SHELL, "Bash")),
			item("ask:1", 2, ask("1", PromptState.ANSWERED, Decision.ALLOW_SESSION), 2),
			item("result:1", 3, result("1")),
			item("tool:2", 4, call("2", ToolKind.SHELL, "Bash")),
			item("ask:2", 5, ask("2", PromptState.PENDING)),
			item("ask:9", 6, ask("9", PromptState.ANSWERED, Decision.DENY), 2),
		];
		const blocks = foldTranscript(items);
		// The answered prompt does not split the run; the pending one stays a card; one without a shown call stays a line.
		expect(blocks.map((b) => b.kind)).toEqual(["tools", "approval", "approval"]);
		const tools = blocks[0];
		if (tools?.kind !== "tools") throw new Error("expected tools");
		expect(tools.runs.map((r) => [r.call?.toolId, r.approval?.decision ?? null])).toEqual([
			["1", Decision.ALLOW_SESSION],
			["2", null],
		]);
		expect(blocks.slice(1).map((b) => (b.kind === "approval" ? b.approval.toolId : ""))).toEqual(["2", "9"]);
	});

	it("names the current model: the thread's own, else the latest change, else the default", () => {
		const items = [item("model:1", 1, { case: "modelChange", value: { from: "opus", to: "sonnet" } }), item("model:2", 2, { case: "modelChange", value: { from: "sonnet", to: "haiku" } })];
		expect(currentModel(items, "opus")).toBe("opus");
		expect(currentModel(items, "")).toBe("haiku");
		expect(currentModel([], "")).toBe("");
	});
});
