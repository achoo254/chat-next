// The times that order the account's key against its removal: a new key always
// counts as set after the last removal and after every account key in reach
// (a slow clock here never makes it look removed or older than the key it
// replaces), and a removal never lands before a key it removes.
import { describe, expect, it } from "vitest";
import { nextSetAt, removalTime, type MachineKeyState } from "../../src/advisor/advisor-account-key.ts";

function holder(source: MachineKeyState["source"], setAt: number): { key: MachineKeyState } {
	return { key: { reachable: true, share: true, source, fingerprint: "a1b2c3", setAt, setByDevice: "Chrome" } };
}

describe("account key times", () => {
	it("a new key comes after now, the last removal and every account key in reach; own keys do not count", () => {
		expect(nextSetAt(1_000, 0, [])).toBe(1_000);
		expect(nextSetAt(1_000, 5_000, [])).toBe(5_001);
		// An account key from a machine whose clock runs ahead.
		expect(nextSetAt(1_000, 0, [holder("account", 9_000), holder("own", 99_000)])).toBe(9_001);
	});

	it("a removal comes at now or after every account key it removes", () => {
		expect(removalTime(1_000, [])).toBe(1_000);
		expect(removalTime(1_000, [holder("account", 7_000), holder("own", 99_000), holder("none", 0)])).toBe(7_000);
		expect(removalTime(8_000, [holder("account", 7_000)])).toBe(8_000);
	});
});
