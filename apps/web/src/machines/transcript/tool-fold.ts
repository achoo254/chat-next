// Turns a thread's items (in display order) into what the chat draws:
// consecutive tool calls fold into one run of rows with their results
// attached (the card groups them under "ran N tools" from two calls on), an
// answered permission prompt folds into its tool's row (a pending one stays
// a card with buttons), a turn's outcome shows where the turn ends (before the next
// message of the user), and a label names the AI/model when the answering
// one changed. Only the generic item shapes are read, never a tool's own
// name, so every AI adapter renders the same way.
import {
	PromptState,
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
	/** When the call was made (Unix ms), for how long it has been running. */
	readonly at: number;
	readonly call: ToolCallItem | null;
	readonly result: ToolResultItem | null;
	readonly subagent: SubagentItem | null;
	/** Item id of the result, for fetching the full output. */
	readonly resultId: string | null;
	/** The answered permission prompt of this call, shown as a short status in its row. */
	readonly approval: ApprovalItem | null;
	/** Files a subagent edited (its diffs), each path once. */
	readonly subagentFiles: readonly string[];
}

export type Block =
	| { readonly kind: "user"; readonly id: string; readonly text: string; readonly pending: boolean; readonly attachments: readonly ShownAttachment[] }
	| { readonly kind: "text"; readonly id: string; readonly text: string; readonly partial: boolean }
	| { readonly kind: "who"; readonly id: string; readonly provider: string; readonly model: string }
	| { readonly kind: "tools"; readonly id: string; readonly runs: readonly ToolRun[] }
	| { readonly kind: "diff"; readonly id: string; readonly diff: DiffItem }
	| { readonly kind: "todo"; readonly id: string; readonly todo: TodoItem }
	| { readonly kind: "approval"; readonly id: string; readonly revision: number; readonly approval: ApprovalItem }
	| { readonly kind: "question"; readonly id: string; readonly revision: number; readonly question: QuestionItem }
	/** `tools` and `files`: tool calls and files edited in the turn, counted from its items. */
	| { readonly kind: "turn"; readonly id: string; readonly turn: TurnItem; readonly tools: number; readonly files: number }
	| { readonly kind: "model"; readonly id: string; readonly from: string; readonly to: string }
	| { readonly kind: "handoff"; readonly id: string; readonly handoff: AgentHandoffItem }
	| { readonly kind: "compaction"; readonly id: string }
	| { readonly kind: "status"; readonly id: string; readonly text: string }
	| { readonly kind: "error"; readonly id: string; readonly message: string };

/** A message the user sent that the machine has not echoed yet. */
/** A file that went with a user message, as the thread shows it. */
export interface ShownAttachment {
	readonly id: string;
	readonly name: string;
	readonly size: number;
	/** The AI got it as an image: shown as one (a preview here, else fetched from the machine). */
	readonly image: boolean;
	/** Where the machine saved a file in the session's folder; "" for an image or while sending. */
	readonly path: string;
	/** A local preview of an image being sent; "" otherwise. */
	readonly preview: string;
}

export interface PendingSend {
	readonly clientMsgId: string;
	readonly text: string;
	readonly attachments?: readonly ShownAttachment[];
}

export function foldTranscript(items: readonly Item[], pending: readonly PendingSend[] = []): Block[] {
	const results = new Map<string, Item>();
	const subagents = new Map<string, SubagentItem>();
	const calls = new Set<string>();
	/** Calls drawn as a row (the todo tool is not). */
	const rows = new Set<string>();
	const echoed = new Set<string>();
	/** Answered prompts by tool id (the latest wins); folded into the call's row. */
	const answered = new Map<string, ApprovalItem>();
	/** Paths each subagent edited, by its tool id. */
	const subagentFiles = new Map<string, Set<string>>();
	for (const item of items) {
		const b = item.body;
		if (b.case === "diff" && b.value.parentToolId !== "") {
			const set = subagentFiles.get(b.value.parentToolId) ?? new Set<string>();
			set.add(b.value.path);
			subagentFiles.set(b.value.parentToolId, set);
		} else if (b.case === "toolResult") results.set(b.value.toolId, item);
		else if (b.case === "subagent") subagents.set(b.value.toolId, b.value);
		else if (b.case === "toolCall") {
			calls.add(b.value.toolId);
			if (b.value.kind !== ToolKind.TODO) rows.add(b.value.toolId);
		} else if (b.case === "text" && b.value.clientMsgId !== "") echoed.add(b.value.clientMsgId);
		else if (b.case === "approval" && b.value.state !== PromptState.PENDING && b.value.toolId !== "") answered.set(b.value.toolId, b.value);
	}

	const blocks: Block[] = [];
	let runs: ToolRun[] = [];
	let heldTurn: Item | null = null;
	let lastWho: string | null = null;
	/** Tool calls and edited files since the user's last message. */
	let turnTools = 0;
	let turnFiles = new Set<string>();
	const filesOf = (toolId: string): string[] => [...(subagentFiles.get(toolId) ?? [])];

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
			blocks.push({ kind: "turn", id: turn.id, turn: turn.body.value, tools: turnTools, files: turnFiles.size });
		}
	};

	for (const item of items) {
		const b = item.body;
		switch (b.case) {
			case "toolCall": {
				// The todo card shows the list; its tool call adds nothing.
				if (b.value.kind === ToolKind.TODO) break;
				turnTools += 1;
				const result = results.get(b.value.toolId);
				runs.push({
					id: item.id,
					at: Number(item.at),
					call: b.value,
					result: result?.body.case === "toolResult" ? result.body.value : null,
					subagent: subagents.get(b.value.toolId) ?? null,
					resultId: result?.id ?? null,
					approval: answered.get(b.value.toolId) ?? null,
					subagentFiles: filesOf(b.value.toolId),
				});
				break;
			}
			case "toolResult":
				// Shown with its call; a result without one is dropped.
				break;
			case "subagent":
				if (!calls.has(b.value.toolId)) {
					runs.push({ id: item.id, at: Number(item.at), call: null, result: null, subagent: b.value, resultId: null, approval: null, subagentFiles: filesOf(b.value.toolId) });
				}
				break;
			case "diff":
				turnFiles.add(b.value.path);
				// A subagent's edit shows with the subagent (and in "Thay đổi"), not as a card of its own.
				if (b.value.parentToolId !== "") break;
				flushRuns();
				blocks.push({ kind: "diff", id: item.id, diff: b.value });
				break;
			case "approval":
				// Answered and its call is shown: the call's row carries the outcome.
				if (b.value.state !== PromptState.PENDING && rows.has(b.value.toolId)) break;
				flushRuns();
				blocks.push({ kind: "approval", id: item.id, revision: item.revision, approval: b.value });
				break;
			case "text": {
				if (b.value.role === Role.THINKING) break;
				flushRuns();
				if (b.value.role === Role.USER) {
					flushTurn();
					turnTools = 0;
					turnFiles = new Set<string>();
					const attachments = b.value.attachments.map((a) => ({ id: a.id, name: a.name, size: Number(a.size), image: a.image, path: a.path, preview: "" }));
					blocks.push({ kind: "user", id: item.id, text: b.value.text, pending: false, attachments });
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
		if (!echoed.has(send.clientMsgId)) {
			blocks.push({ kind: "user", id: `pending:${send.clientMsgId}`, text: send.text, pending: true, attachments: send.attachments ?? [] });
		}
	}
	return blocks;
}

function single(item: Item): Block | null {
	const b = item.body;
	switch (b.case) {
		case "todo":
			return b.value.entries.length === 0 ? null : { kind: "todo", id: item.id, todo: b.value };
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

/** The model answering now: the thread's own, else the latest model change; "" for the AI's default. */
export function currentModel(items: readonly Item[], threadModel: string): string {
	if (threadModel !== "") return threadModel;
	for (let i = items.length - 1; i >= 0; i--) {
		const b = items[i]?.body;
		if (b?.case === "modelChange") return b.value.to;
	}
	return "";
}

/** When the newest turn began (Unix ms) while it still runs; null otherwise. */
export function turnStartedAt(items: readonly Item[]): number | null {
	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i];
		if (item?.body.case === "turn") return item.body.value.state === TurnState.RUNNING ? Number(item.at) : null;
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
