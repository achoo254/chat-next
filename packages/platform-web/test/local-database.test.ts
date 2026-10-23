import type { SqlDriverFactory } from "@app/platform";
import { describe, expect, it } from "vitest";
import { soloLocks, type LockManagerLike } from "../src/leader.ts";
import { nativeLocks, openLocalDatabase } from "../src/local-database.ts";

const pool: SqlDriverFactory = { open: () => Promise.reject(new Error("pool")) };
const memory: SqlDriverFactory = { open: () => Promise.reject(new Error("memory")) };

function options(native: boolean, opfsAvailable: boolean, poolFails: boolean) {
	const reports: unknown[] = [];
	return {
		reports,
		options: {
			native,
			opfsAvailable,
			openPool: () => (poolFails ? Promise.reject(new Error("NoModificationAllowedError")) : Promise.resolve(pool)),
			openMemory: () => Promise.resolve(memory),
			report: (err: unknown) => reports.push(err),
		},
	};
}

describe("local database", () => {
	it("keeps the web on OPFS: a failing pool fails the start, with no in-memory fallback", async () => {
		const ok = options(false, true, false);
		await expect(openLocalDatabase(ok.options)).resolves.toBe(pool);
		const failing = options(false, true, true);
		await expect(openLocalDatabase(failing.options)).rejects.toThrow("NoModificationAllowedError");
		// Even without OPFS the web tries the pool and fails as before.
		const missing = options(false, false, true);
		await expect(openLocalDatabase(missing.options)).rejects.toThrow("NoModificationAllowedError");
		expect([...failing.reports, ...missing.reports]).toEqual([]);
	});

	it("lets the native app fall back to memory, and says why", async () => {
		const missing = options(true, false, false);
		await expect(openLocalDatabase(missing.options)).resolves.toBe(memory);
		const failing = options(true, true, true);
		await expect(openLocalDatabase(failing.options)).resolves.toBe(memory);
		const ok = options(true, true, false);
		await expect(openLocalDatabase(ok.options)).resolves.toBe(pool);
		expect(missing.reports).toHaveLength(1);
		expect(failing.reports).toHaveLength(1);
		expect(ok.reports).toEqual([]);
	});

	it("gives the native app a lock manager without Web Locks", () => {
		const real: LockManagerLike = { request: (_n, _o, callback) => callback() };
		expect(nativeLocks(real)).toBe(real);
		expect(nativeLocks(undefined)).toBe(soloLocks);
	});
});
