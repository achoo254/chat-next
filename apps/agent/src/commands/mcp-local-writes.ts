// `tunelo config mcp-local-writes [on|off]`: whether MCP clients outside the
// claude sessions tunelo opens may run write tools (mcp/local-writes.ts).
// The command writes the setting itself; the running service reads it again
// on the next call. Every change goes to the consent log.
//
// Turning writes on asks the person at the keyboard: it runs only when stdin
// and stdout are both a terminal and they type "yes". An AI client's shell
// tool or a script has no terminal, so it cannot turn writes on for itself;
// turning them off always works. This is a speed bump against a model acting
// on its own, not a wall against code of the same user (that code can write
// the file directly).
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { LocalWritesSetting } from "../mcp/local-writes.ts";
import { AuditLog } from "../safety/audit-log.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

/** The person at the keyboard, if any. */
export interface Terminal {
	/** stdin and stdout are both a terminal. */
	interactive: boolean;
	ask(question: string): Promise<string>;
	print(line: string): void;
	printError(line: string): void;
}

export const NEEDS_TERMINAL =
	"tunelo: turning MCP writes on needs a person at a terminal. Run `tunelo config mcp-local-writes on` yourself in a terminal window (not from an AI client, a script or a pipe) and type yes when asked.";

const CONFIRM_QUESTION = 'Any MCP client of this user could then send messages and requests as you. Type "yes" to turn writes on: ';

export function describeLocalWrites(enabled: boolean): string[] {
	return enabled
		? [
				"MCP writes outside tunelo's claude sessions: on.",
				"Any MCP client of this user (`claude mcp add tunelo -- tunelo mcp`, or a program that reads tunelo's control file) may send Chat messages, send Localman requests and open or close tunnels as you; only that client's own approval stands in the way.",
				"Turn it off with `tunelo config mcp-local-writes off`.",
			]
		: [
				"MCP writes outside tunelo's claude sessions: off (default). Such clients only read; sessions opened from your device still write, each write approved on the device.",
				"Turn it on with `tunelo config mcp-local-writes on` in a terminal.",
			];
}

/** Runs the command against the config folder `dir`; returns the exit code. */
export async function runLocalWrites(action: string | undefined, dir: string, term: Terminal): Promise<number> {
	const chosen = (action ?? "status").toLowerCase();
	if (!["on", "off", "status"].includes(chosen)) throw new Error(`unknown action ${chosen}: use on or off`);
	const setting = new LocalWritesSetting(dir);
	let enabled = setting.enabled();
	if (chosen === "on" && !enabled) {
		if (!term.interactive) {
			term.printError(NEEDS_TERMINAL);
			return 1;
		}
		for (const line of describeLocalWrites(true).slice(1, 2)) term.print(line);
		const answer = (await term.ask(CONFIRM_QUESTION).catch(() => "")).trim().toLowerCase();
		if (answer !== "yes") {
			term.print("Nothing changed: writes stay off.");
			return 1;
		}
	}
	if (chosen !== "status") {
		enabled = await setting.set(chosen === "on");
		new AuditLog(join(dir, "audit.jsonl")).write({ device: "local", action: "mcp_local_writes", path: "", detail: chosen });
	}
	for (const line of describeLocalWrites(enabled)) term.print(line);
	return 0;
}

function processTerminal(): Terminal {
	return {
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		async ask(question) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				return await rl.question(question);
			} finally {
				rl.close();
			}
		},
		print: (line) => console.log(line),
		printError: (line) => console.error(line),
	};
}

/** Adds `mcp-local-writes` under `tunelo config`. */
export function registerMcpLocalWritesCommand(config: Command, exits: Exits): void {
	config
		.command("mcp-local-writes [action]")
		.description(
			"let MCP clients outside tunelo's claude sessions use write tools (send messages, send requests, open tunnels): on (asks in a terminal), off (default); no action shows the state",
		)
		.action(exits((action: string | undefined) => runLocalWrites(action, configDir(), processTerminal())));
}
