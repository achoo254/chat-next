import type { Command } from "commander";
import { configDir } from "../config.ts";
import {
	loadSettings,
	settingsPath,
	updateSettings,
} from "../identity/cli-settings.ts";
import { identitySession } from "../identity/session.ts";

export function registerConfigCommand(program: Command): void {
	program
		.command("config")
		.description("Set default configuration")
		.option("-k, --key <apikey>", "Set default anonymous access token")
		.option("-s, --server <url>", "Set default server URL")
		.option("--show", "Show current config")
		.action((options: { key?: string; server?: string; show?: boolean }) => {
			if (options.show) {
				const { key, ...rest } = loadSettings();
				const session = identitySession(configDir()).info();
				// Tokens never go to the terminal: show only that they exist.
				const shown = {
					...rest,
					...(key ? { key: "(saved)" } : {}),
					...(session
						? { session: { issuer: session.issuer, account: session.sub } }
						: {}),
				};
				console.log(`Config path: ${settingsPath()}`);
				console.log(JSON.stringify(shown, null, 2));
				return;
			}
			updateSettings((settings) => ({
				...settings,
				...(options.key ? { key: options.key } : {}),
				...(options.server ? { server: options.server } : {}),
			}));
			console.log("Config saved.");
		});
}
