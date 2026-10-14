import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Code } from "@connectrpc/connect";
import { ChatType } from "@app/proto-ts/chats";
import { databaseName, signInUrl } from "../src/auth/web.ts";
import { startApp } from "../src/app/start-app.ts";
import { SessionEndedError } from "../src/protocol/api.ts";
import { FakeServer } from "./support/fake-server.ts";
import { dbName, settle, startTestApp, testPlatform, TENANT } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-10-14T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("web sign-in URLs", () => {
	it("builds /auth/login with the display locale and prompt=create", () => {
		expect(signInUrl("vi")).toBe("/auth/login?locale=vi");
		expect(signInUrl("en", { create: true })).toBe("/auth/login?prompt=create&locale=en");
		expect(signInUrl("<script>")).toBe("/auth/login?");
	});

	it("names the local database per (tenant, user)", () => {
		expect(databaseName("chat.hoandat.com", 42)).toBe("chat-chat.hoandat.com-42.sqlite3");
		expect(databaseName("chat.inetdev.io.vn", 42)).not.toBe(databaseName("chat.hoandat.com", 42));
		expect(() => databaseName("x", 0)).toThrow(RangeError);
	});
});

describe("session end wipes local data", () => {
	it("on SessionRevokedFrame", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const ended: string[] = [];
		const { core } = await startTestApp(server, self, sql, { onSessionEnded: (reason) => ended.push(reason) });
		server.sendMessage(a, chat, "riêng tư");
		await settle(core);
		expect(sql.files.has(dbName(self))).toBe(true);
		server.revokeSessions(self);
		await vi.advanceTimersByTimeAsync(50);
		expect(ended).toEqual(["revoked_by_user"]);
		expect(sql.files.has(dbName(self))).toBe(false);
		expect(core.sessionEnded()).toBe("revoked_by_user");
		await expect(core.dialogs()).rejects.toBeInstanceOf(SessionEndedError);
	});

	it("on 401 from an RPC", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const a = server.addUser("An");
		const chat = server.createChat(ChatType.GROUP, "G", [self, a]);
		const sql = new MemorySqlFactory();
		const ended: string[] = [];
		const { core } = await startTestApp(server, self, sql, { onSessionEnded: (reason) => ended.push(reason) });
		await settle(core);
		server.faults.push({ method: "getHistory", when: "before", code: Code.Unauthenticated, remaining: 1 });
		const view = await core.history(chat);
		expect(view.failure).toBe("unauthenticated");
		await vi.advanceTimersByTimeAsync(10);
		expect(ended).toEqual(["unauthenticated"]);
		expect(sql.files.has(dbName(self))).toBe(false);
	});

	it("on a WebSocket handshake rejected for an expired cookie", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		const sql = new MemorySqlFactory();
		const ended: string[] = [];
		const { core } = await startTestApp(server, self, sql, { onSessionEnded: (reason) => ended.push(reason) });
		await settle(core);
		// The cookie expired: sockets are refused and RPCs answer 401.
		server.revokeSessions(self);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(ended).toHaveLength(1);
		expect(sql.files.has(dbName(self))).toBe(false);
	});

	it("reports signed_out without touching storage when there is no session", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		server.revokeSessions(self);
		const sql = new MemorySqlFactory();
		const result = await startApp(testPlatform(server, self, sql), {
			api: server.apiFor(self),
			realtimeUrl: "wss://chat.example.test/ws",
			appVersion: "test",
			client: "web",
			tenant: TENANT,
		});
		expect(result).toEqual({ status: "signed_out", reason: "unauthenticated" });
		expect(sql.files.size).toBe(0);
	});

	it("drops another account's cache when the cookie belongs to someone else", async () => {
		const server = new FakeServer();
		const previous = server.addUser("Cũ");
		const current = server.addUser("Mới");
		const sql = new MemorySqlFactory();
		const ended: string[] = [];
		// The hint names the previous user, but the socket authenticates `current`.
		const platform = { ...testPlatform(server, current, sql) };
		const result = await startApp(platform, {
			api: server.apiFor(current),
			realtimeUrl: "wss://chat.example.test/ws",
			appVersion: "test",
			client: "web",
			tenant: TENANT,
			userIdHint: previous,
			onSessionEnded: (reason) => ended.push(reason),
		});
		expect(result.status).toBe("active");
		await vi.advanceTimersByTimeAsync(100);
		expect(ended).toEqual(["user_changed"]);
		expect(sql.files.has(dbName(previous))).toBe(false);
	});
});
