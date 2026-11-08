/** CLI handler for `tunelo tcp <port>` command */

import { type TcpRegisterResult, TunnelClient } from "@tunelo/client";
import type { Command } from "commander";
import { setupTunnel, showCredentialNotices } from "./cli-tunnel-setup.js";
import type { Display } from "./display.js";
import { TcpProxy } from "./tcp-proxy.js";
import { VERSION } from "./version.js";

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
				if (Number.isNaN(port) || port < 1 || port > 65535) {
					display.showError("Invalid port number");
					process.exit(1);
				}

				const setup = setupTunnel(options, display);

				display.showBanner(VERSION);
				display.showConnecting(setup.serverUrl);

				const client = new TunnelClient({
					...setup.clientOptions,
					localPort: port,
					tcpOnly: true,
				});
				showCredentialNotices(client, setup.credential, display);

				client.on("connected", () => {
					const remotePort = options.remotePort
						? Number(options.remotePort)
						: undefined;
					client.registerTcp(port, remotePort);
				});

				client.on("tcp-registered", (result: TcpRegisterResult) => {
					display.showTcpTunnel(result.url, port);
					new TcpProxy(client, port);
				});

				client.on("tcp-register-error", (result: TcpRegisterResult) => {
					display.showError(`TCP tunnel failed: ${result.error}`);
				});

				client.on("disconnected", () => display.showDisconnected());
				client.on(
					"reconnecting",
					(info: { attempt: number; delay: number }) => {
						display.showReconnecting(info.attempt, info.delay);
					},
				);
				client.on("error", (err: Error) => display.showError(err.message));

				try {
					await client.connect();
				} catch (err) {
					display.showError((err as Error).message);
					process.exit(1);
				}

				process.on("SIGINT", () => {
					client.disconnect();
					display.showStats();
					process.exit(0);
				});
			},
		);
}
