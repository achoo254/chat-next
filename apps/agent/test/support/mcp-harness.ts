import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
	StdioClientTransport,
	getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "../..");

/** The test key every spawned CLI tunnels with. */
export const TEST_KEY = "tunelo_mcp_test";

/**
 * Bundles the CLI like the release does. Each test file passes its own
 * name so parallel workers never write the same bundle. Inside the package
 * so the bundle resolves its runtime deps like the real one.
 */
export async function buildCliBundle(name: string): Promise<string> {
	const outfile = join(cliRoot, `node_modules/.cache/${name}/cli.js`);
	await build({
		entryPoints: [join(cliRoot, "src/cli.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		outfile,
		packages: "external",
		alias: {
			"@tunelo/shared": resolve(cliRoot, "../tunelo-shared/src/index.ts"),
			"@tunelo/client": resolve(cliRoot, "../tunelo-client/src/index.ts"),
		},
		logLevel: "silent",
	});
	return outfile;
}

export function cliEnv(home: string): Record<string, string> {
	return { ...getDefaultEnvironment(), HOME: home, TUNELO_KEY: TEST_KEY };
}

/** `tunelo mcp` over stdio, not yet connected. */
export function mcpClient(
	bundle: string,
	wsUrl: string,
	home: string,
): { client: Client; transport: StdioClientTransport } {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [bundle, "mcp", "--server", wsUrl],
		env: cliEnv(home),
		stderr: "ignore",
	});
	return { client: new Client({ name: "test", version: "0.0.0" }), transport };
}

export function textOf(result: unknown): string {
	const content = (result as { content?: { type: string; text?: string }[] })
		.content;
	return content?.[0]?.text ?? "";
}

/** The JSON a tool returned. */
export function jsonOf<T>(result: unknown): T {
	return JSON.parse(textOf(result)) as T;
}

export async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 25));
	}
}
