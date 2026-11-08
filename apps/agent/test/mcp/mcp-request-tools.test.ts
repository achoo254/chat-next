import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
	InspectorEntry,
	InspectorEntrySummary,
} from "../request-store.js";
import type { RunRecord } from "../run-registry.js";
import {
	type FakeTunnelServer,
	startFakeTunnelServer,
} from "../test-support/fake-tunnel-server.js";
import {
	buildCliBundle,
	cliEnv,
	jsonOf,
	mcpClient,
	textOf,
	waitFor,
} from "../test-support/mcp-harness.js";
import { MCP_BODY_LIMIT } from "./request-tools.js";

const BIG_BODY = "x".repeat(MCP_BODY_LIMIT + 100);

let bundle: string;
let tunnelServer: FakeTunnelServer;
let app: http.Server;
let appPort: number;
let home: string;
let client: Client;

beforeAll(async () => {
	bundle = await buildCliBundle("tunelo-mcp-tools-test");
	tunnelServer = await startFakeTunnelServer();
	app = http.createServer((req, res) => {
		if (req.url === "/big") res.end(BIG_BODY);
		else if (req.url === "/bin") res.end(Buffer.from([0xff, 0xfe, 0x00]));
		else res.end(`seen ${req.url}`);
	});
	await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
	const address = app.address();
	appPort = typeof address === "object" && address ? address.port : 0;
	home = mkdtempSync(join(tmpdir(), "tunelo-mcp-tools-"));
	const connection = mcpClient(bundle, tunnelServer.wsUrl, home);
	client = connection.client;
	await client.connect(connection.transport);
});

afterAll(async () => {
	await client.close();
	await tunnelServer.close();
	await new Promise<void>((r) => app.close(() => r()));
	rmSync(home, { recursive: true, force: true });
});

function call(
	name: string,
	args: Record<string, unknown> = {},
): ReturnType<Client["callTool"]> {
	return client.callTool({ name, arguments: args });
}

type RequestList = { total: number; requests: InspectorEntrySummary[] };

/** Requests land in the log once the response is done: poll until `count`. */
async function requestsOf(tunnel: string, count: number): Promise<RequestList> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const listed = jsonOf<RequestList>(
			await call("list_tunnel_requests", { tunnel }),
		);
		if (listed.total >= count || Date.now() > deadline) return listed;
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("tunelo mcp: requests and tunnel processes", () => {
	test("new tools carry their annotations", async () => {
		const { tools } = await client.listTools();
		const hints = (name: string) =>
			tools.find((tool) => tool.name === name)?.annotations;
		for (const name of ["list_tunnel_requests", "get_tunnel_request"]) {
			expect(hints(name)).toMatchObject({ readOnlyHint: true });
		}
		for (const name of [
			"close_local_tunnel_process",
			"revoke_linked_machine",
		]) {
			expect(hints(name)).toMatchObject({ destructiveHint: true });
		}
	});

	test("lists and reads requests through a tunnel it opened", async () => {
		const tunnel = jsonOf<{ id: string; url: string }>(
			await call("open_http_tunnel", { port: appPort, subdomain: "inspected" }),
		);
		await (await fetch(`${tunnel.url}/hello`)).text();
		await (await fetch(`${tunnel.url}/big`)).text();
		await (await fetch(`${tunnel.url}/bin`)).arrayBuffer();

		const listed = await requestsOf(tunnel.id, 3);
		expect(listed.requests.map((r) => r.path)).toEqual([
			"/bin",
			"/big",
			"/hello",
		]);

		const filtered = jsonOf<RequestList>(
			await call("list_tunnel_requests", { tunnel: tunnel.id, path: "hel" }),
		);
		expect(filtered.requests).toHaveLength(1);

		const [bin, big, hello] = listed.requests;
		const binary = jsonOf<InspectorEntry & { responseBodyEncoding: string }>(
			await call("get_tunnel_request", { tunnel: tunnel.id, id: bin?.id }),
		);
		expect(binary.responseBody).toBe("//4A");
		expect(binary.responseBodyEncoding).toBe("base64");
		const detail = jsonOf<InspectorEntry>(
			await call("get_tunnel_request", { tunnel: tunnel.id, id: hello?.id }),
		);
		expect(detail.responseBody).toBe("seen /hello");

		const clipped = jsonOf<
			InspectorEntry & { responseBodyOmittedChars: number }
		>(await call("get_tunnel_request", { tunnel: tunnel.id, id: big?.id }));
		expect(clipped.responseBody).toHaveLength(MCP_BODY_LIMIT);
		expect(clipped.responseBodyOmittedChars).toBe(100);

		const missing = await call("get_tunnel_request", {
			tunnel: tunnel.id,
			id: "nope",
		});
		expect(missing.isError).toBe(true);
		const badStatus = await call("list_tunnel_requests", {
			tunnel: tunnel.id,
			status: "abc",
		});
		expect(badStatus.isError).toBe(true);
		await call("close_tunnel", { id: tunnel.id });
	});

	test("reads and stops a `tunelo http` running in another process", async () => {
		const child: ChildProcess = spawn(
			process.execPath,
			[bundle, "http", String(appPort), "-s", "watched", "--server"].concat([
				tunnelServer.wsUrl,
				"--no-portal",
				"--inspect-port",
				"47140",
			]),
			{ env: cliEnv(home), stdio: "ignore" },
		);
		const exited = new Promise((r) => child.once("exit", r));
		const recordFile = join(home, ".tunelo/running", `${child.pid}.json`);
		const record = (): RunRecord | null =>
			existsSync(recordFile)
				? (JSON.parse(readFileSync(recordFile, "utf-8")) as RunRecord)
				: null;
		try {
			await waitFor(() => Boolean(record()?.inspectorPort), 15_000);
			const { processes } = jsonOf<{ processes: { pid: number }[] }>(
				await call("list_local_tunnels"),
			);
			expect(processes).toMatchObject([
				{ pid: child.pid, kind: "http", inspectable: true },
			]);

			await (await fetch(`${record()?.tunnels[0]?.url}/elsewhere`)).text();
			// The fake server's URLs carry no subdomain: name the process by PID.
			const listed = await requestsOf(String(child.pid), 1);
			expect(listed.requests[0]?.path).toBe("/elsewhere");
			const detail = jsonOf<InspectorEntry>(
				await call("get_tunnel_request", {
					tunnel: String(child.pid),
					id: listed.requests[0]?.id,
				}),
			);
			expect(detail.responseBody).toBe("seen /elsewhere");

			const stopped = await call("close_local_tunnel_process", {
				target: "watched",
			});
			expect(textOf(stopped)).toContain(`"stopped": ${child.pid}`);
			await exited;
			expect(existsSync(recordFile)).toBe(false);
		} finally {
			if (child.exitCode === null) child.kill();
		}
		const gone = await call("close_local_tunnel_process", {
			target: "watched",
		});
		expect(gone.isError).toBe(true);
	});
});
