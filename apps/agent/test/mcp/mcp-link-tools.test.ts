import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	type FakeTunnelServer,
	startFakeTunnelServer,
} from "../test-support/fake-tunnel-server.js";
import {
	buildCliBundle,
	jsonOf,
	mcpClient,
} from "../test-support/mcp-harness.js";

let tunnelServer: FakeTunnelServer;
let home: string;
let client: Client;

beforeAll(async () => {
	const bundle = await buildCliBundle("tunelo-mcp-link-test");
	tunnelServer = await startFakeTunnelServer();
	// TUNELO_KEY is an anonymous token: the machine has links.
	home = mkdtempSync(join(tmpdir(), "tunelo-mcp-link-"));
	const connection = mcpClient(bundle, tunnelServer.wsUrl, home);
	client = connection.client;
	await client.connect(connection.transport);
});

afterAll(async () => {
	await client.close();
	await tunnelServer.close();
	rmSync(home, { recursive: true, force: true });
});

function call(
	name: string,
	args: Record<string, unknown> = {},
): ReturnType<Client["callTool"]> {
	return client.callTool({ name, arguments: args });
}

describe("tunelo mcp: linked clients", () => {
	test("list is read-only, revoke is destructive", async () => {
		const { tools } = await client.listTools();
		const hints = (name: string) =>
			tools.find((tool) => tool.name === name)?.annotations;
		expect(hints("list_linked_machines")).toMatchObject({ readOnlyHint: true });
		expect(hints("revoke_linked_machine")).toMatchObject({
			destructiveHint: true,
		});
	});

	test("revokes a link only with the confirm token of a dry run", async () => {
		tunnelServer.links.push(
			{ id: "l1", clientName: "Localman", createdAt: null, lastUsedAt: null },
			{ id: "l2", clientName: "Other", createdAt: null, lastUsedAt: null },
		);
		const listed = jsonOf<{ links: { id: string }[] }>(
			await call("list_linked_machines"),
		);
		expect(listed.links.map((link) => link.id)).toEqual(["l1", "l2"]);

		const unconfirmed = await call("revoke_linked_machine", { id: "l1" });
		expect(unconfirmed.isError).toBe(true);
		expect(tunnelServer.links).toHaveLength(2);

		const preview = jsonOf<{
			preview: { link: { clientName: string } };
			confirm_token: string;
		}>(await call("revoke_linked_machine", { id: "l1", dry_run: true }));
		expect(preview.preview.link.clientName).toBe("Localman");
		expect(tunnelServer.links).toHaveLength(2);

		const otherId = await call("revoke_linked_machine", {
			id: "l2",
			confirm_token: preview.confirm_token,
		});
		expect(otherId.isError).toBe(true);

		await call("revoke_linked_machine", {
			id: "l1",
			confirm_token: preview.confirm_token,
		});
		expect(tunnelServer.links.map((link) => link.id)).toEqual(["l2"]);

		const reused = await call("revoke_linked_machine", {
			id: "l1",
			confirm_token: preview.confirm_token,
		});
		expect(reused.isError).toBe(true);
		const unknown = await call("revoke_linked_machine", {
			id: "zz",
			dry_run: true,
		});
		expect(unknown.isError).toBe(true);
	});
});
