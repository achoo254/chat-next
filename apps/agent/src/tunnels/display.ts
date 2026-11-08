import chalk from "chalk";

export type LogLevel = "quiet" | "normal" | "verbose";

/** Mask API key for display — show first 4 and last 4 chars */
function maskKey(key: string): string {
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/** Format duration in human-readable uptime */
function formatUptime(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
	if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
	return `${seconds}s`;
}

/** Explains why a local UI is not on the port the user expected */
function portFallbackNote(port: number, requestedPort?: number): string {
	if (requestedPort === undefined || requestedPort === port) return "";
	return chalk.gray(` (${requestedPort} in use)`);
}

/** The one-line nudge an anonymous machine sees on every run. */
export function legacyReminder(cutoff?: string): string {
	const day = cutoff?.slice(0, 10);
	const when = day ? `stops working on ${day}` : "will stop working soon";
	return `Anonymous token: it ${when}. Run \`tunelo login\` to sign in with your account.`;
}

export class Display {
	private logLevel: LogLevel = "normal";
	private startTime = 0;
	private totalRequests = 0;
	private errorRequests = 0;

	setLogLevel(level: LogLevel): void {
		this.logLevel = level;
	}

	showBanner(version: string): void {
		console.log(chalk.bold(`\n  tunelo v${version}\n`));
	}

	showConnecting(server: string): void {
		console.log(chalk.yellow(`  Connecting to ${server}...`));
	}

	showConnected(
		tunnelUrl: string,
		localUrl: string,
		apiKey?: string,
		authEnabled = false,
	): void {
		this.startTime = Date.now();
		console.log(chalk.green("  Status:    ") + chalk.bold.green("Online"));
		console.log(chalk.green("  Tunnel:    ") + chalk.cyan(tunnelUrl));
		console.log(`${chalk.green("  Forwarding:")} ${localUrl}`);
		if (apiKey) {
			console.log(chalk.green("  API Key:   ") + chalk.gray(maskKey(apiKey)));
		}
		if (authEnabled) {
			console.log(chalk.green("  Auth:      ") + chalk.yellow("enabled"));
		}
		console.log(chalk.gray("  ─".repeat(20)));
	}

	showInspector(port: number, requestedPort?: number): void {
		console.log(
			chalk.green("  Inspector: ") +
				chalk.cyan(`http://localhost:${port}`) +
				portFallbackNote(port, requestedPort),
		);
	}

	showPortal(port: number, requestedPort?: number): void {
		console.log(
			chalk.green("  Portal:    ") +
				chalk.cyan(`http://localhost:${port}`) +
				portFallbackNote(port, requestedPort),
		);
	}

	showTunnelRegistered(
		subdomain: string,
		url: string,
		localPort: number,
	): void {
		console.log(
			`${
				chalk.green("  + Tunnel:  ") + chalk.cyan(url)
			} → http://localhost:${localPort}`,
		);
	}

	showTcpTunnel(url: string, localPort: number): void {
		console.log(
			`${
				chalk.green("  TCP:       ") + chalk.cyan(url)
			} → localhost:${localPort}`,
		);
	}

	showDisconnected(reason?: string): void {
		console.log(chalk.red(`  Disconnected${reason ? `: ${reason}` : ""}`));
	}

	showReconnecting(attempt: number, delayMs: number): void {
		console.log(
			chalk.yellow(`  Reconnecting (attempt ${attempt}, ${delayMs}ms)...`),
		);
	}

	logRequest(
		method: string,
		path: string,
		status: number,
		durationMs: number,
		bodySize?: number,
		subdomain?: string,
	): void {
		this.totalRequests++;
		if (status >= 500) this.errorRequests++;

		// Quiet mode — skip request logging entirely
		if (this.logLevel === "quiet") return;

		const statusColor =
			status < 300 ? chalk.green : status < 500 ? chalk.yellow : chalk.red;
		const methodStr = method.padEnd(7);
		const pathStr = path.length > 40 ? `${path.slice(0, 37)}...` : path;

		const prefix = subdomain ? chalk.magenta(`[${subdomain}] `) : "";
		let line = `  ${prefix}${chalk.bold(methodStr)} ${pathStr.padEnd(42)} ${statusColor(String(status))}  ${chalk.gray(`${durationMs}ms`)}`;

		// Verbose mode — append body size
		if (this.logLevel === "verbose" && bodySize !== undefined) {
			const sizeStr =
				bodySize > 1024 ? `${(bodySize / 1024).toFixed(1)}KB` : `${bodySize}B`;
			line += chalk.gray(`  ${sizeStr}`);
		}

		console.log(line);
	}

	showStats(): void {
		const uptime = this.startTime
			? formatUptime(Date.now() - this.startTime)
			: "0s";
		console.log("");
		console.log(chalk.gray("  ─".repeat(20)));
		console.log(chalk.bold("  Session Summary"));
		console.log(`  Uptime:    ${chalk.cyan(uptime)}`);
		console.log(`  Requests:  ${chalk.green(String(this.totalRequests))}`);
		if (this.errorRequests > 0) {
			console.log(`  Errors:    ${chalk.red(String(this.errorRequests))}`);
		}
		console.log("");
	}

	showLegacyReminder(cutoff?: string): void {
		console.log(chalk.yellow(`  ${legacyReminder(cutoff)}`));
	}

	showAccount(sub: string): void {
		console.log(chalk.green("  Account:   ") + chalk.gray(sub));
	}

	showError(message: string): void {
		console.log(chalk.red(`  Error: ${message}`));
	}
}
