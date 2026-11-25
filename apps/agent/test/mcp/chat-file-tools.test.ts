// chat_send_file: only regular files of the session's folder go (links
// followed, `..`, folders and tunelo's own folders refused); the approval
// card lists them before a byte is uploaded; allowed, they are uploaded in
// parts to the media host and posted as one message or an album; a chat
// hidden from AI or of an app that takes only what the user types says so.
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Decision, PromptState } from "@achoo254/chat-proto/remote/remote";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { checkFile, describeFiles } from "../../src/mcp/chat-file-tools.ts";
import { McpHost } from "../../src/mcp/mcp-host.ts";
import { RemoteProxy } from "../../src/mcp/remote-proxy.ts";
import { createSensitiveCheck } from "../../src/safety/sensitive-paths.ts";
import { fakeProvider } from "../fake-provider.ts";
import { byCase, makeCore } from "../harness.ts";
import { COMPOSER_ONLY_CHAT, type FakeMcpApp, HIDDEN_CHAT, startFakeMcpApp } from "../support/fake-mcp-app.ts";
import { textOf } from "../support/mcp-harness.ts";

const posix = process.platform !== "win32";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJjaGF0In0.c2lnZmlsZQ"; // secret-approved: fake fixture
const PNG = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.from("tiny image bytes")]);

/** A session folder with a photo, a file, an attachment, tunelo's config inside it and a file outside it. */
function folder() {
	const root = mkdtempSync(join(tmpdir(), "chat-files-"));
	const work = join(root, "work");
	const configDir = join(work, ".tunelo-config");
	mkdirSync(join(work, ".tunelo-attachments", "2026-11-25"), { recursive: true });
	mkdirSync(join(work, "sub"), { recursive: true });
	mkdirSync(configDir, { recursive: true });
	writeFileSync(join(work, "shot.png"), PNG);
	writeFileSync(join(work, "notes.txt"), "plain notes");
	writeFileSync(join(work, ".tunelo-attachments", "2026-11-25", "photo.png"), PNG);
	writeFileSync(join(configDir, "machine-key"), "secret");
	writeFileSync(join(root, "outside.txt"), "not yours");
	const isSensitive = createSensitiveCheck({ home: join(root, "home"), configDir });
	return { root, work, configDir, isSensitive };
}

describe("the files a session may send", () => {
	test("regular files of its folder and its attachments go, with their type and size", () => {
		const { work, isSensitive } = folder();
		const shot = checkFile(work, "shot.png", isSensitive);
		expect(shot).toMatchObject({ ok: true, file: { name: "shot.png", size: PNG.length, mime: "image/png", kind: "photo" } });
		expect(checkFile(work, join(work, ".tunelo-attachments", "2026-11-25", "photo.png"), isSensitive)).toMatchObject({ ok: true });
		expect(checkFile(work, "notes.txt", isSensitive)).toMatchObject({ ok: true, file: { mime: "text/plain", kind: "document" } });
	});

	test("refuses a file outside, `..`, a folder, tunelo's own config and anything missing", () => {
		const { root, work, isSensitive } = folder();
		expect(checkFile(work, join(root, "outside.txt"), isSensitive)).toMatchObject({ ok: false, problem: "outside the session's folder" });
		expect(checkFile(work, "../outside.txt", isSensitive)).toMatchObject({ ok: false, problem: "a path with .. is not allowed" });
		expect(checkFile(work, "sub/../shot.png", isSensitive)).toMatchObject({ ok: false, problem: "a path with .. is not allowed" });
		expect(checkFile(work, "sub", isSensitive)).toMatchObject({ ok: false, problem: "not a regular file" });
		expect(checkFile(work, ".tunelo-config/machine-key", isSensitive)).toMatchObject({ ok: false, problem: "in a sensitive folder" });
		expect(checkFile(work, "nope.png", isSensitive)).toMatchObject({ ok: false, problem: "not found" });
	});

	test.skipIf(!posix)("follows links: one out of the folder or into tunelo's config is refused, one inside goes", () => {
		const { root, work, isSensitive } = folder();
		symlinkSync(join(root, "outside.txt"), join(work, "escape.txt"));
		symlinkSync(join(work, ".tunelo-config", "machine-key"), join(work, "key.txt"));
		symlinkSync(join(work, "shot.png"), join(work, "same.png"));
		expect(checkFile(work, "escape.txt", isSensitive)).toMatchObject({ ok: false, problem: "outside the session's folder" });
		expect(checkFile(work, "key.txt", isSensitive)).toMatchObject({ ok: false, problem: "in a sensitive folder" });
		expect(checkFile(work, "same.png", isSensitive)).toMatchObject({ ok: true, file: { name: "shot.png" } });
		if (posix) expect(checkFile(work, "/dev/null", isSensitive)).toMatchObject({ ok: false });
	});

	test("the card lists each file: a small photo whole as its preview, a refused one with why; stamps of those that go", async () => {
		const { work, isSensitive } = folder();
		writeFileSync(join(work, "big.png"), Buffer.concat([PNG, Buffer.alloc(300 * 1024)]));
		const { files, stamps } = await describeFiles(work, ["shot.png", "big.png", "notes.txt", "../outside.txt"], isSensitive);
		expect(stamps.map((s) => [s.size, s.sha256.length])).toEqual([
			[PNG.length, 64],
			[PNG.length + 300 * 1024, 64],
			[11, 64],
		]);
		expect(files.map((f) => [f.name, f.mime, f.preview?.length ?? 0, f.problem ?? ""])).toEqual([
			["shot.png", "image/png", PNG.length, ""],
			["big.png", "image/png", 0, ""],
			["notes.txt", "text/plain", 0, ""],
			["outside.txt", "", 0, "a path with .. is not allowed"],
		]);
		expect(files[0]?.size).toBe(BigInt(PNG.length));
	});
});

describe("chat_send_file through tunelo's MCP", () => {
	let chat: FakeMcpApp;
	beforeAll(async () => {
		chat = await startFakeMcpApp();
		chat.accepted.add(TOKEN);
	});
	afterAll(async () => {
		await chat.close();
	});
	beforeEach(() => {
		chat.calls.length = 0;
		chat.media.puts = 0;
		chat.media.stored.clear();
		chat.media.uploads.clear();
	});

	/** The host as the service wires it, a core with a Chat conversation's AI thread in `work`, and a client of its session. */
	async function setup() {
		const f = folder();
		const { core } = makeCore([fakeProvider()]);
		const remote = new RemoteProxy({ endpoint: () => chat.url, token: async () => TOKEN, forget: async () => undefined, account: () => "a" });
		const host = new McpHost(f.root, {
			remote,
			asksEveryWrite: (who) => core.asksEveryWrite(who),
			askWrite: (who, call, signal) => core.askWrite(who, call, signal),
			sessionDir: (who) => core.sessionDir(who),
			isSensitive: f.isSensitive,
		});
		const thread = await core.create({ provider: "fake", model: "", dir: f.work, text: "", consent: { sensitive: false, projectSettings: false }, device: "phone", chat: { chatId: 7n, title: "Team", app: "telegram" } });
		const id = host.open("wss://tunnel.example", host.tickets.issue(thread.id));
		const pending = () => byCase(core.snapshot(thread.id), "approval").filter((c) => c.body.value.state === PromptState.PENDING);
		/** Calls chat_send_file and answers its card with `decision` once it shows (after `meanwhile`); what the card said and the result. */
		const send = async (args: Record<string, unknown>, decision: Decision, meanwhile?: () => void) => {
			const call = host.call(id, "chat", "send_file", args);
			await vi.waitFor(() => expect(pending()).toHaveLength(1));
			const card = pending()[0];
			if (!card) throw new Error("no card");
			const putsBefore = chat.media.puts;
			const startedBefore = chat.calls.filter((c) => c.name === "start_media_upload").length;
			meanwhile?.();
			core.respond(thread.id, card.id, card.revision, { decision }, "phone");
			return { card: card.body.value, putsBefore, startedBefore, result: await call };
		};
		const stop = async () => {
			host.endAll();
			await core.stop();
		};
		return { ...f, core, host, thread, send, stop };
	}

	test("the card shows the files before anything is uploaded; allowed, two photos go as one album with the caption", async () => {
		const s = await setup();
		const { card, putsBefore, startedBefore, result } = await s.send({ chat_id: 7, paths: ["shot.png", ".tunelo-attachments/2026-11-25/photo.png"], caption: "look" }, Decision.ALLOW);
		expect([putsBefore, startedBefore]).toEqual([0, 0]);
		expect(card.name).toBe("chat_send_file");
		expect(card.write).toMatchObject({ tool: "chat_send_file", chatId: 7n, chatTitle: "Team", text: "look" });
		expect(card.write?.files.map((f) => [f.name, f.size, f.mime, f.preview.length])).toEqual([
			["shot.png", BigInt(PNG.length), "image/png", PNG.length],
			["photo.png", BigInt(PNG.length), "image/png", PNG.length],
		]);
		expect(result.isError).toBeUndefined();
		// The same bytes twice: the second is already in Chat. Parts of 5 bytes, each with its ETag.
		expect(textOf(result)).toContain("shot.png: uploaded");
		expect(textOf(result)).toContain("photo.png: already in Chat");
		expect(textOf(result)).toContain("Sent an album of 2");
		expect(chat.media.puts).toBe(Math.ceil(PNG.length / 5));
		expect([...chat.media.stored.values()].map((m) => m.bytes.equals(PNG))).toEqual([true]);
		const sends = chat.calls.filter((c) => c.name === "send_media").map((c) => c.args);
		expect(sends).toEqual([{ chat_id: 7, media_ids: ["m1", "m1"], caption: "look" }]);
		// No URL or signature reaches the model.
		expect(textOf(result)).not.toContain("signed-");
		await s.stop();
	});

	test("photos and other files go as two messages, the caption with the first", async () => {
		const s = await setup();
		const { result } = await s.send({ chat_id: 7, paths: ["notes.txt", "shot.png"], caption: "both", reply_to_seq: 3 }, Decision.ALLOW);
		expect(result.isError).toBeUndefined();
		const sends = chat.calls.filter((c) => c.name === "send_media").map((c) => c.args as { media_ids: string[]; caption?: string; reply_to_seq?: number });
		expect(sends.map((a) => [a.media_ids.length, a.caption ?? "", a.reply_to_seq ?? 0])).toEqual([
			[1, "both", 3],
			[1, "", 0],
		]);
		await s.stop();
	});

	test("a file changed after the card showed it is refused, nothing uploaded", async () => {
		const s = await setup();
		const replaced = Buffer.concat([PNG, Buffer.from("another picture")]);
		const { result } = await s.send({ chat_id: 7, paths: ["shot.png"] }, Decision.ALLOW, () => writeFileSync(join(s.work, "shot.png"), replaced));
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("shot.png changed after the user approved it");
		expect(chat.media.puts).toBe(0);
		expect(chat.calls.map((c) => c.name)).not.toContain("start_media_upload");
		await s.stop();
	});

	test("same size and content but rewritten counts as changed too; untouched, the next approval goes", async () => {
		const s = await setup();
		const path = join(s.work, "notes.txt");
		const { result } = await s.send({ chat_id: 7, paths: ["notes.txt"] }, Decision.ALLOW, () => {
			writeFileSync(path, "plain notes");
			const later = new Date(Date.now() + 5_000);
			utimesSync(path, later, later);
		});
		expect(textOf(result)).toContain("changed after the user approved it");
		const again = await s.send({ chat_id: 7, paths: ["notes.txt"] }, Decision.ALLOW);
		expect(again.result.isError).toBeUndefined();
		expect(chat.media.stored.size).toBe(1);
		await s.stop();
	});

	test("declined, nothing is read, uploaded or sent", async () => {
		const s = await setup();
		const { result } = await s.send({ chat_id: 7, paths: ["shot.png"] }, Decision.DENY);
		expect(textOf(result)).toMatch(/not approved/);
		expect(chat.media.puts).toBe(0);
		expect(chat.calls.map((c) => c.name)).not.toContain("start_media_upload");
		expect(chat.calls.map((c) => c.name)).not.toContain("send_media");
		await s.stop();
	});

	test("a file it may not send fails the call before any upload, even once allowed", async () => {
		const s = await setup();
		const { card, result } = await s.send({ chat_id: 7, paths: ["shot.png", ".tunelo-config/machine-key"] }, Decision.ALLOW);
		expect(card.write?.files[1]).toMatchObject({ name: "machine-key", problem: "in a sensitive folder" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(".tunelo-config/machine-key: in a sensitive folder");
		expect(chat.media.puts).toBe(0);
		await s.stop();
	});

	test("a chat hidden from AI says so, before any upload", async () => {
		const s = await setup();
		const { result } = await s.send({ chat_id: HIDDEN_CHAT, paths: ["shot.png"] }, Decision.ALLOW);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("chat_hidden_from_ai");
		expect(textOf(result)).toContain("Nothing was sent");
		expect(chat.media.puts).toBe(0);
		await s.stop();
	});

	test("a Zalo chat, which takes only what the user sends, tells the model to hand the file to the user", async () => {
		const s = await setup();
		const { result } = await s.send({ chat_id: COMPOSER_ONLY_CHAT, paths: ["shot.png"] }, Decision.ALLOW);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("imported_chat_composer_only");
		expect(textOf(result)).toContain("Zalo chỉ nhận tin do chính người dùng gửi");
		await s.stop();
	});

	test("an approval no card listed the files for runs nothing", async () => {
		const s = await setup();
		const ticket = s.host.tickets.issue(s.thread.id);
		const id = s.host.open("wss://tunnel.example", ticket);
		const args = { chat_id: 7, paths: ["shot.png"] };
		s.host.approve(ticket, "chat_send_file", args);
		const result = await s.host.call(id, "chat", "send_file", args);
		expect(textOf(result)).toContain("did not list these files");
		expect(chat.media.puts).toBe(0);
		await s.stop();
	});

	test("a client without a session ticket has no chat_send_file", async () => {
		const s = await setup();
		const local = s.host.open("wss://tunnel.example");
		expect((await s.host.call(local, "chat", "send_file", { chat_id: 7, paths: ["shot.png"] })).isError).toBe(true);
		expect(chat.media.puts).toBe(0);
		await s.stop();
	});
});
