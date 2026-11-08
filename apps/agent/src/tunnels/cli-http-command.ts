import { type TunnelMapping, parseTunnelArgs } from "@tunelo/client";
import { type Command, Option } from "commander";
import { AGENT_VERSION } from "../version.ts";
import { credentialNotices, setupTunnel } from "./cli-tunnel-setup.js";
import type { Display } from "./display.js";
import { createInspectorIntegration } from "./inspector-integration.js";
import { type RunTunnel, startRunRecord } from "./run-registry.js";
import type { TunnelEvent } from "./tunnel-host.ts";
import { openTerminalTunnel } from "./tunnel-route.ts";

interface HttpOptions {
	subdomain?: string;
	key?: string;
	auth?: string;
	server?: string;
	inspectPort?: string;
	inspect?: boolean;
	quiet?: boolean;
	verbose?: boolean;
}

export function registerHttpCommand(program: Command, display: Display): void {
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
		// The local portal is gone; its flags stay accepted so scripts of 1.x keep working.
		.addOption(new Option("--portal-port <port>").hideHelp())
		.addOption(new Option("--no-portal").hideHelp())
		.option("-q, --quiet", "Suppress request logging")
		.option("-v, --verbose", "Show extra details (body size)")
		.action((portArgs: string[], options: HttpOptions) =>
			runHttp(portArgs, options, display),
		);
}

async function runHttp(
	portArgs: string[],
	options: HttpOptions,
	display: Display,
): Promise<void> {
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

	display.showBanner(AGENT_VERSION);
	display.showConnecting(serverUrl);

	const [primary] = tunnels;
	if (!primary) process.exit(1);
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

	const notices = credentialNotices(setup.credential, display);

	// Record this process so `tunelo status`/`kill` can see and stop it.
	const run = startRunRecord("http", serverUrl);
	const runTunnels: RunTunnel[] = [];

	let started = false;

	const onConnected = (url: string, subdomain: string): void => {
		subdomainPortMap.set(subdomain, primary.port);
		tunnelUrls.set(subdomain, url);
		runTunnels.push({ url, localPort: primary.port });
		run.update(runTunnels);
		display.showConnected(
			url,
			`http://localhost:${primary.port}`,
			setup.displayKey,
			options.auth !== undefined,
		);
		// A reconnect reports the tunnel again; the local servers run once.
		if (started) return;
		started = true;
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
	};

	const onEvent = (event: TunnelEvent): void => {
		notices(event);
		switch (event.type) {
			case "connected":
				onConnected(event.url, event.subdomain);
				return;
			case "tunnel-registered":
				subdomainPortMap.set(event.subdomain, event.localPort);
				tunnelUrls.set(event.subdomain, event.url);
				runTunnels.push({ url: event.url, localPort: event.localPort });
				run.update(runTunnels);
				display.showTunnelRegistered(
					event.subdomain,
					event.url,
					event.localPort,
				);
				return;
			case "tunnel-register-error":
				display.showError(`Tunnel ${event.subdomain}: ${event.error}`);
				return;
			case "inspector-entry":
				inspector?.store.add(event.entry);
				return;
			case "disconnected":
				display.showDisconnected();
				return;
			case "reconnecting":
				display.showReconnecting(event.attempt, event.delay);
				return;
			case "request":
				display.logRequest(
					event.method,
					event.path,
					event.status,
					event.durationMs,
					undefined,
					event.subdomain,
				);
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
				kind: "http",
				server: serverUrl,
				tunnels: tunnels.map(({ port, subdomain }) =>
					subdomain ? { port, subdomain } : { port },
				),
				...(options.subdomain ? { subdomain: options.subdomain } : {}),
				...(options.auth ? { auth: options.auth } : {}),
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
}
