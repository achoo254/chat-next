// What xterm sends to the program by itself through onData, as opposed to what the user typed, pasted or composed:
// focus reports (ESC[I, ESC[O, with DECSET 1004), mouse reports, and answers to the program's queries (cursor
// position, device attributes, status, modes, window size, colours and settings). These must not act as a key does
// (bring the view back to the newest line, claim the session's size): a click into the history to select text
// blurs the terminal, which reports focus.

const ESC = "\x1b";
const BEL = "\x07";

const REPORTS: readonly RegExp[] = [
	// Focus in / out.
	new RegExp(`^${ESC}\\[[IO]$`),
	// Mouse: SGR (ESC[<b;x;yM / m), URXVT (ESC[b;x;yM) and the default/UTF-8 encoding (ESC[M then three characters).
	new RegExp(`^${ESC}\\[<\\d+;\\d+;\\d+[Mm]$`),
	new RegExp(`^${ESC}\\[\\d+;\\d+;\\d+M$`),
	new RegExp(`^${ESC}\\[M[\\s\\S]{3}$`, "u"),
	// Cursor position (ESC[r;cR, ESC[?r;cR), device status (ESC[0n), device attributes (ESC[?…c, ESC[>…c, ESC[=…c).
	new RegExp(`^${ESC}\\[\\??\\d+;\\d+R$`),
	new RegExp(`^${ESC}\\[\\??\\d*n$`),
	new RegExp(`^${ESC}\\[[?>=][\\d;]*c$`),
	// Mode reports (DECRPM: ESC[?n;m$y) and window reports (ESC[n;n;nt).
	new RegExp(`^${ESC}\\[\\??[\\d;]+\\$y$`),
	new RegExp(`^${ESC}\\[[\\d;]+t$`),
	// String answers: settings (DCS … ST) and colours or the like (OSC … BEL or ST).
	new RegExp(`^${ESC}P[\\s\\S]*${ESC}\\\\$`),
	new RegExp(`^${ESC}\\][\\s\\S]*(?:${BEL}|${ESC}\\\\)$`),
];

/** True when `data` (one onData call) is xterm answering or reporting to the program, not the user's input. */
export function isTerminalReport(data: string): boolean {
	return data.startsWith(ESC) && REPORTS.some((re) => re.test(data));
}
