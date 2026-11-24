// Opens a thread's AI in the machine's terminal: the one frame that asks for
// it (termOpen with aiSession), shared by the terminal dock and Observe's
// "reopen the session". The machine picks what runs, the folder and the
// environment; the device names only the thread. When the AI already runs in
// a terminal the machine answers with that session instead of a new one.
import type { MachineLink } from "../machines/link/machine-link.ts";

/** The size a terminal opens at; the pane showing it resizes it to fit right after. */
export const OPEN_COLS = 80;
export const OPEN_ROWS = 24;

/** Opens the thread's AI in a terminal and resolves with the machine's session number; rejects as the link's request does. */
export async function openAiTerminal(link: Pick<MachineLink, "request">, threadId: string): Promise<number> {
	const frame = await link.request({ case: "termOpen", value: { cols: OPEN_COLS, rows: OPEN_ROWS, cwd: "", aiSession: { threadId } } });
	if (frame.body.case !== "termOpened") throw new Error("the machine did not open a terminal");
	return frame.body.value.session;
}
