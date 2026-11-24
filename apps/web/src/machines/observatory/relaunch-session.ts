// "Mở lại phiên để bắt đầu ghi": reopens a thread's Claude Code session so the
// machine's Observatory records it. A session opened before Observatory was
// on runs without its hooks; the machine reopens the CLI with --resume and
// fresh --settings, so the same session goes on, recorded from then on.
// One way per mode, nothing retried by itself:
// - the AI runs in the machine's terminal: that terminal is ended on purpose
//   (its pane says so, not "exited 129"), closed, and the AI opened again in
//   a new terminal;
// - chat: the thread's session is closed (its history kept); the next message
//   opens it again.
// A refusal (a turn running, the session open elsewhere on the machine) reads
// as words the viewer can act on; a terminal closed but not opened again says
// so, since the AI is then not running anywhere.
// Also what the page tells the empty view of the thread (relaunchFactsOf),
// kept here so the page loads no part of the view to work it out.
import { ErrorReason, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { openAiTerminal } from "../../terminal/ai-terminal-open.ts";
import { endOnPurpose, forgetEnded } from "../../terminal/ended-sessions.ts";
import type { MachinesCopy } from "../copy-vi.ts";
import { RemoteError, type MachineLink } from "../link/machine-link.ts";
import { machineErrorText } from "../machine-errors.ts";
import type { ObserveThread } from "./observe-empty-state.tsx";

/** The AI the Observe view watches: the only one whose sessions Observatory records. */
const OBSERVED_AI = "Claude Code";

export type RelaunchLink = Pick<MachineLink, "request" | "closeThread">;

/** How the thread's session is reopened: in the machine's terminal that holds it, or by closing its chat session. */
export type RelaunchKind = "terminal" | "chat";

export function relaunchKindOf(thread: Pick<ThreadSummary, "terminalSession">): RelaunchKind {
	return thread.terminalSession > 0 ? "terminal" : "chat";
}

/** What the empty view reads of the thread, how its session reopens, and whether a turn keeps it from reopening now. */
export interface RelaunchFacts {
	readonly thread: ObserveThread;
	readonly kind: RelaunchKind;
	readonly busy: boolean;
}

/**
 * The thread as the empty view reads it, `running` being a turn the machine
 * runs in chat (or waits on, or has queued). A turn inside tunelo's own
 * terminal reaches devices as "busy elsewhere" with the state idle (the
 * machine watches that CLI from outside): it is the thread's own turn, not
 * a session elsewhere on the machine, and it keeps the terminal from being
 * reopened.
 */
export function relaunchFactsOf(thread: Pick<ThreadSummary, "preview" | "busyElsewhere" | "terminalSession">, running: boolean): RelaunchFacts {
	const kind = relaunchKindOf(thread);
	const terminalBusy = kind === "terminal" && thread.busyElsewhere;
	const busy = running || terminalBusy;
	return { thread: { preview: thread.preview, busyElsewhere: thread.busyElsewhere && !terminalBusy, running: busy }, kind, busy };
}

/** The thread's terminal was closed but its AI did not open again; `refusal` is the machine's refusal. */
export class NotReopenedError extends Error {
	constructor(readonly refusal: unknown) {
		super("the terminal was closed but the AI did not open again");
	}
}

/**
 * Reopens the thread's session on `machine` (its ref, naming its terminal
 * sessions on this page). Rejects as the machine refused; a terminal that
 * could not be closed is not counted as ended on purpose, one closed whose
 * AI did not open again rejects with NotReopenedError.
 */
export async function relaunchSession(link: RelaunchLink, machine: string, thread: Pick<ThreadSummary, "id" | "terminalSession">): Promise<void> {
	if (relaunchKindOf(thread) === "chat") {
		await link.closeThread(thread.id);
		return;
	}
	const session = thread.terminalSession;
	endOnPurpose(machine, session);
	try {
		await link.request({ case: "termClose", value: { session } });
	} catch (err) {
		forgetEnded(machine, session);
		throw err;
	}
	try {
		await openAiTerminal(link, thread.id);
	} catch (err) {
		throw new NotReopenedError(err);
	}
}

/** Why reopening failed, as the viewer reads it. */
export function relaunchErrorText(t: MachinesCopy, err: unknown): string {
	if (err instanceof NotReopenedError) return t.observe.empty.errorNotReopened(relaunchErrorText(t, err.refusal));
	if (err instanceof RemoteError) {
		if (err.reason === ErrorReason.THREAD_RUNNING) return t.observe.empty.errorRunning;
		if (err.reason === ErrorReason.SESSION_OPEN_ELSEWHERE) return t.observe.empty.errorElsewhere;
	}
	return machineErrorText(t, err, OBSERVED_AI);
}
