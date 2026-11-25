// The sqlite-wasm driver runs the shared migrations, FTS5 with the vifold
// tokenizer and atomic batches exactly like the native test driver.
import { describe, expect, it } from "vitest";
import { EventBus, migrate, Repository, searchLocal, searchText, SCHEMA_VERSION } from "@achoo254/chat-core";
import { factoryOfPool, openMemoryFactory, type SahpoolLike } from "../src/driver.ts";

async function repository(): Promise<Repository> {
	const factory = await openMemoryFactory();
	const driver = await factory.open("test.sqlite3");
	expect(await migrate(driver)).toBe("ready");
	return new Repository(driver, new EventBus((cb) => queueMicrotask(cb)));
}

describe("sqlite-wasm driver", () => {
	it("runs the shared migrations", async () => {
		const repo = await repository();
		const rows = await repo.driver.query("PRAGMA user_version");
		expect(rows[0]?.user_version).toBe(SCHEMA_VERSION);
	});

	it("indexes folded Vietnamese text with FTS5", async () => {
		const repo = await repository();
		const text = "Hẹn gặp lúc Tám giờ";
		await repo.driver.batch([
			{
				sql: `INSERT INTO messages (chat_id, seq, from_id, date, text, entities, reply_to_seq, edit_date,
					edit_version, random_id, grouped_id, via_bot_id, reactions, integration_label, search_text)
					VALUES (1, 1, 2, 0, ?, '[]', 0, 0, 0, 0, 0, 0, '[]', '', ?)`,
				params: [text, searchText(text)],
			},
		]);
		expect((await searchLocal(repo, "hen gap tam")).map((m) => m.seq)).toEqual([1]);
		expect(await searchLocal(repo, "khong co")).toEqual([]);
	});

	it("applies a batch atomically", async () => {
		const repo = await repository();
		await expect(
			repo.driver.batch([
				{ sql: "INSERT INTO users (id, username, name, bio, is_bot, is_self, is_blocked) VALUES (1, '', 'a', '', 0, 0, 0)" },
				{ sql: "INSERT INTO nowhere VALUES (1)" },
			]),
		).rejects.toThrow();
		expect(await repo.driver.query("SELECT * FROM users")).toEqual([]);
	});

	it("refuses work after close", async () => {
		const repo = await repository();
		await repo.driver.close();
		await expect(repo.driver.query("SELECT 1")).rejects.toThrow("closed");
	});
});

describe("opfs-sahpool factory", () => {
	function fakePool(paused: boolean) {
		const calls: string[] = [];
		const opened: string[] = [];
		let isPaused = paused;
		const pool = {
			OpfsSAHPoolDb: function (path: string): never {
				opened.push(path);
				throw new Error("a real database is not opened by this test");
			},
			unlink: (path: string) => calls.push(`unlink ${path}`),
			isPaused: () => isPaused,
			unpauseVfs: async () => {
				calls.push("unpause");
				isPaused = false;
			},
			pauseVfs: () => {
				calls.push("pause");
				isPaused = true;
			},
		};
		return { pool: pool as unknown as SahpoolLike, calls, opened };
	}

	it("takes the access handles back when the pool it gets was released earlier", async () => {
		const { pool, calls } = fakePool(true);
		await factoryOfPool(pool);
		expect(calls).toEqual(["unpause"]);
	});

	it("leaves a pool that is in use alone", async () => {
		const { pool, calls } = fakePool(false);
		await factoryOfPool(pool);
		expect(calls).toEqual([]);
	});

	it("gives the access handles back on release, and takes them again on the next factory", async () => {
		const { pool, calls } = fakePool(false);
		const factory = await factoryOfPool(pool);
		await factory.release?.();
		expect(calls).toEqual(["pause"]);
		await factoryOfPool(pool);
		expect(calls).toEqual(["pause", "unpause"]);
	});

	it("opens a database inside the pool under the name's path", async () => {
		const { pool, opened } = fakePool(false);
		const factory = await factoryOfPool(pool);
		await expect(factory.open("u1.sqlite3")).rejects.toThrow("a real database");
		expect(opened).toEqual(["/u1.sqlite3"]);
	});
});
