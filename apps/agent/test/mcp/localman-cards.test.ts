// Localman writes on the approval card: a request's headers with credentials
// masked, the start of its body without credentials, whether it reaches the
// user's own machine; saving a request names the collection it goes to (the
// id when Localman does not say in time). The save runs once approved only.
import { Decision, PromptState } from "@achoo254/chat-proto/remote/remote";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { needsApproval, sessionTool } from "../../src/mcp/groups.ts";
import { bodyExcerpt, cardHeaders, reachesLocal } from "../../src/mcp/localman-cards.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { fakeProvider } from "../fake-provider.ts";
import { byCase, makeCore } from "../harness.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { textOf } from "../support/mcp-harness.ts";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJsbSJ9.c2lnbG0";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"; // secret-approved: fake fixture
const SAVE = {
	collectionId: "col-1",
	kind: "request",
	parentId: null,
	name: "Health",
	draft: {
		method: "get",
		url: "https://api.example/health",
		headers: [
			{ id: "h1", key: "Accept", value: "application/json", enabled: true },
			{ id: "h2", key: "X-Api-Key", value: "k-123456", enabled: true },
			{ id: "h3", key: "X-Off", value: "x", enabled: false },
		],
	},
};

describe("what a Localman request shows on a card", () => {
	test("credential headers are masked, others cut to 120 characters and redacted", () => {
		const headers = cardHeaders([
			{ name: "Authorization", value: `Bearer ${JWT}` },
			{ name: "Cookie", value: "sid=1" },
			{ name: "Set-Cookie", value: "sid=2" },
			{ name: "X-Session-Token", value: "t" },
			{ name: "Client-Secret", value: "s" },
			{ name: "X-Api-Key", value: "k" },
			{ name: "Password", value: "p" },
			{ name: "Accept", value: "a".repeat(200) },
			{ name: "X-Trace", value: `carried ${JWT}` },
		]);
		expect(headers.slice(0, 7).every((h) => h.masked && h.value === "")).toBe(true);
		expect(headers[7]).toEqual({ name: "Accept", value: `${"a".repeat(120)}…`, masked: false });
		expect(headers[8]?.masked).toBe(false);
		expect(headers[8]?.value).not.toContain(JWT);
	});

	test("the body excerpt is the first 400 characters, without bearer tokens, JWTs or named secrets", () => {
		const body = JSON.stringify({ token: JWT, password: "hunter22", note: "x".repeat(600) });
		const excerpt = bodyExcerpt(body);
		expect(excerpt.length).toBeLessThanOrEqual(400);
		expect(excerpt).not.toContain(JWT);
		expect(excerpt).not.toContain("hunter22");
		expect(bodyExcerpt("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
	});

	test("a URL on the user's own machine or network reaches local", () => {
		for (const url of ["http://localhost:5173/api", "http://app.localhost/x", "http://127.0.0.1:8080", "http://10.1.2.3", "http://172.20.0.1", "http://192.168.1.5", "http://169.254.169.254/latest", "http://[::1]:3000", "http://printer.local"]) {
			expect(reachesLocal(url)).toBe(true);
		}
		for (const url of ["https://api.example/health", "http://172.32.0.1", "http://8.8.8.8", "not a url"]) expect(reachesLocal(url)).toBe(false);
	});

	test("create_collection_node is a write of the localman group", () => {
		expect(sessionTool("localman_create_collection_node")).toMatchObject({ tool: "create_collection_node", group: { name: "localman" } });
		expect(needsApproval("localman_create_collection_node", SAVE)).toBe(true);
		expect(sessionTool("localman_create_collection")).toBeUndefined();
	});
});

describe("Localman writes through tunelo's MCP", () => {
	let localman: FakeMcpApp;
	beforeAll(async () => {
		localman = await startFakeMcpApp();
		localman.accepted.add(TOKEN);
	});
	afterAll(async () => {
		await localman.close();
	});
	beforeEach(() => {
		localman.calls.length = 0;
	});

	async function setup() {
		const { core, work } = makeCore([fakeProvider()]);
		const remote = new RemoteProxy({ endpoint: () => localman.url, token: async () => TOKEN, forget: async () => undefined, account: () => "a" });
		const host = new McpHost(work, {
			remote,
			asksEveryWrite: (who) => core.asksEveryWrite(who),
			askWrite: (who, call, signal) => core.askWrite(who, call, signal),
		});
		const thread = await core.create({
			provider: "fake",
			model: "",
			dir: work,
			text: "",
			consent: { sensitive: false, projectSettings: false },
			device: "phone",
			chat: { chatId: 7n, title: "Team", app: "" },
		});
		const id = host.open("wss://tunnel.example", host.tickets.issue(thread.id));
		const pending = () => byCase(core.snapshot(thread.id), "approval").filter((c) => c.body.value.state === PromptState.PENDING);
		/** Calls `tool` and answers its card with `decision`; the card and the result. */
		const run = async (tool: string, args: Record<string, unknown>, decision: Decision) => {
			const call = host.call(id, "localman", tool, args);
			await vi.waitFor(() => expect(pending()).toHaveLength(1));
			const card = pending()[0];
			if (!card) throw new Error("no card");
			core.respond(thread.id, card.id, card.revision, { decision }, "phone");
			return { card: card.body.value, result: await call };
		};
		const stop = async () => {
			host.endAll();
			await core.stop();
		};
		return { host, run, stop };
	}

	test("send_request: the card shows the masked headers, the body excerpt and that it goes through the user's machine", async () => {
		const s = await setup();
		const card = await s.host.describeWrite("localman_send_request", {
			method: "post",
			url: "http://localhost:5173/api",
			headers: [
				{ name: "Authorization", value: `Bearer ${JWT}` },
				{ name: "Content-Type", value: "application/json" },
			],
			body: '{"password":"hunter22","name":"An"}',
			bodyType: "text",
		});
		expect(card?.summary).toBe("POST http://localhost:5173/api (through your machine)");
		expect(card?.write).toMatchObject({
			tool: "localman_send_request",
			method: "POST",
			url: "http://localhost:5173/api",
			reachesLocal: true,
			textLength: 35,
			headers: [
				{ name: "Authorization", value: "", masked: true },
				{ name: "Content-Type", value: "application/json", masked: false },
			],
		});
		expect(card?.write.text).toContain('"name":"An"');
		expect(card?.write.text).not.toContain("hunter22");
		expect(JSON.stringify(card?.write.headers)).not.toContain(JWT);
		await s.stop();
	});

	test("create_collection_node: the card names the collection, the request and its masked headers; approved, it saves", async () => {
		const s = await setup();
		const { card, result } = await s.run("create_collection_node", SAVE, Decision.ALLOW);
		expect(card.summary).toBe("Save the request «Health» to «Health checks»: GET https://api.example/health");
		expect(card.write).toMatchObject({
			tool: "localman_create_collection_node",
			title: "Health",
			method: "GET",
			url: "https://api.example/health",
			collectionId: "col-1",
			collectionName: "Health checks",
			headers: [
				{ name: "Accept", value: "application/json", masked: false },
				{ name: "X-Api-Key", value: "", masked: true },
			],
		});
		expect(result.isError).toBeUndefined();
		expect(localman.calls.filter((c) => c.name === "create_collection_node")).toHaveLength(1);
		await s.stop();
	});

	test("declined, nothing is saved", async () => {
		const s = await setup();
		const { result } = await s.run("create_collection_node", SAVE, Decision.DENY);
		expect(textOf(result)).toMatch(/not approved/);
		expect(localman.calls.map((c) => c.name)).not.toContain("create_collection_node");
		await s.stop();
	});

	test("a collection Localman does not name, or not in time, shows its id", async () => {
		const s = await setup();
		const unknown = await s.host.describeWrite("localman_create_collection_node", { ...SAVE, collectionId: "col-x" });
		expect(unknown?.summary).toMatch(/^Save the request «Health» to collection col-x: /);
		expect(unknown?.write).toMatchObject({ collectionId: "col-x", collectionName: "" });
		const started = Date.now();
		const slow = await s.host.describeWrite("localman_create_collection_node", { ...SAVE, collectionId: "col-slow" });
		expect(slow?.write).toMatchObject({ collectionId: "col-slow", collectionName: "" });
		expect(Date.now() - started).toBeLessThan(3_900);
		await s.stop();
	}, 10_000);
});
