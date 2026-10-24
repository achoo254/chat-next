// Users the source does not know are asked from the server by the store
// itself, in requests the server accepts (at most 200 ids per GetUsers).
import { afterEach, describe, expect, it } from "vitest";
import type { User } from "@achoo254/chat-core";
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

describe("the chat store's own user fetch", () => {
	it("asks the server for missing users at most 200 at a time", async () => {
		const f = seedDemo().fixture;
		const core = await f.startCore(new MemorySqlFactory());
		cleanup.push(() => void core.close());
		const [self] = await core.users([f.selfId]);
		if (self === undefined) throw new Error("self is not stored");
		// The leading tab's database knows none of them.
		const source = { ...toSource(core), users: async (): Promise<User[]> => [] };
		const requests: number[][] = [];
		const store = new ChatStore(source, {
			selfId: f.selfId,
			fetchUsers: async (ids) => {
				requests.push([...ids]);
				return ids.map((id) => ({ ...self, id, isSelf: false, name: `Người ${id}` }));
			},
		});
		cleanup.push(() => store.dispose());
		const wanted = Array.from({ length: 450 }, (_, i) => 1_000_000 + i);

		for (const id of wanted) store.wantUser(id);
		await until(() => wanted.every((id) => store.user(id) !== undefined));

		// The store also asks for the peers of its dialogs, possibly in the same batch.
		for (const ids of requests) expect(ids.length).toBeLessThanOrEqual(200);
		const asked = requests.flat().filter((id) => id >= 1_000_000);
		expect(asked).toEqual(wanted);
		expect(store.user(1_000_449)?.name).toBe("Người 1000449");
	});
});
