// The Knowledge Base through tunelo's MCP: its tools as kb_*, read as the
// user; save_note's preview runs freely and the call that saves goes
// through the approval card, which shows the note. A machine whose sign-in
// predates the Knowledge Base still lists the tools, and each one says to
// run `tunelo login`, without a request to the Knowledge Base.
import { Decision, PromptState } from "@achoo254/chat-proto/remote/remote";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { ResourceNotGrantedError, type AppName } from "../../src/identity/session.ts";
import { needsApproval } from "../../src/mcp/groups.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { fakeProvider } from "../fake-provider.ts";
import { byCase, makeCore } from "../harness.ts";
import { type FakeMcpApp, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { textOf } from "../support/mcp-harness.ts";

const TOKENS: Record<string, string> = {
	chat: "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjaGF0In0.c2lnY2hhdA", // secret-approved: fake fixture
	kb: "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJrYiJ9.c2lna2I",
};
const NOTE = { title: "Release checklist", markdown: "- tag\n- deploy\n- check the logs" };

describe("the Knowledge Base tools", () => {
	let chat: FakeMcpApp;
	let kb: FakeMcpApp;
	beforeAll(async () => {
		chat = await startFakeMcpApp();
		kb = await startFakeMcpApp();
		chat.accepted.add(TOKENS.chat ?? "");
		kb.accepted.add(TOKENS.kb ?? "");
	});
	afterAll(async () => {
		await chat.close();
		await kb.close();
	});
	beforeEach(() => {
		kb.calls.length = 0;
		kb.seen.length = 0;
	});

	test("save_note acts for the user only on the call that saves (with its confirm_token)", () => {
		expect(needsApproval("kb_search", { query: "x" })).toBe(false);
		expect(needsApproval("kb_save_note", NOTE)).toBe(false);
		expect(needsApproval("kb_save_note", { ...NOTE, confirm_token: "ct-1" })).toBe(true);
	});

	/** The host as the service wires it, with a core holding a Chat conversation's AI thread and an ordinary one. */
	async function setup(granted = true) {
		const { core, work } = makeCore([fakeProvider()]);
		const remote = new RemoteProxy({
			endpoint: (app: AppName) => (app === "kb" ? kb.url : chat.url),
			token: async (app: AppName) => {
				if (app === "kb" && !granted) throw new ResourceNotGrantedError("https://kb.example/mcp");
				return TOKENS[app] ?? TOKENS.chat ?? "";
			},
			forget: async () => undefined,
			account: () => "a",
		});
		const host = new McpHost(work, {
			remote,
			asksEveryWrite: (who) => core.asksEveryWrite(who),
			askWrite: (who, call, signal) => core.askWrite(who, call, signal),
		});
		const consent = { sensitive: false, projectSettings: false };
		const chatThread = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone", chat: { chatId: 7n, title: "Team", app: "" } });
		const plain = await core.create({ provider: "fake", model: "", dir: work, text: "", consent, device: "phone" });
		const ticket = host.tickets.issue(chatThread.id);
		const id = host.open("wss://tunnel.example", ticket);
		const pending = () => byCase(core.snapshot(chatThread.id), "approval").filter((c) => c.body.value.state === PromptState.PENDING);
		const stop = async () => {
			host.endAll();
			await core.stop();
		};
		return { core, host, ticket, id, chatThread, plain, pending, stop };
	}

	test("are listed as kb_*, and read the Knowledge Base with the kb token", async () => {
		const s = await setup();
		const listed = (await s.host.remoteTools(s.ticket)).tools.map((t) => t.exposed).filter((n) => n.startsWith("kb_"));
		expect(listed.sort()).toEqual(["kb_get_document", "kb_list_spaces", "kb_recent", "kb_save_note", "kb_search"]);
		const found = await s.host.call(s.id, "kb", "search", { query: "deploy" });
		expect(found.isError).toBeUndefined();
		expect(textOf(found)).toContain("https://kb.example/d/d1");
		expect(new Set(kb.seen)).toEqual(new Set([TOKENS.kb]));
		await s.stop();
	});

	test("save_note: the preview runs without a card; the saving call shows the note on a card and saves once allowed", async () => {
		const s = await setup();
		const preview = await s.host.call(s.id, "kb", "save_note", NOTE);
		expect(preview.isError).toBeUndefined();
		expect(textOf(preview)).toContain("ct-1");
		expect(s.pending()).toHaveLength(0);

		const saving = s.host.call(s.id, "kb", "save_note", { ...NOTE, confirm_token: "ct-1" });
		await vi.waitFor(() => expect(s.pending()).toHaveLength(1));
		const card = s.pending()[0];
		if (!card) throw new Error("no card");
		expect(card.body.value.name).toBe("kb_save_note");
		expect(card.body.value.summary).toBe(`Save a private note «Release checklist» to your private Space: ${NOTE.markdown}`);
		expect(card.body.value.write).toMatchObject({ tool: "kb_save_note", title: "Release checklist", space: "", visibility: "private", text: NOTE.markdown, textLength: NOTE.markdown.length });
		expect(kb.calls.filter((c) => (c.args as { confirm_token?: string }).confirm_token)).toHaveLength(0);
		s.core.respond(s.chatThread.id, card.id, card.revision, { decision: Decision.ALLOW }, "phone");
		const saved = await saving;
		expect(saved.isError).toBeUndefined();
		expect(textOf(saved)).toContain("https://kb.example/d/d2");
		await s.stop();
	});

	test("an ordinary thread's saving call without an approval is refused; the Space shows on the card line", async () => {
		const s = await setup();
		const id = s.host.open("wss://tunnel.example", s.host.tickets.issue(s.plain.id));
		expect(textOf(await s.host.call(id, "kb", "save_note", { ...NOTE, confirm_token: "ct-1" }))).toMatch(/not approved/);
		expect(kb.calls.map((c) => c.name)).not.toContain("save_note");
		const card = await s.host.describeWrite("kb_save_note", { ...NOTE, space: "ops", confirm_token: "ct-1" });
		expect(card?.summary).toMatch(/^Save a private note «Release checklist» to the Space ops: /);
		expect(card?.write).toMatchObject({ space: "ops", visibility: "private" });
		await s.stop();
	});

	test("a machine signed in before the Knowledge Base lists its tools, and each says to run tunelo login, without asking it anything", async () => {
		const s = await setup(false);
		const offered = await s.host.remoteTools(s.ticket);
		const kbTools = offered.tools.filter((t) => t.group === "kb");
		expect(kbTools.map((t) => t.exposed).sort()).toEqual(["kb_get_document", "kb_list_spaces", "kb_recent", "kb_save_note", "kb_search"]);
		expect(kbTools.every((t) => t.description.includes("tunelo login"))).toBe(true);
		const answer = await s.host.call(s.id, "kb", "search", { query: "deploy" });
		expect(answer.isError).toBe(true);
		expect(textOf(answer)).toContain("Máy này chưa được cấp quyền Knowledge Base: chạy `tunelo login` trên máy rồi thử lại.");
		expect(textOf(answer)).toContain("does not cover Knowledge Base yet");
		expect(kb.seen).toEqual([]);
		// Chat goes on as before.
		expect((await s.host.call(s.id, "chat", "list_chats", {})).isError).toBeUndefined();
		await s.stop();
	});
});
