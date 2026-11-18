// The Advisor profile syncs like the notification settings: fetched once and
// kept in the local database, followed from other sessions through the update
// log, changed online with the result written at once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { AdvisorProfileSchema, AdvisorTone } from "@achoo254/chat-proto/advisor";
import { UpdateSchema } from "@achoo254/chat-proto/updates";
import { EventKeys } from "../src/events/bus.ts";
import { DEFAULT_ADVISOR_PROFILE } from "../src/model/types.ts";
import { createRemoteApi } from "../src/protocol/api.ts";
import { toAdvisorProfile, toUpdate, toWireAdvisorTone } from "../src/protocol/map.ts";
import { parseAdvisorProfile } from "../src/repo/rows.ts";
import { FakeServer } from "./support/fake-server.ts";
import { settle, startTestApp } from "./support/harness.ts";
import { MemorySqlFactory } from "./support/node-sql.ts";

beforeEach(() => {
	vi.useFakeTimers({ now: new Date("2026-11-17T09:00:00Z") });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("Advisor profile mapping", () => {
	it("maps the profile and its update; unknown tones and empty looks fall back to the defaults", () => {
		const profile = create(AdvisorProfileSchema, { name: "Cú", lookId: "cat", tone: AdvisorTone.FUN });
		expect(toAdvisorProfile(profile)).toEqual({ name: "Cú", lookId: "cat", tone: "fun", autoSession: false });
		expect(toAdvisorProfile(create(AdvisorProfileSchema, { tone: 9 as AdvisorTone }))).toEqual(DEFAULT_ADVISOR_PROFILE);
		expect(toWireAdvisorTone("serious")).toBe(AdvisorTone.SERIOUS);
		expect(toUpdate(create(UpdateSchema, { kind: { case: "advisorProfile", value: { profile } } })).body).toEqual({
			kind: "advisor_profile",
			profile: { name: "Cú", lookId: "cat", tone: "fun", autoSession: false },
		});
		expect(toUpdate(create(UpdateSchema, { kind: { case: "advisorProfile", value: {} } })).body).toEqual({ kind: "unknown" });
	});

	it("reads a stored profile defensively", () => {
		expect(parseAdvisorProfile(null)).toEqual(DEFAULT_ADVISOR_PROFILE);
		expect(parseAdvisorProfile("not json")).toEqual(DEFAULT_ADVISOR_PROFILE);
		expect(parseAdvisorProfile(JSON.stringify({ name: 7, lookId: "robot", tone: "loud" }))).toEqual({ name: "", lookId: "robot", tone: "short", autoSession: false });
	});

	it("exposes the RPCs through createRemoteApi", () => {
		const api = createRemoteApi({} as never);
		expect(typeof api.advisor?.getAdvisorProfile).toBe("function");
		expect(typeof api.advisor?.setAdvisorProfile).toBe("function");
	});
});

describe("Advisor profile sync", () => {
	it("takes the profile with the first snapshot, follows other sessions and saves a change", async () => {
		const server = new FakeServer();
		const self = server.addUser("Tôi");
		server.setAdvisor(self, { lookId: "robot" });
		const sql = new MemorySqlFactory();
		const { core } = await startTestApp(server, self, sql);
		await settle(core);
		expect(await core.advisorProfile()).toEqual({ ...DEFAULT_ADVISOR_PROFILE, lookId: "robot" });

		const changed: string[] = [];
		core.events.subscribe(EventKeys.advisorProfile, () => changed.push("advisor"));
		server.setAdvisor(self, { name: "Bác Cú", tone: AdvisorTone.SERIOUS });
		await settle(core);
		expect(await core.advisorProfile()).toEqual({ name: "Bác Cú", lookId: "robot", tone: "serious", autoSession: false });
		expect(changed).toHaveLength(1);

		const after = await core.setAdvisorProfile({ tone: "fun", lookId: "cat", autoSession: true });
		expect(after).toEqual({ name: "Bác Cú", lookId: "cat", tone: "fun", autoSession: true });
		expect(await core.advisorProfile()).toEqual(after);
		await settle(core);
		expect(server.advisorProfile(self)).toMatchObject({ name: "Bác Cú", lookId: "cat", tone: AdvisorTone.FUN, autoSession: true });
		await core.close();
	});
});
