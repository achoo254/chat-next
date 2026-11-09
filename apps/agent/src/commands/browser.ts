// `tunelo browser status|close|clear`: the Chrome profile tunelo keeps for
// Claude (remote-browser/browser-profile.ts). `clear` deletes it, signing out
// of every site signed in to in it; it goes to the consent log.
import { join } from "node:path";
import type { Command } from "commander";
import { configDir } from "../config.ts";
import { clearProfile, findBrowser, profileDir, runningBrowser, stopBrowser } from "../remote-browser/browser-profile.ts";
import { AuditLog } from "../safety/audit-log.ts";

type Exits = <A extends unknown[]>(run: (...args: A) => Promise<number>) => (...args: A) => Promise<void>;

export async function runBrowser(action: string, dir: string, print: (line: string) => void): Promise<number> {
	const profile = profileDir(dir);
	if (action === "status") {
		const exe = findBrowser();
		const running = await runningBrowser(profile);
		print(`browser: ${exe ?? "none found (install Chrome, or set TUNELO_BROWSER)"}`);
		print(`profile: ${profile}`);
		print(running ? `running: yes, debugging port ${running.port} on 127.0.0.1${running.headless ? " (headless)" : ""}` : "running: no");
		return 0;
	}
	if (action === "close") {
		print((await stopBrowser(profile)) ? "Closed the tunelo browser; its sign-ins stay in the profile." : "The tunelo browser is not running.");
		return 0;
	}
	if (action === "clear") {
		const { removed } = await clearProfile(profile);
		if (removed) new AuditLog(join(dir, "audit.jsonl")).write({ device: "local", action: "browser_clear", path: "", detail: "" });
		print(removed ? "Deleted the tunelo browser's profile: every site signed in to in it is signed out." : "The tunelo browser has no profile yet.");
		return 0;
	}
	throw new Error(`unknown action ${action}: use status, close or clear`);
}

export function registerBrowserCommand(program: Command, exits: Exits): void {
	const browser = program.command("browser").description("the Chrome profile tunelo keeps for Claude (separate from your own browsers)");
	browser
		.command("status")
		.description("which browser, where the profile is, whether it runs")
		.action(exits(() => runBrowser("status", configDir(), (line) => console.log(line))));
	browser
		.command("close")
		.description("close it (sign-ins stay)")
		.action(exits(() => runBrowser("close", configDir(), (line) => console.log(line))));
	browser
		.command("clear")
		.description("delete its profile: signs out of every site in it")
		.action(exits(() => runBrowser("clear", configDir(), (line) => console.log(line))));
}
