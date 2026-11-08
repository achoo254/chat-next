/** CLI handler for `tunelo tcp <port>` command */

import type { Command } from "commander";
import { AGENT_VERSION } from "../version.ts";
import { credentialNotices, setupTunnel } from "./cli-tunnel-setup.js";
import type { Display } from "./display.js";
import { startRunRecord } from "./run-registry.js";
import type { TunnelEvent } from "./tunnel-host.ts";
import { openTerminalTunnel } from "./tunnel-route.ts";

export function registerTcpCommand(program: Command, display: Display): void {
	program
		.command("tcp <port>")
		.description("Create TCP tunnel to local port")
		.option("-k, --key <apikey>", "API key for authentication")
		.option("--server <url>", "Tunnel server URL")
		.option("--remote-port <port>", "Request specific remote port")
		.action(
			async (
				portStr: string,
				options: { key?: string; server?: string; remotePort?: string },
			) => {
				const port = Number(portStr);
				if (!Number.isInteger(port) || port < 1 || port > 65535) {
					display.showError("Invalid port number");
					process.exit(1);
				}
				const remotePort = options.remotePort
					? Number(options.remotePort)
					: undefined;
				if (
					remotePort !== undefined &&
					(!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
				) {
					display.showError("Invalid remote port number");
					process.exit(1);
				}

				const setup = setupTunnel(options, display);

				display.showBanner(AGENT_VERSION);
				display.showConnecting(setup.serverUrl);

				const notices = credentialNotices(setup.credential, display);
				const run = startRunRecord("tcp", setup.serverUrl);

				const onEvent = (event: TunnelEvent): void => {
					notices(event);
					switch (event.type) {
						case "tcp-registered":
							run.update([{ url: event.url, localPort: port }]);
							display.showTcpTunnel(event.url, port);
							return;
						case "tcp-register-error":
							display.showError(`TCP tunnel failed: ${event.error}`);
							return;
						case "disconnected":
							display.showDisconnected();
							return;
						case "reconnecting":
							display.showReconnecting(event.attempt, event.delay);
							return;
						case "error":
							display.showError(event.message);
							return;
						case "failed":
							display.showError(event.message);
							process.exit(1);
							return;
						case "closed":
							display.showError(`The tunnel was ${event.reason}.`);
							process.exit(0);
							return;
						default:
							return;
					}
				};

				let tunnel: Awaited<ReturnType<typeof openTerminalTunnel>>;
				try {
					tunnel = await openTerminalTunnel(
						{
							kind: "tcp",
							server: setup.serverUrl,
							port,
							...(remotePort !== undefined ? { remotePort } : {}),
						},
						setup.credential,
						onEvent,
					);
				} catch (err) {
					display.showError((err as Error).message);
					process.exit(1);
				}

				process.on("SIGINT", () => {
					tunnel.close();
					display.showStats();
					process.exit(0);
				});
			},
		);
}
