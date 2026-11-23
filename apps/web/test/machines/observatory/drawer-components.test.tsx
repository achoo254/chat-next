// The Live Map's station drawer, event detail and replay bar: a finding's
// sentence with its numbers and evidence, no finding, no earlier session, no
// cost, the comparison with earlier sessions, the replayed scope; an event's
// content asked by id with its states (stored, switched off, not stored yet,
// none), "Ẩn chi tiết" hiding labels and content without asking for it, the
// estimated station, "replay to here"; the bar playing, its keys, going live,
// a session past 90 days. And the copy in every language.
import { create } from "@bufbuild/protobuf";
import { ObservatoryContentResultSchema, ObservatoryContentState, ObservatoryStationResultSchema } from "@achoo254/chat-proto/remote/remote";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../src/i18n/i18n.tsx";
import { viMachines } from "../../../src/machines/copy-vi.ts";
import { clock, compareWithPrevious, findingValue, tokens } from "../../../src/machines/observatory/drill-format.ts";
import { EventDetail, EventDetailView, STATION_ESTIMATED } from "../../../src/machines/observatory/event-detail.tsx";
import type { LiveMapBottleneck, LiveMapEvent, StationDrill, StationNumbers } from "../../../src/machines/observatory/live-map-types.ts";
import { OBSERVATORY_COPY } from "../../../src/machines/observatory/observatory-copy.ts";
import { ReplayBar, PLAY_TICK_MS } from "../../../src/machines/observatory/replay-bar.tsx";
import { historyOf, LIVE_CURSOR, marksOf, timelineOf, type ReplayCursor } from "../../../src/machines/observatory/replay-controller.ts";
import { StationDrawer, StationDrawerView } from "../../../src/machines/observatory/station-drawer.tsx";
import { FakeLink } from "./fake-observatory-link.ts";
import { api, info, lifecycle, prompt, snapshot, T0, tool } from "./live-map-fixtures.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const c = OBSERVATORY_COPY.vi;
const stations = viMachines.observe.stations;

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 3; i++) await Promise.resolve();
	});
};

const numbers = (over: Partial<StationNumbers> = {}): StationNumbers => ({
	calls: 14,
	failures: 1,
	ended: 14,
	p50Ms: 600,
	p95Ms: 2_800,
	sampled: false,
	apiRequests: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsdEstimate: 0,
	hasCost: false,
	requestsWithoutCost: 0,
	...over,
});

const finding = (over: Partial<LiveMapBottleneck> = {}): LiveMapBottleneck => ({
	rule: "tool_slow",
	subkey: "mcp__onedash__list_hosts|MCP|onedash",
	station: "MCP",
	severity: "alert",
	open: true,
	openedAt: T0 + 1_000,
	updatedAt: T0 + 1_000,
	closedAt: 0,
	value: 2_800,
	threshold: 1_350,
	n: 42,
	evidenceIds: ["tool:t1", "tool:t2"],
	...over,
});

const drill = (over: Partial<StationDrill> = {}): StationDrill => ({
	sessionId: "s1",
	station: "MCP",
	at: 0,
	numbers: numbers(),
	parts: [{ kind: "mcp_server", key: "onedash-prod", numbers: numbers({ calls: 8, p95Ms: 2_800 }) }],
	slowest: [tool("t1", 1_000, { station: "MCP", mcpServer: "onedash-prod", toolName: "mcp__onedash-prod__list_hosts", success: true, durationMs: 2_800 })],
	recent: [tool("t2", 2_000, { station: "MCP", mcpServer: "onedash-prod", toolName: "mcp__onedash-prod__get_host", success: false, durationMs: 300 })],
	previous: [],
	bottlenecks: [],
	...over,
});

const handlers = () => ({ onOpenEvent: vi.fn(), onEvidence: vi.fn(), onClose: vi.fn() });

describe("the station drawer", () => {
	it("leads with an open finding: its sentence, numbers, n, and a button per evidence event", async () => {
		const h = handlers();
		wrap(<StationDrawerView drill={{ kind: "done", value: drill({ bottlenecks: [finding({ open: false, severity: "warn", rule: "repeat_read", value: 4, threshold: 3, n: 4, evidenceIds: [] }), finding()] }) }} station="MCP" at={0} startedAt={T0} hideDetails={false} {...h} />);
		const findings = screen.getAllByRole("listitem").filter((li) => li.classList.contains("lmd-finding"));
		// Open first.
		expect(findings[0]?.getAttribute("data-open")).toBe("true");
		expect(findings[0]?.textContent).toContain(`${c.drawer.open} · ${c.severity.alert} · ${c.rules.tool_slow}: 2,8 s so với ngưỡng 1,4 s`);
		expect(findings[0]?.textContent).toContain("n = 42");
		expect(findings[0]?.textContent).toContain("onedash");
		expect(findings[1]?.textContent).toContain(`${c.drawer.closed} · ${c.severity.warn} · ${c.rules.repeat_read}: 4 ${c.units.reads}`);
		await userEvent.click(screen.getByRole("button", { name: c.drawer.evidence(2) }));
		expect(h.onEvidence).toHaveBeenCalledWith("tool:t2");
		expect(screen.getByRole("heading", { name: stations.MCP })).toBeTruthy();
		expect(screen.getByText(c.drawer.scopeLive(clock(c, T0)))).toBeTruthy();
	});

	it("says there is no finding, no earlier session, and shows calls, p50/p95, error rate and the parts", async () => {
		const h = handlers();
		const view = wrap(<StationDrawerView drill={{ kind: "done", value: drill() }} station="MCP" at={0} startedAt={T0} hideDetails={false} {...h} />);
		expect(screen.getByText(c.drawer.noFindings)).toBeTruthy();
		expect(screen.getByText(c.drawer.previousNone)).toBeTruthy();
		const tiles = view.container.querySelector("[data-id=lmd-numbers]");
		expect(tiles?.textContent).toContain("14");
		expect(tiles?.textContent).toContain("600 ms / 2,8 s");
		expect(tiles?.textContent).toContain("7,1%");
		expect(screen.getByText("onedash-prod")).toBeTruthy();
		expect(screen.getByText(c.drawer.parts.mcp_server ?? "")).toBeTruthy();
		// No API request at this station: no token line.
		expect(view.container.querySelector("[data-id=lmd-tokens]")).toBeNull();
		await userEvent.click(screen.getByText("onedash-prod › get_host"));
		expect(h.onOpenEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "tool:t2" }));
	});

	it("writes tokens and the estimated cost with *, or 'no cost' when Claude Code gave none", () => {
		const costed = wrap(<StationDrawerView drill={{ kind: "done", value: drill({ station: "CORE", numbers: numbers({ apiRequests: 3, inputTokens: 1_200, outputTokens: 800, cacheReadTokens: 50_000, hasCost: true, costUsdEstimate: 0.75, requestsWithoutCost: 1 }) }) }} station="CORE" at={0} startedAt={T0} hideDetails={false} {...handlers()} />);
		const cost = costed.container.querySelector("[data-id=lmd-cost]");
		expect(cost?.textContent).toContain("*");
		expect(cost?.textContent).toContain(c.drawer.withoutCost(1));
		expect(screen.getByText(c.drawer.costNote)).toBeTruthy();
		costed.unmount();
		const free = wrap(<StationDrawerView drill={{ kind: "done", value: drill({ station: "CORE", numbers: numbers({ apiRequests: 3, outputTokens: 800 }) }) }} station="CORE" at={0} startedAt={T0} hideDetails={false} {...handlers()} />);
		expect(free.container.querySelector("[data-id=lmd-cost]")?.textContent).toBe(c.drawer.noCost);
		expect(screen.queryByText(c.drawer.costNote)).toBeNull();
	});

	it("compares with earlier sessions by rate, and covers the session up to the replayed moment", () => {
		const previous = [
			{ sessionId: "a", startedAt: T0 - 9, numbers: numbers({ p95Ms: 2_000, failures: 0, ended: 10 }) },
			{ sessionId: "b", startedAt: T0 - 8, numbers: numbers({ p95Ms: 2_000, failures: 2, ended: 10 }) },
		];
		const view = wrap(<StationDrawerView drill={{ kind: "done", value: drill({ previous }) }} station="MCP" at={T0 + 3_600_000} startedAt={T0} hideDetails={false} {...handlers()} />);
		expect(view.container.querySelector("[data-metric=p95] dd")?.textContent).toBe("+40%");
		// 1/14 against an average of 0.1.
		expect(view.container.querySelector("[data-metric=errors] dd")?.textContent).toBe("−29%");
		expect(view.container.querySelector("[data-metric=tokens]")).toBeNull();
		expect(screen.getByText(c.drawer.previousOver(2))).toBeTruthy();
		expect(screen.getByText(c.drawer.scopeReplay(clock(c, T0 + 3_600_000)))).toBeTruthy();
	});

	it("hides sub-keys' names, a finding's sub-key and the events' labels with hidden details", () => {
		const view = wrap(<StationDrawerView drill={{ kind: "done", value: drill({ bottlenecks: [finding()] }) }} station="MCP" at={0} startedAt={T0} hideDetails {...handlers()} />);
		const text = view.container.textContent ?? "";
		expect(text).not.toContain("onedash");
		expect(text).toContain(c.drawer.hiddenPart(1));
	});

	it("asks the machine for the station's numbers up to the moment, and says while it loads or why it failed", async () => {
		const fake = new FakeLink();
		wrap(<StationDrawer link={fake.link} sessionId="s1" online station="FILES" at={T0} startedAt={T0} hideDetails={false} {...handlers()} />);
		expect(fake.sent).toEqual([{ case: "observatoryStation", value: { sessionId: "s1", station: "FILES", at: BigInt(T0) } }]);
		expect(screen.getByText(c.drawer.loading)).toBeTruthy();
		fake.answer({ case: "observatoryStationResult", value: create(ObservatoryStationResultSchema, { sessionId: "s1", station: "FILES", numbers: { calls: 5, ended: 4, failures: 1 } }) });
		await flush();
		expect(screen.getByText(c.drawer.noFindings)).toBeTruthy();
		expect(screen.getByText("25%")).toBeTruthy();
	});

	it("closes on Escape and on its close button", async () => {
		const h = handlers();
		wrap(<StationDrawerView drill={{ kind: "loading" }} station="FILES" at={0} startedAt={T0} hideDetails={false} {...h} />);
		fireEvent.keyDown(window, { key: "Escape" });
		await userEvent.click(screen.getByRole("button", { name: c.close }));
		expect(h.onClose).toHaveBeenCalledTimes(2);
	});
});

describe("the event detail", () => {
	const called = tool("t9", 5_000, { station: "SANDBOX", stationFlags: STATION_ESTIMATED, toolName: "Bash", success: false, durationMs: 1_500 });

	it("asks the event's content by id when it opens and shows it", async () => {
		const fake = new FakeLink();
		const h = { onReplayTo: vi.fn(), onClose: vi.fn() };
		wrap(<EventDetail link={fake.link} sessionId="s1" online event={called} hideDetails={false} {...h} />);
		expect(fake.sent).toEqual([{ case: "observatoryContent", value: { sessionId: "s1", eventId: "tool:t9" } }]);
		expect(screen.getByText(c.detail.contentLoading)).toBeTruthy();
		fake.answer({ case: "observatoryContentResult", value: create(ObservatoryContentResultSchema, { eventId: "tool:t9", state: ObservatoryContentState.STORED, text: '{"input":"ls"}' }) });
		await flush();
		expect(screen.getByText('{"input":"ls"}')).toBeTruthy();
		expect(screen.getByText(`${stations.SANDBOX} (${c.detail.estimated})`)).toBeTruthy();
		expect(screen.getByText("1,5 s")).toBeTruthy();
		expect(screen.getByText(c.detail.failed)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: c.detail.replayHere }));
		expect(h.onReplayTo).toHaveBeenCalledWith(T0 + 5_000);
	});

	it("says why there is no content: switched off, not stored yet, none", () => {
		const shown = { event: called, hideDetails: false, onReplayTo: vi.fn(), onClose: vi.fn() };
		const view = wrap(<EventDetailView content={{ kind: "done", value: { eventId: "tool:t9", state: "off", text: "" } }} {...shown} />);
		expect(screen.getByText(c.detail.contentOff)).toBeTruthy();
		view.rerender(
			<I18nProvider>
				<EventDetailView content={{ kind: "done", value: { eventId: "tool:t9", state: "not_yet", text: "" } }} {...shown} event={{ ...called, provisional: true }} />
			</I18nProvider>,
		);
		expect(screen.getByText(c.detail.contentNotYet)).toBeTruthy();
		expect(screen.getByText(`${clock(c, T0 + 5_000)} · ${c.detail.provisional}`)).toBeTruthy();
		view.rerender(
			<I18nProvider>
				<EventDetailView content={{ kind: "done", value: { eventId: "tool:t9", state: "none", text: "" } }} {...shown} />
			</I18nProvider>,
		);
		expect(screen.getByText(c.detail.contentNone)).toBeTruthy();
	});

	it("hides labels and content with hidden details and asks the machine nothing", () => {
		const fake = new FakeLink();
		const mcp = tool("t3", 1_000, { station: "MCP", mcpServer: "onedash-prod", toolName: "mcp__onedash-prod__list_hosts", success: true, durationMs: 10 });
		const view = wrap(<EventDetail link={fake.link} sessionId="s1" online event={mcp} hideDetails onReplayTo={vi.fn()} onClose={vi.fn()} />);
		expect(fake.sent).toEqual([]);
		expect(screen.getByText(c.detail.hidden)).toBeTruthy();
		expect(view.container.textContent).not.toContain("onedash");
		expect(view.container.querySelector("[data-id=lmd-labels]")).toBeNull();
	});

	it("asks nothing for an event without content, and shows an API request's model and tokens", () => {
		const request = api("r1", 1_000, { model: "claude-sonnet-5-5" });
		if (request.kind !== "api") throw new Error("api fixture");
		const withContext: Extract<LiveMapEvent, { kind: "api" }> & { readonly contextTokens: number } = { ...request, contextTokens: 42_000 };
		const fake = new FakeLink();
		wrap(<EventDetail link={fake.link} sessionId="s1" online event={withContext} hideDetails={false} onReplayTo={vi.fn()} onClose={vi.fn()} />);
		expect(fake.sent).toEqual([]);
		expect(screen.getAllByText("claude-sonnet-5-5").length).toBeGreaterThan(0);
		const line = within(screen.getByRole("complementary")).getByText((_, el) => el?.getAttribute("data-id") === "lmd-event-tokens");
		expect(line.textContent).toBe(c.detail.tokenLine("500", tokens(c, 42_000)));
	});
});

describe("the replay bar", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const history = historyOf(snapshot([prompt(1, 0), tool("t1", 1_000, { success: true, durationMs: 10 }), lifecycle("stop", "s", 2_000), prompt(2, 60_000)], { info: info({ startedAt: T0 }) }));
	const timeline = timelineOf(history);
	const marks = marksOf(history, timeline, 60);

	function Harness({ start = LIVE_CURSOR, expired = false, seen }: { start?: ReplayCursor; expired?: boolean; seen?: (c: ReplayCursor) => void }) {
		const [cursor, setCursor] = useState<ReplayCursor>(start);
		return (
			<ReplayBar
				timeline={timeline}
				marks={marks}
				cursor={cursor}
				onCursor={(next) => {
					seen?.(next);
					setCursor(next);
				}}
				loading={false}
				expired={expired}
				partial={false}
				held={3}
			/>
		);
	}

	it("sits at the end while live, plays from the start, and goes back live", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		const seen: ReplayCursor[] = [];
		const view = wrap(<Harness seen={(cur) => seen.push(cur)} />);
		const slider = screen.getByRole("slider", { name: c.replay.slider }) as HTMLInputElement;
		expect(Number(slider.value)).toBe(timeline.end);
		expect(view.container.querySelectorAll(".lmd-mark").length).toBe(marks.length);
		fireEvent.click(screen.getByRole("button", { name: c.replay.play }));
		expect(seen.at(-1)).toEqual({ mode: "replay", at: T0, playing: true, speed: 1 });
		act(() => {
			vi.advanceTimersByTime(PLAY_TICK_MS * 5);
		});
		expect(Number(slider.value)).toBe(T0 + 500);
		expect(screen.getByText(c.replay.held(3))).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: c.replay.pause }));
		fireEvent.click(screen.getByRole("button", { name: c.replay.live }));
		expect(seen.at(-1)).toEqual({ mode: "live", speed: 1 });
		expect(screen.queryByText(c.replay.held(3))).toBeNull();
	});

	it("plays or pauses on Space, steps between events on the arrow keys, drags, and changes speed", () => {
		const seen: ReplayCursor[] = [];
		wrap(<Harness start={{ mode: "replay", at: T0 + 1_000, playing: false, speed: 1 }} seen={(cur) => seen.push(cur)} />);
		const slider = screen.getByRole("slider", { name: c.replay.slider });
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(seen.at(-1)).toMatchObject({ at: T0 + 2_000 });
		fireEvent.keyDown(slider, { key: "ArrowLeft" });
		expect(seen.at(-1)).toMatchObject({ at: T0 + 1_000 });
		fireEvent.keyDown(slider, { key: " " });
		expect(seen.at(-1)).toMatchObject({ playing: true });
		fireEvent.keyDown(slider, { key: " " });
		expect(seen.at(-1)).toMatchObject({ playing: false });
		fireEvent.change(slider, { target: { value: String(T0 + 30_000) } });
		expect(seen.at(-1)).toMatchObject({ mode: "replay", at: T0 + 30_000 });
		fireEvent.click(screen.getByRole("button", { name: c.replay.speed(1) }));
		expect(seen.at(-1)?.speed).toBe(4);
		expect(screen.getByRole("button", { name: c.replay.speed(4) })).toBeTruthy();
	});

	it("is off for a session past 90 days and says only totals are left", () => {
		wrap(<Harness expired />);
		expect(screen.getByText(c.replay.expired)).toBeTruthy();
		expect(screen.queryByRole("slider")).toBeNull();
	});
});

describe("formatting and copy", () => {
	it("compares rates with earlier sessions and has nothing to compare without them", () => {
		expect(compareWithPrevious(numbers(), [])).toEqual([
			{ metric: "p95", delta: null },
			{ metric: "errors", delta: null },
		]);
		expect(compareWithPrevious(numbers({ apiRequests: 2, outputTokens: 200 }), [numbers({ apiRequests: 1, outputTokens: 50 })]).find((r) => r.metric === "tokens")?.delta).toBe(100);
	});

	it("writes a finding's measure as its rule means it", () => {
		expect(findingValue(c, { rule: "mcp_errors", severity: "warn" }, 0.5)).toBe("50%");
		expect(findingValue(c, { rule: "context_high", severity: "alert" }, 92)).toBe("92%");
		expect(findingValue(c, { rule: "api_slow_or_limited", severity: "alert" }, 3)).toBe(`3 ${c.units.limited}`);
		expect(findingValue(c, { rule: "cost_spike", severity: "warn" }, 2.5)).toContain("*");
		expect(findingValue(c, { rule: "cost_spike", severity: "warn" }, 3_000_000)).not.toContain("*");
		expect(findingValue(c, { rule: "tool_slow", severity: "warn" }, undefined)).toBe("—");
	});

	it("has every key in every language", () => {
		const shape = (value: unknown): unknown =>
			typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value;
		expect(shape(OBSERVATORY_COPY.en)).toEqual(shape(OBSERVATORY_COPY.vi));
		expect(shape(OBSERVATORY_COPY["zh-CN"])).toEqual(shape(OBSERVATORY_COPY.vi));
	});
});
