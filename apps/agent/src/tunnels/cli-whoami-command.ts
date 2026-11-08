import type { Command } from "commander";
import { printServerMigration, resolveServerUrl } from "./server-url.js";
import { describeWhoAmI, whoAmI } from "./whoami.js";

export function registerWhoamiCommand(program: Command): void {
	program
		.command("whoami")
		.description("Show which account (or anonymous token) this machine uses")
		.option("--server <url>", "Tunnel server URL")
		.action(async (options: { server?: string }) => {
			const serverUrl = resolveServerUrl(options.server, printServerMigration);
			try {
				console.log(`  ${describeWhoAmI(await whoAmI(serverUrl))}`);
			} catch (err) {
				console.error(
					`  Could not reach the server: ${(err as Error).message}`,
				);
				process.exit(1);
			}
		});
}
