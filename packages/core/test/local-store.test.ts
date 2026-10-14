// Mapping, migrations, events, search and snapshot of the local store.
import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageSchema } from "@app/proto-ts/messages";
import { UpdateFrameSchema } from "@app/proto-ts/realtime";
import { UpdateSchema } from "@app/proto-ts/updates";
import { EventBus, EventKeys } from "../src/events/bus.ts";
import type { Message } from "../src/model/types.ts";
import { toMessage, toUpdateBatch, toWireId } from "../src/protocol/map.ts";
import { MIGRATIONS, migrate, SCHEMA_VERSION } from "../src/repo/migrations.ts";
import { Repository } from "../src/repo/repository.ts";
import { putMessage, putNewMessage, WriteBatch } from "../src/repo/writes.ts";
import { purgeChat } from "../src/purge/index.ts";
import { ftsQuery, searchLocal } from "../src/search/index.ts";
import { buildSnapshot, parseSnapshot } from "../src/snapshot/snapshot.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

const TOO_BIG = 2n ** 53n;

function message(chatId: number, seq: number, text: string, fromId = 7): Message {
	return toMessage(create(MessageSchema, { chatId: BigInt(chatId), seq: BigInt(seq), fromId: BigInt(fromId), text }));
}

async function store(): Promise<{ repo: Repository; bus: EventBus; flushes: string[][] }> {
	const sql = new MemorySqlFactory();
	const driver = await sql.open("store.sqlite3");
	await migrate(driver);
	const flushes: string[][] = [];
	const bus = new EventBus((cb) => queueMicrotask(cb));
	bus.subscribeBatches((keys) => flushes.push([...keys]));
	return { repo: new Repository(driver, bus), bus, flushes };
}

describe("protocol mapping (ADR 0001)", () => {
	it("turns int64 ids into numbers", () => {
		const m = message(5, 9, "x", 3);
		expect(m).toMatchObject({ chatId: 5, seq: 9, fromId: 3, action: null, mediaKind: null });
		expect(toWireId(9)).toBe(9n);
	});

	it("rejects ids at or above 2^53 instead of rounding them", () => {
		expect(() => toMessage(create(MessageSchema, { chatId: TOO_BIG, seq: 1n }))).toThrow(RangeError);
		const frame = create(UpdateFrameSchema, {
			updates: [create(UpdateSchema, { pts: TOO_BIG, ptsCount: 1, kind: { case: "messageNew", value: {} } })],
		});
		expect(() => toUpdateBatch(frame)).toThrow(RangeError);
		expect(() => toWireId(2 ** 53)).toThrow(RangeError);
	});

	it("keeps unknown update kinds and actions visible as unknown/unsupported", () => {
		const batch = toUpdateBatch(create(UpdateFrameSchema, { updates: [create(UpdateSchema, { pts: 1n, ptsCount: 1 })] }));
		expect(batch.updates[0]?.body).toEqual({ kind: "unknown" });
		const unsupported = toMessage(create(MessageSchema, { chatId: 1n, seq: 1n, action: {} }));
		expect(unsupported.action).toEqual({ kind: "unsupported" });
	});
});

describe("migrations", () => {
	it("are idempotent and record the schema version", async () => {
		const sql = new MemorySqlFactory();
		const driver = await sql.open("m.sqlite3");
		expect(await migrate(driver)).toBe("ready");
		expect(await migrate(driver)).toBe("ready");
		const rows = await driver.query("PRAGMA user_version");
		expect(Number(rows[0]?.user_version)).toBe(SCHEMA_VERSION);
		expect(MIGRATIONS.length).toBeGreaterThan(0);
	});

	it("ask for a reset when the database comes from a newer build", async () => {
		const sql = new MemorySqlFactory();
		const driver = await sql.open("m.sqlite3");
		await driver.batch([{ sql: `PRAGMA user_version = ${SCHEMA_VERSION + 1}` }]);
		expect(await migrate(driver)).toBe("reset_required");
	});

	it("keep the schema ready for forum topics", async () => {
		const sql = new MemorySqlFactory();
		const driver = await sql.open("m.sqlite3");
		await migrate(driver);
		const columns = (await driver.query("PRAGMA table_info(messages)")).map((r) => r.name);
		expect(columns).toContain("topic_id");
		const readKey = (await driver.query("PRAGMA table_info(read_states)")).filter((r) => Number(r.pk) > 0).map((r) => r.name);
		expect(readKey).toEqual(["chat_id", "topic_id"]);
		const indexes = (await driver.query("PRAGMA index_list(messages)")).map((r) => r.name);
		expect(indexes).toContain("messages_by_topic");
	});
});

describe("event bus", () => {
	it("delivers each changed key once per frame", async () => {
		const frames: (() => void)[] = [];
		const bus = new EventBus((cb) => frames.push(cb));
		const seen: string[] = [];
		bus.subscribe(EventKeys.dialog(1), () => seen.push("dialog:1"));
		bus.subscribe(EventKeys.history(1), () => seen.push("history:1"));
		bus.subscribe(EventKeys.dialog(2), () => seen.push("dialog:2"));
		for (let i = 0; i < 100; i++) {
			bus.emit(EventKeys.dialog(1));
			bus.emit(EventKeys.history(1));
		}
		expect(frames).toHaveLength(1);
		expect(seen).toEqual([]);
		frames.shift()?.();
		expect(seen).toEqual(["dialog:1", "history:1"]);
	});

	it("keeps delivering when one subscriber throws", () => {
		const errors: unknown[] = [];
		const bus = new EventBus((cb) => cb(), (err) => errors.push(err));
		const seen: string[] = [];
		bus.subscribe("k", () => {
			throw new Error("boom");
		});
		bus.subscribe("k", () => seen.push("second"));
		bus.emit("k");
		expect(seen).toEqual(["second"]);
		expect(errors).toHaveLength(1);
	});

	it("announces only committed writes", async () => {
		const { repo, flushes } = await store();
		const w = new WriteBatch();
		putNewMessage(w, message(1, 1, "chào"), 99);
		await repo.commit(w);
		await Promise.resolve();
		expect(flushes.flat()).toContain(EventKeys.history(1));
		const failing = new WriteBatch().add("INSERT INTO nowhere VALUES (1)").emit(EventKeys.history(2));
		await expect(repo.commit(failing)).rejects.toThrow();
		await Promise.resolve();
		expect(flushes.flat()).not.toContain(EventKeys.history(2));
	});
});

describe("local search (FTS5 + vifold)", () => {
	it("finds Vietnamese text without diacritics, by prefix, per chat", async () => {
		const { repo } = await store();
		const w = new WriteBatch();
		putMessage(w, message(1, 1, "Tiếng Việt có dấu"));
		putMessage(w, message(1, 2, "Đường đi khó"));
		putMessage(w, message(2, 1, "tiếng anh"));
		await repo.commit(w);
		expect((await searchLocal(repo, "tieng viet")).map((m) => m.seq)).toEqual([1]);
		expect((await searchLocal(repo, "duong")).map((m) => m.text)).toEqual(["Đường đi khó"]);
		expect((await searchLocal(repo, "tie")).length).toBe(2);
		expect((await searchLocal(repo, "tie", { chatId: 2 })).map((m) => m.chatId)).toEqual([2]);
		expect(await searchLocal(repo, "   ")).toEqual([]);
		// Every token is quoted, so user input cannot inject FTS5 syntax.
		expect(ftsQuery('a" OR b*')).toBe('"a" "or" "b"*');
	});

	it("forgets edited, deleted and purged text", async () => {
		const { repo } = await store();
		const w = new WriteBatch();
		putMessage(w, message(1, 1, "mật khẩu cũ"));
		putMessage(w, message(2, 1, "bí mật nhóm"));
		await repo.commit(w);
		const edit = new WriteBatch();
		putMessage(edit, { ...message(1, 1, "đã sửa"), editVersion: 1 });
		purgeChat(edit, 2);
		await repo.commit(edit);
		expect(await searchLocal(repo, "mat")).toEqual([]);
		expect(await searchLocal(repo, "da sua")).toHaveLength(1);
	});
});

describe("cold-start snapshot", () => {
	it("round-trips through storage and rejects foreign or malformed data", async () => {
		const { repo } = await store();
		const w = new WriteBatch();
		for (let seq = 1; seq <= 40; seq++) putNewMessage(w, message(1, seq, `tin ${seq}`), 99);
		await repo.commit(w);
		const snapshot = await buildSnapshot(repo, 99, 1, 1_000);
		expect(snapshot.dialogs).toHaveLength(1);
		expect(snapshot.openChat?.messages).toHaveLength(30);
		expect(snapshot.openChat?.messages.at(-1)?.text).toBe("tin 40");
		const stored: unknown = JSON.parse(JSON.stringify(snapshot));
		expect(parseSnapshot(stored, 99)).toEqual(snapshot);
		expect(parseSnapshot(stored, 100)).toBeNull();
		expect(parseSnapshot({ ...snapshot, dialogs: [{}] }, 99)).toBeNull();
		expect(parseSnapshot("nope", 99)).toBeNull();
	});
});
