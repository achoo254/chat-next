// The chat store keeps the user's Advisor profile for every screen: loaded
// with the store, read again when another session changes it, and following
// a change saved here.
import { afterEach, describe, expect, it } from "vitest";
import { type AdvisorProfile, DEFAULT_ADVISOR_PROFILE, EventKeys } from "@achoo254/chat-core";
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

describe("the chat store's Advisor profile", () => {
	it("loads it, follows other sessions and a change saved here", async () => {
		const f = seedDemo().fixture;
		const core = await f.startCore(new MemorySqlFactory());
		cleanup.push(() => void core.close());
		let server: AdvisorProfile = { name: "", lookId: "robot", tone: "short", autoSession: false };
		const saved: Partial<AdvisorProfile>[] = [];
		const source = {
			...toSource(core),
			advisorProfile: async (): Promise<AdvisorProfile> => server,
			setAdvisorProfile: async (change: Partial<AdvisorProfile>): Promise<AdvisorProfile> => {
				saved.push(change);
				server = { ...server, ...change };
				return server;
			},
		};
		const store = new ChatStore(source, { selfId: f.selfId });
		cleanup.push(() => store.dispose());
		const heard: string[] = [];
		cleanup.push(store.subscribe("advisor", () => heard.push("advisor")));

		expect(store.advisorProfile()).toEqual(DEFAULT_ADVISOR_PROFILE);
		await until(() => store.advisorProfile().lookId === "robot");

		// Another session changed it: the sync writes it and the key reaches the store.
		server = { ...server, name: "Bác Cú", tone: "serious" };
		source.events.emit(EventKeys.advisorProfile);
		await until(() => store.advisorProfile().name === "Bác Cú");
		expect(store.advisorProfile()).toEqual({ name: "Bác Cú", lookId: "robot", tone: "serious", autoSession: false });

		expect(await store.setAdvisorProfile({ tone: "fun" })).toEqual({ name: "Bác Cú", lookId: "robot", tone: "fun", autoSession: false });
		expect(saved).toEqual([{ tone: "fun" }]);
		expect(store.advisorProfile().tone).toBe("fun");
		expect(heard).toHaveLength(3);
	});
});
