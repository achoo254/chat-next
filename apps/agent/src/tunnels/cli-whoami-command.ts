import type { Command } from "commander";
import { ConfigStore, configDir } from "../config.ts";
import { callControl } from "../control-socket.ts";
import { AGENT_CLIENT_ID, identitySession } from "../identity/session.ts";
import { type AppsReport, describeApps, storedReport } from "../registration-status.ts";
import { printServerMigration, resolveServerUrl } from "./server-url.js";
import { describeWhoAmI, whoAmI } from "./whoami.js";

/**
 * Each app's state: from the running service, which knows the latest tries,
 * else from what is stored (the service is not running).
 */
async function appsReport(dir: string): Promise<AppsReport> {
	try {
		return (await callControl(dir, "GET", "/apps")) as AppsReport;
	} catch {
		return storedReport(new ConfigStore(dir), identitySession(dir));
	}
}

export function registerWhoamiCommand(program: Command): void {
	program
		.command("whoami")
		.description("Show which account this machine uses, and where it stands with the tunnel, Chat and Localman")
		.option("--server <url>", "Tunnel server URL")
		.action(async (options: { server?: string }) => {
			const serverUrl = resolveServerUrl(options.server, printServerMigration);
			const dir = configDir();
			try {
				console.log(`  ${describeWhoAmI(await whoAmI(serverUrl))}`);
			} catch (err) {
				console.error(
					`  Could not reach the server: ${(err as Error).message}`,
				);
				process.exit(1);
			}
			const info = identitySession(dir).info();
			if (!info) return;
			if (info.clientId !== AGENT_CLIENT_ID) {
				console.log("  This sign-in covers the tunnel only: run `tunelo login` once for Chat and Localman too.");
			}
			for (const line of describeApps(await appsReport(dir))) console.log(`  ${line}`);
		});
}
