// Observatory's link: requests with their deadline and their failures read for
// the viewer, the session a thread runs, and watching one session (a snapshot,
// events, asking again once on a gap or another epoch, after a reconnect, not
// while hidden for a minute, and a link down for 30 s said so).
import { create } from "@bufbuild/protobuf";
import {
	ErrorCode,
	ErrorReason,
	LocalSessionSchema,
	ObservatoryEarlierResultSchema,
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
	threadSessionId,
	threadsBySession,
	watchSession,
	WATCH_RETRY_MS,
	type WatchSink,
} from "../../../src/machines/observatory/observatory-client.ts";
import type { LiveMapEvent, LiveMapSnapshot } from "../../../src/machines/observatory/live-map-types.ts";
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
		expect(fake.sent[0]).toEqual({ case: "observatorySessionList", value: { limit: 40 } });
		const page = earlierEvents(fake.link, "s1", "cursor", 100);
		fake.answer({ case: "observatoryEarlierResult", value: create(ObservatoryEarlierResultSchema, { sessionId: "s1" }) });
		expect(await page).toEqual({ events: [], earlier: "" });
		expect(fake.timeouts).toEqual([OBSERVATORY_TIMEOUT_MS, OBSERVATORY_TIMEOUT_MS]);
		// An older tunelo refuses: the caller reads it as "update".
		const refused = listMachineSessions(fake.link, 40);
		fake.reject(new RemoteError(ErrorCode.INVALID, "unknown", ErrorReason.UNSUPPORTED_REQUEST));
		await expect(refused).rejects.toSatisfy((err: unknown) => failureOf(err) === "update");
	});

	it("finds the session a thread holds, the most recently changed first, and the thread of each session", async () => {
		const fake = new FakeLink();
		const answer = () =>
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
		const found = threadSessionId(fake.link, { id: "t1", provider: "claude", dir: "/w" });
		answer();
		expect(await found).toBe("new");
		expect(fake.sent[0]).toEqual({ case: "sessionList", value: { provider: "claude", dir: "/w", limit: 100 } });
		const none = threadSessionId(fake.link, { id: "t2", provider: "claude", dir: "/w" });
		answer();
		expect(await none).toBeNull();
		const byId = threadsBySession(fake.link, "claude");
		answer();
		expect([...(await byId)]).toEqual([
			["new", "t1"],
			["old", "t1"],
		]);
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
