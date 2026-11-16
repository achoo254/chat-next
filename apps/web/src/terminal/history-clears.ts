// A program clearing its history in the live terminal (ED 3 on the normal screen in any spelling: ESC[3J,
// ESC[03J, ESC[3;J, ESC[?3J; or a full reset, ESC c): the rows loaded from before go at once, as the machine
// drops them too (it never serves rows from before a clear). Seen as xterm parses the output, so it is in step
// with what the screen shows; xterm still runs its own handling.
import type { IDisposable, Terminal } from "@xterm/xterm";

/** The part of xterm this uses. */
export type ParsingTerminal = Pick<Terminal, "parser"> & { readonly buffer: { readonly active: { readonly type: string } } };

export function watchHistoryClears(term: ParsingTerminal, cleared: () => void): IDisposable {
	const eraseInDisplay = (params: (number | number[])[]): boolean => {
		const first = params[0];
		const mode = Array.isArray(first) ? first[0] : first;
		// A full-screen program's own screen has no history: the machine ignores it there too.
		if (mode === 3 && term.buffer.active.type === "normal") cleared();
		return false;
	};
	const subscriptions = [
		term.parser.registerCsiHandler({ final: "J" }, eraseInDisplay),
		term.parser.registerCsiHandler({ prefix: "?", final: "J" }, eraseInDisplay),
		term.parser.registerEscHandler({ final: "c" }, () => {
			cleared();
			return false;
		}),
	];
	return { dispose: () => subscriptions.forEach((s) => s.dispose()) };
}
