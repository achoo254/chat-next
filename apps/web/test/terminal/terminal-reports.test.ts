// xterm's own reports to the program (focus, mouse, answers to queries) are told apart from what the user typed,
// so they never bring the view back from the history.
import { describe, expect, it } from "vitest";
import { isTerminalReport } from "../../src/terminal/terminal-reports.ts";

const E = "\x1b";

describe("xterm's reports to the program", () => {
	it("are reports: focus, mouse, cursor position, status, attributes, modes, window, settings, colours", () => {
		const reports = [
			`${E}[I`,
			`${E}[O`,
			`${E}[<0;12;5M`,
			`${E}[<64;3;9m`,
			`${E}[32;12;5M`,
			`${E}[M !!`,
			`${E}[12;40R`,
			`${E}[?12;40R`,
			`${E}[0n`,
			`${E}[?62;22c`,
			`${E}[>0;276;0c`,
			`${E}[?2004;1$y`,
			`${E}[8;24;80t`,
			`${E}P1$r0m${E}\\`,
			`${E}]11;rgb:1111/1313/1818\x07`,
			`${E}]10;rgb:e6e6/e8e8/eeee${E}\\`,
		];
		for (const r of reports) expect(isTerminalReport(r), JSON.stringify(r)).toBe(true);
	});

	it("are not what the user types, pastes or composes", () => {
		const input = ["a", "ls\r", "\r", "\x7f", "\x03", `${E}`, `${E}[A`, `${E}OA`, `${E}[Z`, `${E}[15~`, `${E}[1;5C`, `${E}b`, "chữ Việt", `${E}[200~pasted${E}[201~`];
		for (const i of input) expect(isTerminalReport(i), JSON.stringify(i)).toBe(false);
	});
});
