// A tunnel the service holds for a terminal closes when that terminal goes,
// even when nothing tells the service: killed outright (no socket close
// reaches a Bun service), or frozen (its pid still alive, as a reused pid
// would be) so that it stops confirming it holds the stream. Runs the
// service under node and, when bun is installed, under bun (the release
// runtime). Unix only: Windows has no SIGSTOP (accept there by hand).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { callControl } from "../src/control-socket.ts";
import { type FakeTunnelServer, startFakeTunnelServer } from "./support/fake-tunnel-server.ts";
import { bundleForNode } from "./support/bundle.ts";
import { TEST_KEY, machineEnv, waitFor } from "./support/mcp-harness.ts";

const agentRoot = resolve(import.meta.dirname, "..");
const hasBun = spawnSync("bun", ["--version"]).status === 0;
const runtimes = ["node", ...(hasBun ? ["bun"] : [])];

let server: FakeTunnelServer;
let app: http.Server;
let appPort = 0;
let serviceBundle = "";
let holderBundle = "";

beforeAll(async () => {
	server = await startFakeTunnelServer();
	app = http.createServer((_req, res) => res.end("ok"));
	await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
	const address = app.address();
	appPort = typeof address === "object" && address ? address.port : 0;
	serviceBundle = await bundleForNode("test/support/tunnel-service-entry.ts", "holders-service");
	holderBundle = await bundleForNode("test/support/stream-holder.ts", "holders-holder");
});

afterAll(async () => {
	await server.close();
	await new Promise<void>((r) => app.close(() => r()));
});

function startServiceUnder(runtime: string, home: string): ChildProcess {
	const env = machineEnv(home, { TUNELO_KEY: TEST_KEY, TUNELO_TEST_STREAM_TIMEOUT_MS: "3000" });
	const args = runtime === "bun" ? [join(agentRoot, "test/support/tunnel-service-entry.ts")] : [serviceBundle];
	return spawn(runtime === "bun" ? "bun" : process.execPath, args, { env, stdio: "ignore", cwd: agentRoot });
}

function startHolder(home: string): { child: ChildProcess; lines: string[] } {
	const lines: string[] = [];
	const child = spawn(process.execPath, [holderBundle, server.wsUrl, String(appPort)], { env: machineEnv(home) });
	child.stdout?.on("data", (c: Buffer) => lines.push(...c.toString().split("\n").filter(Boolean)));
	return { child, lines };
}

describe.skipIf(process.platform === "win32").each(runtimes)("service under %s", (runtime) => {
	let home = "";
	let service: ChildProcess;

	beforeAll(async () => {
		home = mkdtempSync(join(tmpdir(), `tunelo-holders-${runtime}-`));
		mkdirSync(join(home, "tunelo"), { recursive: true });
		service = startServiceUnder(runtime, home);
		await waitFor(() => existsSync(join(home, "tunelo", "control.json")), 10_000);
	});

	afterAll(() => {
		service.kill("SIGTERM");
		rmSync(home, { recursive: true, force: true });
	});

	test("a holder killed outright: its tunnel closes within seconds", async () => {
		const { child, lines } = startHolder(home);
		await waitFor(() => lines.some((l) => l.includes('"connected"')), 10_000);
		expect(server.openSockets()).toBe(1);
		child.kill("SIGKILL");
		const killedAt = Date.now();
		await waitFor(() => server.openSockets() === 0, 4_000);
		expect(Date.now() - killedAt).toBeLessThan(4_000);
	});

	test("a holder that stops confirming (frozen, pid still alive): its tunnel closes after the timeout", async () => {
		const { child, lines } = startHolder(home);
		await waitFor(() => lines.some((l) => l.includes('"connected"')), 10_000);
		child.kill("SIGSTOP");
		try {
			await waitFor(() => server.openSockets() === 0, 8_000);
		} finally {
			child.kill("SIGKILL");
		}
	});

	test("a stream without the holder's pid is refused", async () => {
		const dir = join(home, "tunelo");
		const control = JSON.parse(readFileSync(join(dir, "control.json"), "utf8")) as { port: number; token: string };
		const status = await new Promise<number>((done) => {
			const req = http.request(
				{ host: "127.0.0.1", port: control.port, method: "POST", path: "/tunnels/open", headers: { "x-chat-agent-token": control.token } },
				(res) => {
					res.resume();
					done(res.statusCode ?? 0);
				},
			);
			req.end(JSON.stringify({ kind: "http", server: server.wsUrl, tunnels: [{ port: appPort }] }));
		});
		expect(status).toBe(400);
		expect(await callControl(dir, "GET", "/status")).toMatchObject({ tunnels: 0 });
	});
});
