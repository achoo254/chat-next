#!/usr/bin/env node
import {
	type RegisterTunnelResult,
	TunnelClient,
	type TunnelMapping,
	parseTunnelArgs,
} from "@tunelo/client";
import { program } from "commander";
import { registerLinkCommands } from "./cli-link-command.js";
import { registerLoginCommands } from "./cli-login-command.js";
import { registerMcpCommand } from "./cli-mcp-command.js";
import { registerStatusCommands } from "./cli-status-commands.js";
import { registerTcpCommand } from "./cli-tcp-command.js";
import { setupTunnel, showCredentialNotices } from "./cli-tunnel-setup.js";
import { registerUpdateCommand } from "./cli-update-command.js";
import { registerWatchCommand } from "./cli-watch-command.js";
import { registerWhoamiCommand } from "./cli-whoami-command.js";
import { getConfigPath, loadConfig, saveConfig } from "./config.js";
import { Display } from "./display.js";
import { createInspectorIntegration } from "./inspector-integration.js";
import { startPortalServer, stopPortalServer } from "./portal-server.js";
import type { InspectorEntry } from "./request-store.js";
import { type RunTunnel, startRunRecord } from "./run-registry.js";
import { VERSION } from "./version.js";

const display = new Display();

program
	.name("tunelo")
	.version(VERSION)
	.description("Expose local services to the internet");

program
	.command("http <ports...>")
	.description("Create HTTP tunnel(s). Format: <port> or <port>:<subdomain>")
	.option(
		"-s, --subdomain <name>",
		"Request specific subdomain (single tunnel only)",
	)
	.option("-k, --key <apikey>", "API key for authentication")
	.option("--server <url>", "Tunnel server URL")
	.option("-a, --auth <user:pass>", "Protect tunnel(s) with Basic Auth")
	.option(
		"--inspect-port <port>",
		"Inspector UI port; next free port is used if taken (default: 4040)",
		"4040",
	)
	.option("--no-inspect", "Disable request inspector")
	.option(
		"--portal-port <port>",
		"Portal server port; next free port is used if taken (default: 4041)",
		"4041",
	)
	.option("--no-portal", "Disable the portal server")
	.option("-q, --quiet", "Suppress request logging")
	.option("-v, --verbose", "Show extra details (body size)")
	.action(
		async (
			portArgs: string[],
			options: {
				subdomain?: string;
				key?: string;
				auth?: string;
				server?: string;
				inspectPort?: string;
				inspect?: boolean;
				portalPort?: string;
				portal?: boolean;
				quiet?: boolean;
				verbose?: boolean;
			},
		) => {
			let tunnels: TunnelMapping[];
			try {
				tunnels = parseTunnelArgs(portArgs);
			} catch (err) {
				display.showError((err as Error).message);
				process.exit(1);
			}

			const setup = setupTunnel(options, display);
			const { serverUrl } = setup;

			if (options.quiet) display.setLogLevel("quiet");
			else if (options.verbose) display.setLogLevel("verbose");

			display.showBanner(VERSION);
			display.showConnecting(serverUrl);

			const primary = tunnels[0];
			const additional = tunnels.slice(1);
			const subdomainPortMap = new Map<string, number>();
			const tunnelUrls = new Map<string, string>();
			const inspectPort = Number(options.inspectPort) || 4040;

			const inspector =
				options.inspect !== false
					? createInspectorIntegration({
							inspectPort,
							subdomainPortMap,
							tunnelUrls,
							defaultPort: primary.port,
						})
					: null;

			const client = new TunnelClient({
				...setup.clientOptions,
				subdomain: options.subdomain ?? primary.subdomain,
				localPort: primary.port,
				auth: options.auth,
				additionalTunnels: additional,
			});

			showCredentialNotices(client, setup.credential, display);

			// Record this process so `tunelo status`/`kill` can see and stop it.
			const run = startRunRecord("http", serverUrl);
			const runTunnels: RunTunnel[] = [];

			const portalPort = Number(options.portalPort) || 4041;
			const portalEnabled = options.portal !== false;

			client.on("connected", (result: { url: string; subdomain: string }) => {
				subdomainPortMap.set(result.subdomain, primary.port);
				tunnelUrls.set(result.subdomain, result.url);
				runTunnels.push({ url: result.url, localPort: primary.port });
				run.update(runTunnels);
				display.showConnected(
					result.url,
					`http://localhost:${primary.port}`,
					setup.displayKey,
					options.auth !== undefined,
				);
				if (inspector) {
					inspector
						.start()
						.then((boundPort) => {
							run.setInspectorPort(boundPort);
							display.showInspector(boundPort, inspectPort);
						})
						.catch((err: Error) => {
							display.showError(`Inspector failed to start: ${err.message}`);
						});
				}
				if (portalEnabled) {
					startPortalServer(portalPort)
						.then((boundPort) => {
							display.showPortal(boundPort, portalPort);
						})
						.catch((err: Error) => {
							display.showError(
								`Portal server failed to start: ${err.message}`,
							);
						});
				}
			});

			client.on("tunnel-registered", (result: RegisterTunnelResult) => {
				subdomainPortMap.set(result.subdomain, result.localPort);
				tunnelUrls.set(result.subdomain, result.url);
				runTunnels.push({ url: result.url, localPort: result.localPort });
				run.update(runTunnels);
				display.showTunnelRegistered(
					result.subdomain,
					result.url,
					result.localPort,
				);
			});

			client.on("tunnel-register-error", (result: RegisterTunnelResult) => {
				display.showError(`Tunnel ${result.subdomain}: ${result.error}`);
			});

			if (inspector) {
				client.on("inspector-entry", (entry: InspectorEntry) => {
					inspector.store.add(entry);
				});
			}

			client.on("disconnected", () => display.showDisconnected());
			client.on("reconnecting", (info: { attempt: number; delay: number }) => {
				display.showReconnecting(info.attempt, info.delay);
			});
			client.on(
				"request",
				(info: {
					method: string;
					path: string;
					status: number;
					durationMs: number;
					subdomain?: string;
				}) => {
					display.logRequest(
						info.method,
						info.path,
						info.status,
						info.durationMs,
						undefined,
						info.subdomain,
					);
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
				if (portalEnabled) void stopPortalServer();
				display.showStats();
				process.exit(0);
			});
		},
	);

registerTcpCommand(program, display);
registerLoginCommands(program);
registerWhoamiCommand(program);
registerLinkCommands(program);
registerMcpCommand(program);
registerStatusCommands(program);
registerWatchCommand(program);
registerUpdateCommand(program);

program
	.command("config")
	.description("Set default configuration")
	.option("-k, --key <apikey>", "Set default anonymous access token")
	.option("-s, --server <url>", "Set default server URL")
	.option("--show", "Show current config")
	.action((options: { key?: string; server?: string; show?: boolean }) => {
		if (options.show) {
			const { key, session, ...rest } = loadConfig();
			// Tokens never go to the terminal: show only that they exist.
			const shown = {
				...rest,
				...(key ? { key: "(saved)" } : {}),
				...(session
					? { session: { issuer: session.issuer, account: session.sub } }
					: {}),
			};
			console.log(`Config path: ${getConfigPath()}`);
			console.log(JSON.stringify(shown, null, 2));
			return;
		}

		const config = loadConfig();
		if (options.key) config.key = options.key;
		if (options.server) config.server = options.server;
		saveConfig(config);
		console.log("Config saved.");
	});

program.parse();
