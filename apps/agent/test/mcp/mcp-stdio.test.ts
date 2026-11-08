import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type FakeTunnelServer,
	startFakeTunnelServer,
} from "../test-support/fake-tunnel-server.js";
import {
	TEST_KEY,
	buildCliBundle,
	mcpClient,
	textOf,
	waitFor,
} from "../test-support/mcp-harness.js";

let bundle: string;
let tunnelServer: FakeTunnelServer;
let app: http.Server;
let appPort: number;
let home: string;

beforeAll(async () => {
	bundle = await buildCliBundle("tunelo-mcp-test");
	tunnelServer = await startFakeTunnelServer();
	app = http.createServer((_req, res) => res.end("hello from the local app"));
	await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
	const address = app.address();
	appPort = typeof address === "object" && address ? address.port : 0;
	home = mkdtempSync(join(tmpdir(), "tunelo-mcp-"));
});

afterAll(async () => {
	await tunnelServer.close();
	await new Promise<void>((r) => app.close(() => r()));
	rmSync(home, { recursive: true, force: true });
});

function connectClient(): ReturnType<typeof mcpClient> {
	return mcpClient(bundle, tunnelServer.wsUrl, home);
}

describe("tunelo mcp over stdio", () => {
	test("opens a tunnel that serves the local app, lists and closes it", async () => {
		const { client, transport } = connectClient();
		await client.connect(transport);
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name).sort()).toEqual([
			"close_local_tunnel_process",
			"close_tunnel",
			"get_tunnel_request",
			"list_linked_machines",
			"list_local_tunnels",
			"list_tunnel_requests",
			"open_http_tunnel",
			"open_tcp_tunnel",
			"revoke_linked_machine",
			"tunnel_status",
			"whoami",
		]);
		expect(
			tools.tools.find((t) => t.name === "close_tunnel")?.annotations,
		).toMatchObject({
			destructiveHint: true,
		});

		const opened = await client.callTool({
			name: "open_http_tunnel",
			arguments: { port: appPort, subdomain: "agent-app" },
		});
		const tunnel = JSON.parse(textOf(opened)) as { id: string; url: string };
		expect(tunnel.url).toMatch(/\/t\/agent-app$/);
		expect(tunnelServer.authKeys).toContain(TEST_KEY);

		const res = await fetch(`${tunnel.url}/`);
		expect(await res.text()).toBe("hello from the local app");

		const listed = await client.callTool({
			name: "list_local_tunnels",
			arguments: {},
		});
		expect(JSON.parse(textOf(listed)).tunnels).toHaveLength(1);

		await client.callTool({
			name: "close_tunnel",
			arguments: { id: tunnel.id },
		});
		await waitFor(() => tunnelServer.openSockets() === 0);
		await client.close();
	});

	test("every tunnel closes when the MCP process goes away", async () => {
		const { client, transport } = connectClient();
		await client.connect(transport);
		for (const subdomain of ["exit-a", "exit-b"]) {
			await client.callTool({
				name: "open_http_tunnel",
				arguments: { port: appPort, subdomain },
			});
		}
		await waitFor(() => tunnelServer.openSockets() === 2);
		await client.close();
		await waitFor(() => tunnelServer.openSockets() === 0);
	});

	test("refuses a TCP tunnel without a ttl", async () => {
		const { client, transport } = connectClient();
		await client.connect(transport);
		const result = await client.callTool({
			name: "open_tcp_tunnel",
			arguments: { port: appPort },
		});
		expect(result.isError).toBe(true);
		await client.close();
	});
});
