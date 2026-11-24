// The Observe tab and "Phiên Claude Code trên máy": an older tunelo gets a
// note to update and no request; a thread with no session says so; a watched
// session shows its frame with the repository's usage link, a refusal offers
// to try again, and leaving the tab stops watching. The machine's list shows
// the user's 20 newest sessions and opens each in its thread's tab or by its
// own id. The station table and its names in every language.
import { create } from "@bufbuild/protobuf";
import {
	ErrorCode,
	ErrorReason,
	LocalSessionSchema,
	MachineInfoSchema,
	ObservatoryContentResultSchema,
	ObservatoryContentState,
	ObservatorySessionInfoSchema,
	ObservatoryStationResultSchema,
	ObservatorySessionListResultSchema,
	ObservatorySessionSource,
	SessionListResultSchema,
} from "@achoo254/chat-proto/remote/remote";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import { enMachines } from "../../../src/machines/copy-en.ts";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../../src/machines/copy-zh-CN.ts";
import { RemoteError } from "../../../src/machines/link/machine-link.ts";
import LiveMapView from "../../../src/machines/observatory/live-map-view.tsx";
import { MachineClaudeSessions, shownSessions, SESSIONS_SHOWN } from "../../../src/machines/observatory/machine-claude-sessions.tsx";
import { orderedStations, STATION_CATALOG, STATION_CODES, stationOf } from "../../../src/machines/observatory/station-catalog.ts";
import { sessionSink, useEventContent, useStationDrill, useThreadSessions, type Held } from "../../../src/machines/observatory/use-observatory-session.ts";
import { snapshotFromWire } from "../../../src/machines/observatory/live-map-types.ts";
import { FakeLink, wireEvents, wireSnapshot } from "./fake-observatory-link.ts";
import { info as sessionInfo } from "./live-map-fixtures.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const machineInfo = (agentVersion: string) => create(MachineInfoSchema, { agentVersion });
const t = viMachines.observe;

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	});
};

describe("the Observe tab", () => {
	it("asks an older tunelo to update and sends it nothing", () => {
		const fake = new FakeLink();
		wrap(<LiveMapView link={fake.link} machine="1" info={machineInfo("3.25.0")} online target={{ kind: "session", sessionId: "s1" }} />);
		expect(screen.getByText(t.needsUpdate)).toBeTruthy();
		expect(fake.sent).toEqual([]);
	});

	it("says a thread has no Claude Code session yet", async () => {
		const fake = new FakeLink();
		wrap(<LiveMapView link={fake.link} machine="1" info={machineInfo("3.26.0")} online target={{ kind: "thread", threadId: "t1" }} />);
		expect(fake.sent[0]).toEqual({ case: "observatorySessionList", value: { limit: 50, threadId: "t1" } });
		fake.answer({ case: "observatorySessionListResult", value: create(ObservatorySessionListResultSchema, {}) });
		await flush();
		expect(screen.getByText(t.empty.never)).toBeTruthy();
	});

	it("watches the thread's session, shows its frame and usage link, and stops watching when left", async () => {
		const fake = new FakeLink();
		const view = wrap(<LiveMapView link={fake.link} machine="1" info={machineInfo("3.26.0")} online target={{ kind: "thread", threadId: "t1" }} />);
		fake.answer({
			case: "observatorySessionListResult",
			value: create(ObservatorySessionListResultSchema, { sessions: [create(ObservatorySessionInfoSchema, { sessionId: "s1" }), create(ObservatorySessionInfoSchema, { sessionId: "s0" })] }),
		});
		await flush();
		// The newest of the thread's sessions.
		expect(fake.sent.at(-1)).toEqual({ case: "observatoryWatch", value: { sessionId: "s1", on: true, limit: 500 } });
		expect(screen.getByText(t.loading)).toBeTruthy();
		act(() => fake.deliver(wireSnapshot(3n), true));
		await flush();
		// The core as the machine's live state says it.
		const map = view.container.querySelector("[data-id=observe-map]");
		expect(map?.getAttribute("data-core")).toBe("waiting_permission");
		expect(screen.getByText(t.usage).getAttribute("href")).toBe("/ai/1/usage/github.com%2Facme%2Fapp");
		act(() => fake.deliver(wireEvents([4n])));
		expect(view.container.querySelector("[data-id=observe-map]")).toBeTruthy();
		// Leaving the tab unmounts it: the watch stops, nothing is kept.
		view.unmount();
		expect(fake.watches()).toEqual([true, false]);
	});

	it("offers to try again when the machine has too many sessions watched", async () => {
		const fake = new FakeLink();
		wrap(<LiveMapView link={fake.link} machine="1" info={machineInfo("3.26.0")} online target={{ kind: "session", sessionId: "s1" }} />);
		fake.reject(new RemoteError(ErrorCode.INVALID, "too many", ErrorReason.OBSERVATORY_WATCH_LIMIT));
		await flush();
		expect(screen.getByText(t.limit)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: t.retry }));
		expect(fake.watches()).toEqual([true, true]);
	});

	it("says Observatory is off on the machine, with nothing to retry", async () => {
		const fake = new FakeLink();
		wrap(<LiveMapView link={fake.link} machine="1" info={machineInfo("3.26.0")} online target={{ kind: "session", sessionId: "s1" }} />);
		fake.reject(new RemoteError(ErrorCode.INVALID, "off", ErrorReason.OBSERVATORY_OFF));
		await flush();
		expect(screen.getByText(t.off)).toBeTruthy();
		expect(screen.queryByRole("button", { name: t.retry })).toBeNull();
	});
});

describe("the watched session's sink", () => {
	it("follows the snapshot, waits for it before events, and asks again on a gap", () => {
		let held: Held = { state: null, failure: null, disconnected: false };
		const sink = sessionSink((change) => {
			held = change(held);
		});
		expect(sink.events(1n, [])).toBe("ok");
		const body = wireSnapshot(3n);
		if (body.case !== "observatorySnapshot") throw new Error("not a snapshot");
		sink.snapshot(snapshotFromWire(body.value));
		expect(held.state?.seq).toBe(3);
		expect(sink.events(1n, [{ kind: "prompt", promptId: "p2", id: "prompt:p2", at: 20, seq: 4, provisional: false }])).toBe("ok");
		expect(held.state?.seq).toBe(4);
		expect(sink.events(1n, [{ kind: "prompt", promptId: "p3", id: "prompt:p3", at: 30, seq: 6, provisional: false }])).toBe("need-snapshot");
		expect(sink.events(2n, [])).toBe("need-snapshot");
		sink.disconnected(true);
		sink.failure("limit");
		expect(held).toMatchObject({ disconnected: true, failure: "limit" });
	});
});

describe("what the viewer asks of a session", () => {
	it("asks an event's content when one is opened, once per event, and nothing offline or for none", async () => {
		const fake = new FakeLink();
		const { result, rerender } = renderHook(({ eventId, online }: { eventId: string | null; online: boolean }) => useEventContent(fake.link, "s1", eventId, online), {
			initialProps: { eventId: null as string | null, online: true },
		});
		expect(result.current).toEqual({ kind: "loading" });
		expect(fake.sent).toEqual([]);
		rerender({ eventId: "prompt:p1", online: false });
		expect(fake.sent).toEqual([]);
		rerender({ eventId: "prompt:p1", online: true });
		expect(fake.sent).toEqual([{ case: "observatoryContent", value: { sessionId: "s1", eventId: "prompt:p1" } }]);
		fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { eventId: "prompt:p1", state: ObservatoryContentState.NONE }) });
		await flush();
		expect(result.current).toEqual({ kind: "done", value: { eventId: "prompt:p1", state: "none", text: "" } });
		// Another event: its own answer, the earlier one never shows for it.
		rerender({ eventId: "tool:t1", online: true });
		expect(result.current).toEqual({ kind: "loading" });
		fake.reject(new RemoteError(ErrorCode.INVALID, "old", ErrorReason.UNSUPPORTED_REQUEST));
		await flush();
		expect(result.current).toEqual({ kind: "failed", failure: "update" });
	});

	it("asks a station's numbers for the drawer, again for another moment", async () => {
		const fake = new FakeLink();
		const { result, rerender } = renderHook(({ at }: { at: number }) => useStationDrill(fake.link, "s1", "MCP", at, true), { initialProps: { at: 0 } });
		fake.answer({ case: "observatoryStationResult", value: create(ObservatoryStationResultSchema, { sessionId: "s1", station: "MCP", numbers: { calls: 2 } }) });
		await flush();
		expect(result.current.kind === "done" ? result.current.value.numbers.calls : null).toBe(2);
		rerender({ at: 500 });
		expect(fake.sent.at(-1)).toEqual({ case: "observatoryStation", value: { sessionId: "s1", station: "MCP", at: 500n } });
	});

	it("lists a thread's sessions, and asks again when the link comes back", async () => {
		const fake = new FakeLink();
		const { result, rerender } = renderHook(({ online }: { online: boolean }) => useThreadSessions(fake.link, "t1", online), { initialProps: { online: true } });
		fake.answer({ case: "observatorySessionListResult", value: create(ObservatorySessionListResultSchema, { sessions: [create(ObservatorySessionInfoSchema, { sessionId: "s2" })] }) });
		await flush();
		expect(result.current.kind === "done" ? result.current.value.map((s) => s.sessionId) : null).toEqual(["s2"]);
		rerender({ online: false });
		rerender({ online: true });
		expect(fake.sent.filter((b) => b.case === "observatorySessionList")).toHaveLength(2);
	});
});

describe("Claude Code sessions on the machine", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.UTC(2026, 10, 23, 4, 0));
	});
	afterEach(() => vi.useRealTimers());

	it("keeps the user's own sessions, newest first, at most 20", () => {
		const many = Array.from({ length: 30 }, (_, i) => sessionInfo({ sessionId: `s${i}`, startedAt: i }));
		const shown = shownSessions([...many, sessionInfo({ sessionId: "advisor", internalLabel: "advisor", startedAt: 100 })]);
		expect(shown).toHaveLength(SESSIONS_SHOWN);
		expect(shown[0]?.sessionId).toBe("s29");
		expect(shown.some((s) => s.sessionId === "advisor")).toBe(false);
	});

	it("lists each session's repository, kind, start and state, and opens it in its thread or by its id", async () => {
		const fake = new FakeLink();
		wrap(<MachineClaudeSessions machine="1" link={fake.link} online />);
		expect(fake.sent.map((b) => b.case)).toEqual(["observatorySessionList", "sessionList"]);
		fake.answer({
			case: "observatorySessionListResult",
			value: create(ObservatorySessionListResultSchema, {
				sessions: [
					create(ObservatorySessionInfoSchema, { sessionId: "cli-1", projectKey: "github.com/acme/app", source: ObservatorySessionSource.CLI, startedAt: BigInt(Date.UTC(2026, 10, 23, 3, 0)) }),
					create(ObservatorySessionInfoSchema, { sessionId: "sdk-1", projectKey: "scratch", source: ObservatorySessionSource.SDK, startedAt: 1n, endedAt: 2n }),
				],
			}),
		});
		fake.answer({ case: "sessionListResult", value: create(SessionListResultSchema, { sessions: [create(LocalSessionSchema, { sessionId: "sdk-1", threadId: "thr" })] }) });
		await flush();
		const rows = screen.getAllByRole("listitem");
		expect(rows).toHaveLength(2);
		const cli = within(rows[0] ?? document.body);
		expect(cli.getByText("github.com/acme/app")).toBeTruthy();
		expect(cli.getByText(t.sessions.running)).toBeTruthy();
		expect(cli.getByText(/^CLI · bắt đầu /)).toBeTruthy();
		expect(cli.getByRole("link").getAttribute("href")).toBe("/ai/1/observe/cli-1");
		const sdk = within(rows[1] ?? document.body);
		expect(sdk.getByText(t.sessions.noRepo)).toBeTruthy();
		expect(sdk.getByText(t.sessions.ended)).toBeTruthy();
		expect(sdk.getByRole("link").getAttribute("href")).toBe("/ai/1/s/thr/observe");
	});

	it("asks an older tunelo to update", async () => {
		const fake = new FakeLink();
		wrap(<MachineClaudeSessions machine="1" link={fake.link} online />);
		fake.reject(new RemoteError(ErrorCode.INVALID, "unknown", ErrorReason.UNSUPPORTED_REQUEST));
		fake.reject(new RemoteError(ErrorCode.INVALID, "unknown", ErrorReason.UNSUPPORTED_REQUEST));
		await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t.needsUpdate));
	});
});

describe("the station table", () => {
	it("reads an unknown or empty code as the core, and lists every station once in order", () => {
		expect(stationOf("GIT")).toBe("GIT");
		expect(stationOf("LIBRARY")).toBe("CORE");
		expect(stationOf("")).toBe("CORE");
		expect(orderedStations().map((s) => s.code)).toEqual([...STATION_CODES]);
		expect(new Set(STATION_CODES.map((c) => STATION_CATALOG[c].order)).size).toBe(STATION_CODES.length);
	});

	it("names every station in every language", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			for (const code of STATION_CODES) expect(copy.observe.stations[STATION_CATALOG[code].labelKey]).not.toBe("");
		}
	});
});
