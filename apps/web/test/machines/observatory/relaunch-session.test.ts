// Reopening a thread's Claude Code session so Observatory records it: in the
// terminal the old one is ended on purpose and closed before the AI opens
// again (in that order, through the shared termOpen frame); in chat the
// session is closed; a refused close leaves the terminal not ended on
// purpose and opens nothing; refusals read as words. Also the shared frame
// the terminal dock opens a thread's AI with.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, FrameSchema, TermClosedSchema, TermOpenedSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../../src/machines/copy-en.ts";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import { OfflineError, RemoteError } from "../../../src/machines/link/machine-link.ts";
import { NotReopenedError, relaunchErrorText, relaunchKindOf, relaunchSession, type RelaunchLink } from "../../../src/machines/observatory/relaunch-session.ts";
import { openAiTerminal } from "../../../src/terminal/ai-terminal-open.ts";
import { endedOnPurpose } from "../../../src/terminal/ended-sessions.ts";

type Body = Parameters<RelaunchLink["request"]>[0];

/** A link answering each request from `answers` (by case); a missing answer or an Error rejects. */
function fakeLink(answers: Partial<Record<string, Frame["body"] | Error>> = {}) {
	const calls: string[] = [];
	const sent: Body[] = [];
	const link: RelaunchLink = {
		request: (body) => {
			sent.push(body);
			calls.push(body.case ?? "");
			const answer = answers[body.case ?? ""];
			if (answer === undefined || answer instanceof Error) return Promise.reject(answer ?? new Error("no answer"));
			return Promise.resolve(create(FrameSchema, { id: "x", body: answer }));
		},
		closeThread: (threadId) => {
			calls.push(`closeThread:${threadId}`);
			const answer = answers.closeThread;
			return answer instanceof Error ? Promise.reject(answer) : Promise.resolve();
		},
	};
	return { link, calls, sent };
}

const opened = (session: number): Frame["body"] => ({ case: "termOpened", value: create(TermOpenedSchema, { session }) });
const closed = (session: number): Frame["body"] => ({ case: "termClosed", value: create(TermClosedSchema, { session }) });

describe("reopening a thread's session", () => {
	it("picks the terminal while one holds the AI, chat otherwise", () => {
		expect(relaunchKindOf({ terminalSession: 7 })).toBe("terminal");
		expect(relaunchKindOf({ terminalSession: 0 })).toBe("chat");
	});

	it("ends the terminal on purpose, closes it, then opens the AI again with the thread", async () => {
		const fake = fakeLink({ termClose: closed(7), termOpen: opened(8) });
		await relaunchSession(fake.link, "m-reopen", { id: "t1", terminalSession: 7 });
		expect(fake.calls).toEqual(["termClose", "termOpen"]);
		expect(fake.sent[0]).toEqual({ case: "termClose", value: { session: 7 } });
		expect(fake.sent[1]).toEqual({ case: "termOpen", value: { cols: 80, rows: 24, cwd: "", aiSession: { threadId: "t1" } } });
		expect(endedOnPurpose("m-reopen", 7)).toBe(true);
	});

	it("closes the chat session and touches no terminal", async () => {
		const fake = fakeLink();
		await relaunchSession(fake.link, "m-chat", { id: "t2", terminalSession: 0 });
		expect(fake.calls).toEqual(["closeThread:t2"]);
	});

	it("opens nothing when the terminal could not be closed, and its exit is its own again", async () => {
		const refused = new RemoteError(ErrorCode.INVALID, "no", ErrorReason.UNSPECIFIED);
		const fake = fakeLink({ termClose: refused, termOpen: opened(8) });
		await expect(relaunchSession(fake.link, "m-refused", { id: "t1", terminalSession: 5 })).rejects.toBe(refused);
		expect(fake.calls).toEqual(["termClose"]);
		expect(endedOnPurpose("m-refused", 5)).toBe(false);
	});

	it("passes on a refusal of the chat close", async () => {
		const running = new RemoteError(ErrorCode.INVALID, "running", ErrorReason.THREAD_RUNNING);
		const fake = fakeLink({ closeThread: running });
		await expect(relaunchSession(fake.link, "m", { id: "t3", terminalSession: 0 })).rejects.toBe(running);
	});

	it("says the old terminal is closed when the new one did not open", async () => {
		const elsewhere = new RemoteError(ErrorCode.INVALID, "elsewhere", ErrorReason.SESSION_OPEN_ELSEWHERE);
		const fake = fakeLink({ termClose: closed(4), termOpen: elsewhere });
		const failure: unknown = await relaunchSession(fake.link, "m-else", { id: "t4", terminalSession: 4 }).then(
			() => null,
			(err: unknown) => err,
		);
		expect(failure).toBeInstanceOf(NotReopenedError);
		expect(failure instanceof NotReopenedError ? failure.refusal : null).toBe(elsewhere);
		expect(fake.calls).toEqual(["termClose", "termOpen"]);
		expect(relaunchErrorText(viMachines, failure)).toBe(viMachines.observe.empty.errorNotReopened(viMachines.observe.empty.errorElsewhere));
	});
});

describe("why reopening failed", () => {
	it("says a turn runs, or the session is open elsewhere, in the viewer's words", () => {
		for (const t of [viMachines, enMachines]) {
			expect(relaunchErrorText(t, new RemoteError(ErrorCode.INVALID, "x", ErrorReason.THREAD_RUNNING))).toBe(t.observe.empty.errorRunning);
			expect(relaunchErrorText(t, new RemoteError(ErrorCode.INVALID, "x", ErrorReason.SESSION_OPEN_ELSEWHERE))).toBe(t.observe.empty.errorElsewhere);
		}
	});

	it("names the old terminal closed whatever kept the new one from opening, in every language", () => {
		for (const t of [viMachines, enMachines]) {
			const gone = new NotReopenedError(new RemoteError(ErrorCode.INVALID, "x", ErrorReason.SESSION_NOT_FOUND));
			const text = relaunchErrorText(t, gone);
			expect(text).toBe(t.observe.empty.errorNotReopened(relaunchErrorText(t, gone.refusal)));
			expect(text).toContain(t.terminal.mode.terminal);
		}
	});

	it("reads any other failure as the machine's errors do", () => {
		const text = relaunchErrorText(viMachines, new OfflineError());
		expect(text).not.toBe("");
		expect(text).not.toBe(viMachines.observe.empty.errorRunning);
	});
});

describe("opening a thread's AI in the terminal", () => {
	it("sends the AI frame and resolves with the machine's session", async () => {
		const fake = fakeLink({ termOpen: opened(12) });
		await expect(openAiTerminal(fake.link, "t9")).resolves.toBe(12);
		expect(fake.sent).toEqual([{ case: "termOpen", value: { cols: 80, rows: 24, cwd: "", aiSession: { threadId: "t9" } } }]);
	});

	it("rejects an answer that is not a terminal opened", async () => {
		const fake = fakeLink({ termOpen: closed(1) });
		await expect(openAiTerminal(fake.link, "t9")).rejects.toThrow("did not open a terminal");
	});
});
