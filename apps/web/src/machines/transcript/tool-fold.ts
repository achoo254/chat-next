// Turns a thread's items (in display order) into what the chat draws:
// consecutive tool calls fold into one "ran N tools" row with their results
// attached, a turn's outcome shows where the turn ends (before the next
// message of the user), and a label names the AI/model when the answering
// one changed. Only the generic item shapes are read, never a tool's own
// name, so every AI adapter renders the same way.
import {
	Role,
	ToolKind,
	TurnState,
	type AgentHandoffItem,
	type ApprovalItem,
	type DiffItem,
	type Item,
	type QuestionItem,
	type SubagentItem,
	type TodoItem,
	type ToolCallItem,
	type ToolResultItem,
	type TurnItem,
} from "@achoo254/chat-proto/remote/remote";

export interface ToolRun {
	readonly id: string;
	readonly call: ToolCallItem | null;
	readonly result: ToolResultItem | null;
	readonly subagent: SubagentItem | null;
	/** Item id of the result, for fetching the full output. */
	readonly resultId: string | null;
}

export type Block =
	| { readonly kind: "user"; readonly id: string; readonly text: string; readonly pending: boolean }
	| { readonly kind: "text"; readonly id: string; readonly text: string; readonly partial: boolean }
	| { readonly kind: "who"; readonly id: string; readonly provider: string; readonly model: string }
	| { readonly kind: "tools"; readonly id: string; readonly runs: readonly ToolRun[] }
	| { readonly kind: "diff"; readonly id: string; readonly diff: DiffItem }
	| { readonly kind: "todo"; readonly id: string; readonly todo: TodoItem }
	| { readonly kind: "approval"; readonly id: string; readonly revision: number; readonly approval: ApprovalItem }
	| { readonly kind: "question"; readonly id: string; readonly revision: number; readonly question: QuestionItem }
	| { readonly kind: "turn"; readonly id: string; readonly turn: TurnItem }
	| { readonly kind: "model"; readonly id: string; readonly from: string; readonly to: string }
	| { readonly kind: "handoff"; readonly id: string; readonly handoff: AgentHandoffItem }
	| { readonly kind: "compaction"; readonly id: string }
	| { readonly kind: "status"; readonly id: string; readonly text: string }
	| { readonly kind: "error"; readonly id: string; readonly message: string };

/** A message the user sent that the machine has not echoed yet. */
export interface PendingSend {
	readonly clientMsgId: string;
	readonly text: string;
}

export function foldTranscript(items: readonly Item[], pending: readonly PendingSend[] = []): Block[] {
	const results = new Map<string, Item>();
	const subagents = new Map<string, SubagentItem>();
	const calls = new Set<string>();
	const echoed = new Set<string>();
	for (const item of items) {
		const b = item.body;
		if (b.case === "toolResult") results.set(b.value.toolId, item);
		else if (b.case === "subagent") subagents.set(b.value.toolId, b.value);
		else if (b.case === "toolCall") calls.add(b.value.toolId);
		else if (b.case === "text" && b.value.clientMsgId !== "") echoed.add(b.value.clientMsgId);
	}

	const blocks: Block[] = [];
	let runs: ToolRun[] = [];
	let heldTurn: Item | null = null;
	let lastWho: string | null = null;

	const flushRuns = () => {
		if (runs.length === 0) return;
		blocks.push({ kind: "tools", id: `tools:${runs[0]?.id ?? ""}`, runs });
		runs = [];
	};
	const flushTurn = () => {
		if (heldTurn === null) return;
		const turn = heldTurn;
		heldTurn = null;
		if (turn.body.case === "turn" && turn.body.value.state !== TurnState.RUNNING && turn.body.value.state !== TurnState.UNSPECIFIED) {
			blocks.push({ kind: "turn", id: turn.id, turn: turn.body.value });
		}
	};

	for (const item of items) {
		const b = item.body;
		switch (b.case) {
			case "toolCall": {
				// The todo card shows the list; its tool call adds nothing.
				if (b.value.kind === ToolKind.TODO) break;
				const result = results.get(b.value.toolId);
				runs.push({
					id: item.id,
					call: b.value,
					result: result?.body.case === "toolResult" ? result.body.value : null,
					subagent: subagents.get(b.value.toolId) ?? null,
					resultId: result?.id ?? null,
				});
				break;
			}
			case "toolResult":
				// Shown with its call; a result without one is dropped.
				break;
			case "subagent":
				if (!calls.has(b.value.toolId)) runs.push({ id: item.id, call: null, result: null, subagent: b.value, resultId: null });
				break;
			case "text": {
				if (b.value.role === Role.THINKING) break;
				flushRuns();
				if (b.value.role === Role.USER) {
					flushTurn();
					blocks.push({ kind: "user", id: item.id, text: b.value.text, pending: false });
					break;
				}
				if (b.value.text === "" && !b.value.partial) break;
				const who = `${item.provider}\u0000${item.model}`;
				if (lastWho !== null && who !== lastWho) blocks.push({ kind: "who", id: `who:${item.id}`, provider: item.provider, model: item.model });
				lastWho = who;
				blocks.push({ kind: "text", id: item.id, text: b.value.text, partial: b.value.partial });
				break;
			}
			case "turn":
				// The outcome belongs at the end of the turn: held until the next user message.
				flushTurn();
				heldTurn = item;
				break;
			default: {
				flushRuns();
				// A divider between AIs or models also closes the turn before it.
				if (b.case === "agentHandoff" || b.case === "modelChange") flushTurn();
				const block = single(item);
				if (block !== null) blocks.push(block);
			}
		}
	}
	flushRuns();
	flushTurn();
	for (const send of pending) {
		if (!echoed.has(send.clientMsgId)) blocks.push({ kind: "user", id: `pending:${send.clientMsgId}`, text: send.text, pending: true });
	}
	return blocks;
}

function single(item: Item): Block | null {
	const b = item.body;
	switch (b.case) {
		case "diff":
			return { kind: "diff", id: item.id, diff: b.value };
		case "todo":
			return b.value.entries.length === 0 ? null : { kind: "todo", id: item.id, todo: b.value };
		case "approval":
			return { kind: "approval", id: item.id, revision: item.revision, approval: b.value };
		case "question":
			return { kind: "question", id: item.id, revision: item.revision, question: b.value };
		case "modelChange":
			return { kind: "model", id: item.id, from: b.value.from, to: b.value.to };
		case "agentHandoff":
			return { kind: "handoff", id: item.id, handoff: b.value };
		case "compaction":
			return { kind: "compaction", id: item.id };
		case "status":
			return b.value.text.trim() === "" ? null : { kind: "status", id: item.id, text: b.value.text };
		case "error":
			return { kind: "error", id: item.id, message: b.value.message };
		default:
			return null;
	}
}

/** Share of the context window used after the latest turn that reported it; null when unknown. */
export function contextShare(items: readonly Item[]): number | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const b = items[i]?.body;
		if (b?.case === "turn" && b.value.contextWindow > 0n) {
			return Math.min(1, Number(b.value.contextTokens) / Number(b.value.contextWindow));
		}
	}
	return null;
}

/** The newest turn is still running (the Stop button shows). */
export function turnRunning(items: readonly Item[]): boolean {
	for (let i = items.length - 1; i >= 0; i--) {
		const b = items[i]?.body;
		if (b?.case === "turn") return b.value.state === TurnState.RUNNING;
	}
	return false;
}
