// Ending a session deletes the "My machines" device keys with the local data.
import { describe, expect, it } from "vitest";
import { DEVICE_KEYS_DATABASE, wipeDeviceKeys } from "../src/app/device-keys-wipe.ts";

type Outcome = "success" | "error" | "blocked";

function fakeIndexedDb(outcome: Outcome) {
	const deleted: string[] = [];
	return {
		deleted,
		deleteDatabase(name: string) {
			deleted.push(name);
			const request = { onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null };
			queueMicrotask(() => {
				if (outcome === "success") request.onsuccess?.();
				else if (outcome === "error") request.onerror?.();
				else request.onblocked?.();
			});
			return request;
		},
	};
}

describe("wipeDeviceKeys", () => {
	it.each<Outcome>(["success", "error", "blocked"])("deletes the keys database and settles on %s", async (outcome) => {
		const idb = fakeIndexedDb(outcome);
		await wipeDeviceKeys(idb);
		expect(idb.deleted).toEqual([DEVICE_KEYS_DATABASE]);
	});

	it("does nothing without IndexedDB", async () => {
		await expect(wipeDeviceKeys(undefined)).resolves.toBeUndefined();
	});

	it("settles when storage refuses the deletion", async () => {
		const idb = {
			deleteDatabase(): never {
				throw new Error("SecurityError");
			},
		};
		await expect(wipeDeviceKeys(idb)).resolves.toBeUndefined();
	});
});
