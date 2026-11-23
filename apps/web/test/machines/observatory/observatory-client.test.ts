// Observatory's link: requests with their deadline and their failures read for
// the viewer, the session a thread runs, and watching one session (a snapshot,
// events, asking again once on a gap or another epoch, after a reconnect, not
// while hidden for a minute, and a link down for 30 s said so).
import { create } from "@bufbuild/protobuf";
import {
	ErrorCode,
	ErrorReason,
	LocalSessionSchema,
	ObservatoryBottleneckSchema,
	ObservatoryContentResultSchema,
	ObservatoryContentState,
	ObservatoryCoreState,
	ObservatoryEarlierResultSchema,
	ObservatoryEventSchema,
	ObservatoryStationResultSchema,
	ObservatorySessionInfoSchema,
	ObservatorySessionListResultSchema,
	ObservatorySessionSource,
	SessionListResultSchema,
} from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfflineError, RemoteError } from "../../../src/machines/link/machine-link.ts";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import {
	earlierEvents,
	failureOf,
	failureText,
	HIDDEN_UNWATCH_MS,
	listMachineSessions,
	OBSERVATORY_TIMEOUT_MS,
	OFFLINE_NOTICE_MS,
	eventContent,
	stationDrill,
	threadSessions,
	threadsBySession,
	watchSession,
	WATCH_RETRY_MS,
	type WatchSink,
} from "../../../src/machines/observatory/observatory-client.ts";
import { eventFromWire, type LiveMapEvent, type LiveMapSnapshot } from "../../../src/machines/observatory/live-map-types.ts";
import { FakeLink, fakePage, wireEvents, wireSnapshot } from "./fake-observatory-link.ts";

/** A sink that records what it is handed and asks for a snapshot when told to. */
function recorder(answer: "ok" | "need-snapshot" = "ok") {
	const got = { snapshots: [] as LiveMapSnapshot[], events: [] as LiveMapEvent[][], failures: [] as (string | null)[], down: [] as boolean[] };
	const sink: WatchSink = {
		snapshot: (s) => got.snapshots.push(s),
		events: (_epoch, events) => {
			got.events.push([...events]);
			return answer;
		},
		failure: (f) => got.failures.push(f),
		disconnected: (d) => got.down.push(d),
	};
	return { got, sink };
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 3; i++) await Promise.resolve();
};

describe("Observatory's requests", () => {
	it("reads the machine's refusals for the viewer: an older tunelo asks to update", () => {
		expect(failureOf(new RemoteError(ErrorCode.INVALID, "x", ErrorReason.UNSUPPORTED_REQUEST))).toBe("update");
		expect(failureOf(new RemoteError(ErrorCode.INVALID, "x", ErrorReason.OBSERVATORY_OFF))).toBe("off");
		expect(failureOf(new RemoteError(ErrorCode.INVALID, "x", ErrorReason.OBSERVATORY_WATCH_LIMIT))).toBe("limit");
		expect(failureOf(new RemoteError(ErrorCode.INVALID, "x", ErrorReason.OBSERVATORY_INVALID))).toBe("invalid");
		expect(failureOf(new OfflineError())).toBe("offline");
		expect(failureOf(new Error("x"))).toBe("failed");
		expect(failureText(viMachines.observe, "update")).toBe(viMachines.observe.needsUpdate);
		expect(failureText(viMachines.observe, "invalid")).toBe(viMachines.observe.failed);
	});

	it("lists the machine's sessions and pages older events, each with its deadline", async () => {
		const fake = new FakeLink();
		const listed = listMachineSessions(fake.link, 40);
		fake.answer({
			case: "observatorySessionListResult",
			value: create(ObservatorySessionListResultSchema, { sessions: [create(ObservatorySessionInfoSchema, { sessionId: "s1", source: ObservatorySessionSource.TERMINAL, startedAt: 5n })] }),
		});
		expect(await listed).toEqual([expect.objectContaining({ sessionId: "s1", source: "terminal", startedAt: 5, endedAt: 0 })]);
		expect(fake.sent[0]).toEqual({ case: "observatorySessionList", value: { limit: 40, threadId: "" } });
		const page = earlierEvents(fake.link, "s1", "cursor", 100);
		fake.answer({ case: "observatoryEarlierResult", value: create(ObservatoryEarlierResultSchema, { sessionId: "s1" }) });
		expect(await page).toEqual({ events: [], earlier: "" });
		expect(fake.timeouts).toEqual([OBSERVATORY_TIMEOUT_MS, OBSERVATORY_TIMEOUT_MS]);
		// An older tunelo refuses: the caller reads it as "update".
		const refused = listMachineSessions(fake.link, 40);
		fake.reject(new RemoteError(ErrorCode.INVALID, "unknown", ErrorReason.UNSUPPORTED_REQUEST));
		await expect(refused).rejects.toSatisfy((err: unknown) => failureOf(err) === "update");
	});

	it("reads provisional events, bottleneck findings and the session's live state from the wire", () => {
		const provisional = eventFromWire(create(ObservatoryEventSchema, { at: 5n, id: "tool:t1", provisional: true, kind: { case: "toolCall", value: { toolUseId: "t1", station: "GIT", stationFlags: 1 } } }));
		expect(provisional).toMatchObject({ kind: "tool", id: "tool:t1", provisional: true, station: "GIT", stationFlags: 1 });
		expect(provisional).not.toHaveProperty("success");
		const finding = eventFromWire(
			create(ObservatoryEventSchema, {
				at: 7n,
				id: "bottleneck:repeat_read:k1",
				kind: { case: "bottleneck", value: { rule: "repeat_read", subkey: "k1", station: "FILES", severity: "warn", status: "closed", openedAt: 7n, closedAt: 9n, value: 6, threshold: 5, n: 6 } },
			}),
		);
		expect(finding).toMatchObject({ kind: "bottleneck", rule: "repeat_read", open: false, severity: "warn", closedAt: 9, value: 6, threshold: 5, n: 6, provisional: false });
		const session = eventFromWire(
			create(ObservatoryEventSchema, { id: "session", kind: { case: "session", value: { live: { core: ObservatoryCoreState.COMPACTING, contextWindowAssumed: true, running: [{ station: "FILES", count: 2 }] } } } }),
		);
		expect(session).toMatchObject({ kind: "session", info: null, live: { core: "compacting", contextWindowAssumed: true, contextPercent: null, tokensPerSecond: null, running: [{ station: "FILES", count: 2 }] } });
		// A core state of a newer machine reads as the safe default.
		// A value past the generated enum, as protobuf hands one through from a newer machine.
		const newer = 99 as ObservatoryCoreState;
		expect(eventFromWire(create(ObservatoryEventSchema, { id: "session", kind: { case: "session", value: { live: { core: newer } } } }))).toMatchObject({ live: { core: "idle" } });
	});

	it("lists a thread's sessions by the machine's own list, newest first", async () => {
		const fake = new FakeLink();
		const listed = threadSessions(fake.link, "t1");
		fake.answer({
			case: "observatorySessionListResult",
			value: create(ObservatorySessionListResultSchema, { sessions: [create(ObservatorySessionInfoSchema, { sessionId: "after-clear" }), create(ObservatorySessionInfoSchema, { sessionId: "before-clear" })] }),
		});
		expect((await listed).map((s) => s.sessionId)).toEqual(["after-clear", "before-clear"]);
		expect(fake.sent[0]).toEqual({ case: "observatorySessionList", value: { limit: 50, threadId: "t1" } });
	});

	it("finds the thread holding each session from the machine's transcripts", async () => {
		const fake = new FakeLink();
		const byId = threadsBySession(fake.link, "claude");
		fake.answer({
			case: "sessionListResult",
			value: create(SessionListResultSchema, {
				sessions: [
					create(LocalSessionSchema, { sessionId: "old", threadId: "t1", updatedAt: 1n }),
					create(LocalSessionSchema, { sessionId: "new", threadId: "t1", updatedAt: 9n }),
					create(LocalSessionSchema, { sessionId: "free", threadId: "", updatedAt: 5n }),
				],
			}),
		});
		expect([...(await byId)]).toEqual([
			["new", "t1"],
			["old", "t1"],
		]);
		expect(fake.sent[0]).toEqual({ case: "sessionList", value: { provider: "claude", dir: "", limit: 100 } });
	});

	it("asks an event's content by id, and gives no text unless it is stored", async () => {
		const fake = new FakeLink();
		const stored = eventContent(fake.link, "s1", "prompt:p1");
		fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { sessionId: "s1", eventId: "prompt:p1", state: ObservatoryContentState.STORED, text: "fix the bug" }) });
		expect(await stored).toEqual({ eventId: "prompt:p1", state: "stored", text: "fix the bug" });
		expect(fake.sent[0]).toEqual({ case: "observatoryContent", value: { sessionId: "s1", eventId: "prompt:p1" } });
		const off = eventContent(fake.link, "s1", "tool:t1");
		fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { eventId: "tool:t1", state: ObservatoryContentState.OFF, text: "leak" }) });
		expect(await off).toEqual({ eventId: "tool:t1", state: "off", text: "" });
		const notYet = eventContent(fake.link, "s1", "tool:t2");
		fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { eventId: "tool:t2", state: ObservatoryContentState.NOT_YET }) });
		expect((await notYet).state).toBe("not_yet");
	});

	it("asks a station's numbers up to a moment, with its parts, events, earlier sessions and findings", async () => {
		const fake = new FakeLink();
		const drill = stationDrill(fake.link, "s1", "SANDBOX", 5_000);
		expect(fake.sent[0]).toEqual({ case: "observatoryStation", value: { sessionId: "s1", station: "SANDBOX", at: 5_000n } });
		fake.answer({
			case: "observatoryStationResult",
			value: create(ObservatoryStationResultSchema, {
				sessionId: "s1",
				station: "SANDBOX",
				at: 5_000n,
				numbers: { calls: 4, failures: 1, ended: 4, p50Ms: 120, p95Ms: 900, inputTokens: 10n, hasCost: false, requestsWithoutCost: 2 },
				parts: [{ kind: "program", key: "pnpm", numbers: { calls: 3, ended: 3 } }],
				slowest: [create(ObservatoryEventSchema, { at: 10n, id: "tool:t1", kind: { case: "toolCall", value: { toolUseId: "t1", station: "SANDBOX", durationMs: 900 } } })],
				previous: [{ sessionId: "s0", startedAt: 1n, numbers: { calls: 2 } }],
				bottlenecks: [create(ObservatoryBottleneckSchema, { rule: "slow_tool", subkey: "Bash", station: "SANDBOX", severity: "alert", status: "open", openedAt: 7n, evidenceIds: ["tool:t1"] })],
			}),
		});
		const got = await drill;
		expect(got.numbers).toMatchObject({ calls: 4, failures: 1, ended: 4, p50Ms: 120, p95Ms: 900, inputTokens: 10, hasCost: false, requestsWithoutCost: 2 });
		expect(got.parts).toEqual([{ kind: "program", key: "pnpm", numbers: expect.objectContaining({ calls: 3, ended: 3 }) }]);
		expect(got.slowest.map((e) => [e.id, e.kind === "tool" ? e.durationMs : null])).toEqual([["tool:t1", 900]]);
		expect(got.previous).toEqual([{ sessionId: "s0", startedAt: 1, numbers: expect.objectContaining({ calls: 2 }) }]);
		expect(got.bottlenecks).toEqual([expect.objectContaining({ rule: "slow_tool", severity: "alert", open: true, openedAt: 7, closedAt: 0, evidenceIds: ["tool:t1"] })]);
	});
});

describe("watching a session", () => {
	let page = fakePage();
	beforeEach(() => {
		vi.useFakeTimers();
		page = fakePage();
	});
	afterEach(() => vi.useRealTimers());

	it("watches while open, hands this session's snapshot and events on, and stops watching when closed", () => {
		const fake = new FakeLink();
		const { got, sink } = recorder();
		const watch = watchSession(fake.link, "s1", sink, { visibility: page });
		expect(fake.sent[0]).toEqual({ case: "observatoryWatch", value: { sessionId: "s1", on: true, limit: 500 } });
		fake.deliver(wireSnapshot(3n), true);
		expect(got.snapshots.map((s) => [s.seq, s.info?.source, s.events.map((e) => e.id)])).toEqual([[3, "cli", ["prompt:p1"]]]);
		expect(got.failures).toEqual([null]);
		fake.deliver(wireEvents([4n]));
		expect(got.events.map((list) => list.map((e) => [e.seq, e.id]))).toEqual([[[4, "tool:t4"]]]);
		// Another session's frames are not this watch's.
		fake.deliver(wireSnapshot(1n, 1n, "other"));
		fake.deliver(wireEvents([5n], 1n, "other"));
		expect(got.snapshots).toHaveLength(1);
		expect(got.events).toHaveLength(1);
		watch.close();
		expect(fake.watches()).toEqual([true, false]);
	});

	it("asks for a snapshot once on a gap or another epoch, however many frames follow", async () => {
		const fake = new FakeLink();
		const { sink } = recorder("need-snapshot");
		watchSession(fake.link, "s1", sink, { visibility: page });
		fake.deliver(wireSnapshot(3n), true);
		await flush();
		fake.deliver(wireEvents([9n]));
		fake.deliver(wireEvents([10n]));
		fake.deliver(wireEvents([11n], 2n));
		expect(fake.watches()).toEqual([true, true]);
		fake.deliver(wireSnapshot(11n, 2n), true);
		await flush();
		fake.deliver(wireEvents([13n], 2n));
		expect(fake.watches()).toEqual([true, true, true]);
	});

	it("says what the machine refused, and asks again on retry", async () => {
		const fake = new FakeLink();
		const { got, sink } = recorder();
		const watch = watchSession(fake.link, "s1", sink, { visibility: page });
		fake.reject(new RemoteError(ErrorCode.INVALID, "too many", ErrorReason.OBSERVATORY_WATCH_LIMIT));
		await flush();
		expect(got.failures).toEqual(["limit"]);
		// Frames after a refusal are not this watch's.
		fake.deliver(wireSnapshot(1n));
		expect(got.snapshots).toHaveLength(0);
		watch.retry();
		expect(fake.watches()).toEqual([true, true]);
		fake.deliver(wireSnapshot(1n), true);
		expect(got.failures).toEqual(["limit", null]);
	});

	it("asks again shortly when the machine stays silent on an open link", async () => {
		const fake = new FakeLink();
		watchSession(fake.link, "s1", recorder().sink, { visibility: page });
		fake.reject(new OfflineError());
		await flush();
		expect(fake.watches()).toEqual([true]);
		vi.advanceTimersByTime(WATCH_RETRY_MS);
		expect(fake.watches()).toEqual([true, true]);
	});

	it("watches again after a reconnect, and says the machine is not connected after 30 s down", async () => {
		const fake = new FakeLink();
		const { got, sink } = recorder();
		watchSession(fake.link, "s1", sink, { visibility: page });
		fake.deliver(wireSnapshot(3n), true);
		await flush();
		fake.setStatus({ kind: "connecting", attempt: 1 });
		vi.advanceTimersByTime(OFFLINE_NOTICE_MS - 1);
		expect(got.down).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(got.down).toEqual([true]);
		fake.setStatus({ kind: "open" });
		expect(got.down).toEqual([true, false]);
		expect(fake.watches()).toEqual([true, true]);
		// Back before 30 s: nothing said.
		fake.setStatus({ kind: "connecting", attempt: 1 });
		vi.advanceTimersByTime(OFFLINE_NOTICE_MS / 2);
		fake.setStatus({ kind: "open" });
		vi.advanceTimersByTime(OFFLINE_NOTICE_MS);
		expect(got.down).toEqual([true, false, false]);
	});

	it("stops watching after a minute hidden, and watches again when shown", async () => {
		const fake = new FakeLink();
		watchSession(fake.link, "s1", recorder().sink, { visibility: page });
		fake.deliver(wireSnapshot(3n), true);
		await flush();
		// Hidden briefly: still watching.
		page.set(true);
		vi.advanceTimersByTime(HIDDEN_UNWATCH_MS - 1);
		page.set(false);
		expect(fake.watches()).toEqual([true]);
		page.set(true);
		vi.advanceTimersByTime(HIDDEN_UNWATCH_MS);
		expect(fake.watches()).toEqual([true, false]);
		page.set(false);
		expect(fake.watches()).toEqual([true, false, true]);
	});
});
