// `tunelo config mcp-local-writes [on|off]`: whether MCP clients outside the
// claude sessions tunelo opens may run write tools (mcp/local-writes.ts).
// The command writes the setting itself; the running service reads it again
// on the next call. Every change goes to the consent log.
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { LocalWritesSetting } from "../mcp/local-writes.ts";
import { AuditLog } from "../safety/audit-log.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

export function describeLocalWrites(enabled: boolean): string[] {
	return enabled
		? [
				"MCP writes outside tunelo's claude sessions: on.",
				"Any MCP client of this user (`claude mcp add tunelo -- tunelo mcp`, or a program that reads tunelo's control file) may send Chat messages, send Localman requests and open or close tunnels as you; only that client's own approval stands in the way.",
				"Turn it off with `tunelo config mcp-local-writes off`.",
			]
		: [
				"MCP writes outside tunelo's claude sessions: off (default). Such clients only read; sessions opened from your device still write, each write approved on the device.",
				"Turn it on with `tunelo config mcp-local-writes on`.",
			];
}

async function localWrites(action: string | undefined): Promise<number> {
	const chosen = (action ?? "status").toLowerCase();
	if (!["on", "off", "status"].includes(chosen)) throw new Error(`unknown action ${chosen}: use on or off`);
	const dir = configDir();
	const setting = new LocalWritesSetting(dir);
	let enabled = setting.enabled();
	if (chosen !== "status") {
		enabled = await setting.set(chosen === "on");
		new AuditLog(join(dir, "audit.jsonl")).write({ device: "local", action: "mcp_local_writes", path: "", detail: chosen });
	}
	for (const line of describeLocalWrites(enabled)) console.log(line);
	return 0;
}

/** Adds `mcp-local-writes` under `tunelo config`. */
export function registerMcpLocalWritesCommand(config: Command, exits: Exits): void {
	config
		.command("mcp-local-writes [action]")
		.description(
			"let MCP clients outside tunelo's claude sessions use write tools (send messages, send requests, open tunnels): on, off (default); no action shows the state",
		)
		.action(exits((action: string | undefined) => localWrites(action)));
}
