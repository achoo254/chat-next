// Advisor takes one question at a time: while a question of this tab waits for
// its answer, a copy made elsewhere is not kept for the next one; once it ends,
// copies are kept again.
import { describe, expect, it } from "vitest";
import { AdvisorStore, EMPTY_CONTEXT } from "../../src/advisor/advisor-store.ts";

describe("Advisor while a question waits", () => {
	it("keeps no copy until the question ends", () => {
		const store = new AdvisorStore();
		store.remember("before", EMPTY_CONTEXT);
		store.setBusy(true);
		store.remember("while waiting", { ...EMPTY_CONTEXT, screen: "chat" });
		expect(store.snapshot().copies.map((c) => c.text)).toEqual(["before"]);
		store.setBusy(false);
		store.remember("after", EMPTY_CONTEXT);
		expect(store.snapshot().copies.map((c) => c.text)).toEqual(["after", "before"]);
	});

	it("is not busy again after the app forgets the account's Advisor", () => {
		const store = new AdvisorStore();
		store.setBusy(true);
		store.forgetAll();
		expect(store.snapshot().busy).toBe(false);
	});
});
