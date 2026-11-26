// A jump to a message (a reply's original, a mention, a search hit) focuses it once:
// the list places itself on it and flashes it. Opening the chat again later is a new
// opening with nothing to focus, so the list restores where the reader left it
// instead of going back to the message the jump landed on and flashing it again.
import { afterEach, describe, expect, it } from "vitest";
import { MemorySqlFactory } from "../../../packages/core/test/support/node-sql.ts";
import { ChatStore } from "../src/messaging/data/store.ts";
import { seedDemo } from "./support/demo-data.ts";
import { toSource } from "./support/fake-chat.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
	for (const done of cleanup.splice(0)) done();
});

async function until(check: () => boolean, ms = 4_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function openedStore(): Promise<{ store: ChatStore; ops: number; target: number }> {
	const demo = seedDemo();
	const core = await demo.fixture.startCore(new MemorySqlFactory());
	cleanup.push(() => void core.close());
	const store = new ChatStore(toSource(core), { selfId: demo.fixture.selfId });
	cleanup.push(() => store.dispose());
	return { store, ops: demo.ids.ops, target: demo.ids.codeSeq };
}

describe("the focus of a message window", () => {
	it("a jump focuses its message and counts as a new placement", async () => {
		const { store, ops, target } = await openedStore();
		store.openWindow(ops);
		await until(() => store.window(ops)?.status === "ready");
		const token = store.window(ops)?.focusToken ?? 0;
		store.openWindow(ops, target);
		await until(() => store.window(ops)?.focusSeq === target);
		expect(store.window(ops)?.focusToken).toBe(token + 1);
	});

	it("opening the chat again clears the earlier jump, so the list neither returns to it nor flashes it", async () => {
		const { store, ops, target } = await openedStore();
		store.openWindow(ops, target);
		await until(() => store.window(ops)?.focusSeq === target);
		const openings = store.window(ops)?.openings ?? 0;

		// The reader goes elsewhere and comes back to the chat.
		store.openWindow(ops);
		expect(store.window(ops)?.focusSeq).toBe(0);
		await until(() => (store.window(ops)?.openings ?? 0) > openings && store.window(ops)?.status === "ready");
		expect(store.window(ops)?.focusSeq).toBe(0);
	});

	it("a second jump to the same message focuses it again", async () => {
		const { store, ops, target } = await openedStore();
		store.openWindow(ops, target);
		await until(() => store.window(ops)?.focusSeq === target);
		store.openWindow(ops);
		const token = store.window(ops)?.focusToken ?? 0;
		store.openWindow(ops, target);
		await until(() => (store.window(ops)?.focusToken ?? 0) > token);
		expect(store.window(ops)?.focusSeq).toBe(target);
	});
});
