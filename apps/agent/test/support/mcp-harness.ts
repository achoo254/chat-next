import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { bundleForNode } from "./bundle.ts";

/** The test key the service tunnels with. */
export const TEST_KEY = "tunelo_mcp_test";

/** `tunelo` itself, bundled for node. Each test file passes its own name. */
export function buildCliBundle(name: string): Promise<string> {
	return bundleForNode("src/cli.ts", `${name}-cli`);
}

/** The tunnel side of the background service, bundled for node. */
export function buildServiceBundle(name: string): Promise<string> {
	return bundleForNode("test/support/tunnel-service-entry.ts", `${name}-service`);
}

/** Environment of every process of one test machine: its own home and config folder. */
export function machineEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
	return {
		...getDefaultEnvironment(),
		HOME: home,
		USERPROFILE: home,
		TUNELO_HOME: join(home, "tunelo"),
		TUNELO_KEYSTORE: "file",
		...extra,
	};
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 25));
	}
}

/**
 * Starts the service of this test machine (anonymous `TEST_KEY`, as a
 * machine without an account) and waits until its control socket is up.
 */
export async function startService(bundle: string, home: string): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
	const dir = join(home, "tunelo");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const child = spawn(process.execPath, [bundle], { env: machineEnv(home, { TUNELO_KEY: TEST_KEY }), stdio: "ignore" });
	await waitFor(() => existsSync(join(dir, "control.json")));
	return {
		child,
		stop: () =>
			new Promise((resolve) => {
				if (child.exitCode !== null) return resolve();
				child.once("exit", () => resolve());
				child.kill("SIGTERM");
			}),
	};
}

/** `tunelo mcp` over stdio, not yet connected. */
export function mcpClient(bundle: string, wsUrl: string, home: string): { client: Client; transport: StdioClientTransport } {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [bundle, "mcp", "--server", wsUrl],
		env: machineEnv(home),
		stderr: "ignore",
	});
	return { client: new Client({ name: "test", version: "0.0.0" }), transport };
}

export function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] }).content;
	return content?.[0]?.text ?? "";
}

/** The JSON a tool returned. */
export function jsonOf<T>(result: unknown): T {
	return JSON.parse(textOf(result)) as T;
}
