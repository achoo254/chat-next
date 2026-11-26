// The Live Map with a stand-in scene, laid out as the approved design: the
// activity card over the scene, its "Xem chi tiết" opening the event's
// detail in the column; the session's gauges (the context approximate when
// its window was assumed); the event list, newest first, a click on a call
// opening its detail and on another row picking its module; each module a
// button reachable by keyboard that picks it (its detail shows) and switches
// the camera to focus, a click on empty ground clearing the pick and going
// back to auto, a drag panning (free), the camera's buttons and note; a click
// on a moving packet opening its event; new animations going to the scene
// once; a scene that cannot start leaving a note; leaving dropping the scene;
// "Ẩn chi tiết" hiding names (remembered on the device, handed to the
// scene); a focused module's button never scrolling the frame; a plain wheel
// scrolling the page unless the camera is free; live times read in the
// machine's clock; no drawer and no replay bar.
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { viMachines } from "../../src/machines/copy-vi.ts";
import type { LiveMapState } from "../../src/machines/observatory/live-map-state.ts";
import type { LiveMapLiveState } from "../../src/machines/observatory/live-map-types.ts";
import { OBSERVATORY_COPY } from "../../src/machines/observatory/observatory-copy.ts";
import type { CameraState, LiveMapHandle, LiveMapMountOptions } from "../../src/machines/observatory/render/live-map-app.ts";
import { HIDE_DETAILS_KEY, LiveMapStage } from "../../src/machines/observatory/render/live-map-stage.tsx";
import { lifecycle, prompt, T0, tool } from "../machines/observatory/live-map-fixtures.ts";
import { played } from "./render-fixtures.ts";

const t = viMachines.observe;
const c = OBSERVATORY_COPY.vi;

type Fake = LiveMapHandle & {
	update: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	setCameraMode: ReturnType<typeof vi.fn>;
	setHide: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	pan: ReturnType<typeof vi.fn>;
	peek: ReturnType<typeof vi.fn>;
	zoomAt: ReturnType<typeof vi.fn>;
};

function fakeHandle(over: Partial<LiveMapHandle> = {}): Fake {
	return {
		canvas: document.createElement("canvas"),
		update: vi.fn(),
		resize: vi.fn(),
		setWords: vi.fn(),
		setHide: vi.fn(),
		hitEvent: () => null,
		placeAt: () => null,
		toScene: (x: number, y: number) => [x, y] as const,
		setCameraMode: vi.fn(),
		select: vi.fn(),
		peek: vi.fn(),
		pan: vi.fn(),
		zoomAt: vi.fn(),
		camera: () => ({ mode: "auto", zone: null, contentZone: null, switches: 0 }),
		frames: () => 0,
		animationLog: () => [],
		destroy: vi.fn(),
		...over,
	} as Fake;
}

const flush = async (): Promise<void> => {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
};

const live = (over: Partial<LiveMapLiveState>): LiveMapLiveState => ({
	core: "thinking",
	tokensPerSecond: 38,
	contextPercent: 62,
	contextTokens: 124_000,
	contextWindow: 200_000,
	contextWindowAssumed: false,
	mainModel: "claude-opus-4",
	running: [],
	openBottlenecks: 0,
	...over,
});

type StageProps = Parameters<typeof LiveMapStage>[0];
type Mount = (o: LiveMapMountOptions) => LiveMapHandle;

function setup(state: LiveMapState, handle = fakeHandle(), mount?: Mount, extra: Partial<StageProps> = {}) {
	const onPick = vi.fn();
	const mounted: LiveMapMountOptions[] = [];
	const mountLiveMap: Mount = mount ?? ((o) => (mounted.push(o), handle));
	const loadRenderer = () => Promise.resolve({ mountLiveMap });
	const view = (s: LiveMapState) => (
		<I18nProvider>
			<LiveMapStage state={s} onPick={onPick} loadRenderer={loadRenderer} {...extra} />
		</I18nProvider>
	);
	const r = render(view(state));
	return { ...r, onPick, mounted, handle, rerenderWith: (s: LiveMapState) => r.rerender(view(s)) };
}

const text = (root: HTMLElement, id: string): string => root.querySelector(`[data-id=${id}]`)?.textContent ?? "";

beforeEach(() => {
	localStorage.clear();
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(720);
});

afterEach(() => vi.restoreAllMocks());

describe("the Live Map", () => {
	it("shows the card, the session's gauges, the detail hint, the events and the legend; no drawer, no replay bar", async () => {
		const { state } = played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "SANDBOX" })]);
		const { container } = setup({ ...state, live: live({ core: "idle" }) });
		await flush();
		expect(container.querySelector("[data-id=observe-card]")?.getAttribute("data-status")).toBe("run");
		expect(text(container, "observe-card-what")).toBe("Bash pnpm");
		expect(container.querySelector("[data-id=observe-card-bar]")).not.toBeNull();
		expect(text(container, "observe-session")).toContain("claude-opus-4");
		expect(text(container, "observe-context")).toBe(`${c.side.context} 62%`);
		expect(text(container, "observe-detail-body")).toBe(c.side.detailHint);
		expect(text(container, "observe-feed-count")).toBe("2");
		const rows = [...container.querySelectorAll(".lm-feed li")].map((li) => li.querySelector(".x")?.textContent);
		expect(rows).toEqual(["Bash pnpm", c.feed.prompt]);
		expect(container.querySelector(".lm-feed li .d")?.textContent).toBe(c.feed.running);
		expect(container.querySelectorAll(".lm-legend > div")).toHaveLength(c.legend.length);
		expect(container.querySelector("[data-id=lmd-drawer], [data-id=lmd-replay]")).toBeNull();
	});

	it("the card's details button and a call's row open the event's detail; another row picks its module", async () => {
		const { state } = played([prompt(1, 0), tool("r1", 10, { target: "src/app.ts" }), tool("r1", 30, { target: "src/app.ts", success: true, durationMs: 20 }), lifecycle("stop", "s1", 40)]);
		const { container, onPick } = setup(state);
		await flush();
		await userEvent.click(screen.getByRole("button", { name: c.card.more }));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "event", eventId: "tool:r1" });
		expect(text(container, "observe-detail-title")).toContain("Read");
		expect(text(container, "observe-detail-status")).toContain(c.side.ok);
		expect(text(container, "observe-detail-body")).toContain("src/app.ts");
		await userEvent.click(screen.getByText(c.feed.stop));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "core" });
		expect(text(container, "observe-detail-title")).toBe(t.stations.CORE);
		await userEvent.click(screen.getByText("Read src/app.ts"));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "event", eventId: "tool:r1" });
	});

	it("a module's detail: its calls, p50 / p95 history, failures and recent calls", async () => {
		const { state } = played([prompt(1, 0), tool("r1", 10), tool("r1", 30, { success: true, durationMs: 20 }), tool("r2", 40), tool("r2", 90, { success: false, durationMs: 50 })]);
		const { container } = setup(state);
		await flush();
		await userEvent.click(screen.getByRole("button", { name: t.stations.FILES }));
		const body = text(container, "observe-detail-body");
		expect(body).toContain(c.side.p50p95);
		expect(body).toContain(`${c.side.errors}1 / 2`);
		expect(body).toContain(c.side.recent);
	});

	it("shows the context as approximate when its window was assumed", async () => {
		const { state } = played([prompt(1, 0)]);
		const { container } = setup({ ...state, live: live({ contextWindowAssumed: true }) });
		await flush();
		const context = container.querySelector("[data-id=observe-context]");
		expect(context?.textContent).toBe(`${c.side.context} ~62%`);
		expect(context?.getAttribute("title")).toBe(t.map.contextApproxHint);
	});

	it("'Ẩn chi tiết' hides names in the card and the events, is remembered and reaches the scene", async () => {
		const { state } = played([prompt(1, 0), tool("r1", 10, { target: "src/view.tsx" })]);
		const { container, handle } = setup(state);
		await flush();
		expect(container.textContent).toContain("src/view.tsx");
		await userEvent.click(screen.getByLabelText(t.map.hideDetails));
		expect(container.textContent).not.toContain("src/view.tsx");
		expect(localStorage.getItem(HIDE_DETAILS_KEY)).toBe("1");
		expect(handle.setHide).toHaveBeenLastCalledWith(true);
	});

	it("each module is a button: Tab reaches it, Enter picks it and focuses the camera on it", async () => {
		const { state } = played([]);
		const { onPick, handle } = setup(state);
		await flush();
		const core = screen.getByRole("button", { name: t.stations.CORE });
		core.focus();
		await userEvent.keyboard("{Enter}");
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "core" });
		expect(handle.select).toHaveBeenCalledWith("core");
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("focus");
		await userEvent.click(screen.getByRole("button", { name: t.map.gateway }));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "security" });
	});

	it("the release steps drawn in the Git module explain themselves on hover, and a click on one still picks the module", async () => {
		const { state } = played([]);
		const { onPick } = setup(state);
		await flush();
		const hints = OBSERVATORY_COPY.vi.side.stepHint;
		const steps = [...document.querySelectorAll<HTMLElement>(".lm-step")];
		expect(steps.map((el) => el.getAttribute("title"))).toEqual([hints.commit, hints.push, hints.ci, hints.deploy]);
		await userEvent.click(steps[2] as HTMLElement);
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "git" });
	});

	it("focusing a module's button never scrolls the frame and frames it; leaving the scene lets the camera go", async () => {
		const { state } = played([]);
		const { handle, container } = setup(state);
		await flush();
		const frame = container.querySelector<HTMLElement>(".lm-board");
		if (frame === null) throw new Error("no frame");
		frame.scrollLeft = 120;
		act(() => screen.getByRole("button", { name: t.stations.GIT }).focus());
		expect(handle.peek).toHaveBeenLastCalledWith("git");
		expect(frame.scrollLeft).toBe(0);
		act(() => screen.getByRole("button", { name: t.stations.CORE }).focus());
		expect(handle.peek).not.toHaveBeenCalledWith(null);
		act(() => screen.getByLabelText(t.map.hideDetails).focus());
		expect(handle.peek).toHaveBeenLastCalledWith(null);
	});

	it("a drag pans and is not a click; empty ground clears the pick", async () => {
		const { state } = played([]);
		const { onPick, handle, container } = setup(state);
		await flush();
		const frame = container.querySelector(".lm-board");
		if (frame === null) throw new Error("no frame");
		fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(frame, { pointerId: 1, clientX: 140, clientY: 110 });
		fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 110 });
		fireEvent.pointerUp(frame, { pointerId: 1, clientX: 160, clientY: 110 });
		fireEvent.click(frame, { detail: 1 });
		expect(handle.pan).toHaveBeenCalled();
		expect(onPick).not.toHaveBeenCalled();
		// Not in focus (the scene says auto): empty ground clears the pick and leaves the camera's mode alone.
		fireEvent.click(frame, { detail: 1 });
		expect(onPick).toHaveBeenLastCalledWith(null);
		expect(handle.setCameraMode).not.toHaveBeenCalledWith("auto");
	});

	it("in focus, empty ground goes back to auto; an event's detail keeps the focused module", async () => {
		const { state } = played([prompt(1, 0), tool("r1", 10)]);
		let report: ((cam: CameraState) => void) | undefined;
		const handle = fakeHandle();
		const { onPick, container } = setup(state, handle, (o) => ((report = o.onCamera), handle));
		await flush();
		await userEvent.click(screen.getByRole("button", { name: t.stations.FILES }));
		act(() => report?.({ mode: "focus", zone: null, contentZone: "files", switches: 0 }));
		handle.select.mockClear();
		await userEvent.click(screen.getByRole("button", { name: c.card.more }));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "event", eventId: "tool:r1" });
		expect(handle.select).not.toHaveBeenCalledWith(null);
		const frame = container.querySelector(".lm-board");
		if (frame === null) throw new Error("no frame");
		fireEvent.click(frame, { detail: 1 });
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("auto");
	});

	it("a pointer click picks the module the scene finds, or the moving packet's event", async () => {
		const handle = fakeHandle({ placeAt: () => "external" });
		const { state } = played([]);
		const { onPick, container } = setup(state, handle);
		await flush();
		const frame = container.querySelector(".lm-board");
		if (frame === null) throw new Error("no frame");
		fireEvent.click(frame, { detail: 1 });
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "external" });
		handle.hitEvent = () => "tool:r1";
		fireEvent.click(frame, { detail: 1 });
		expect(onPick).toHaveBeenLastCalledWith({ kind: "event", eventId: "tool:r1" });
	});

	it("the camera's buttons switch its mode; focus with nothing picked picks the zone; the note tells where it looks", async () => {
		const { state } = played([prompt(1, 0)]);
		let report: ((cam: CameraState) => void) | undefined;
		const handle = fakeHandle();
		const { onPick, container } = setup(state, handle, (o) => ((report = o.onCamera), handle));
		await flush();
		await userEvent.click(screen.getByRole("button", { name: c.camera.free }));
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("free");
		act(() => report?.({ mode: "auto", zone: "files", contentZone: "files", switches: 1 }));
		expect(text(container, "observe-camera-note")).toBe(c.camera.note(t.stations.FILES, 1, 1));
		await userEvent.click(screen.getByRole("button", { name: c.camera.focus }));
		expect(onPick).toHaveBeenLastCalledWith({ kind: "place", place: "files" });
	});

	it("a plain wheel scrolls the page; Ctrl or Cmd + wheel zooms, and in free the wheel alone does", async () => {
		const { state } = played([]);
		let report: ((cam: CameraState) => void) | undefined;
		const handle = fakeHandle();
		const { container } = setup(state, handle, (o) => ((report = o.onCamera), handle));
		await flush();
		const frame = container.querySelector(".lm-board");
		if (frame === null) throw new Error("no frame");
		const wheel = (init: WheelEventInit): boolean => frame.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, cancelable: true, bubbles: true, ...init }));
		expect(wheel({})).toBe(true);
		expect(handle.zoomAt).not.toHaveBeenCalled();
		expect(wheel({ ctrlKey: true })).toBe(false);
		expect(wheel({ metaKey: true })).toBe(false);
		expect(handle.zoomAt).toHaveBeenCalledTimes(2);
		act(() => report?.({ mode: "free", zone: null, contentZone: null, switches: 0 }));
		expect(wheel({})).toBe(false);
		expect(handle.zoomAt).toHaveBeenCalledTimes(3);
	});

	it("reads live times in the machine's clock: the card's runtime and the scene's clock", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			// The viewer's clock is 5 s behind the machine's: 2 s after the call started there.
			vi.setSystemTime(T0 + 20 + 2_000 - 5_000);
			const { state } = played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "SANDBOX" })]);
			const { container, mounted } = setup(state, fakeHandle(), undefined, { clockSkewMs: 5_000 });
			await flush();
			expect(text(container, "observe-card-runtime")).toBe("2 s");
			expect(mounted[0]?.wallClock?.()).toBe(T0 + 20 + 2_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gives the scene each new animation once, and drops it on leaving", async () => {
		const first = played([prompt(1, 0)]);
		const { mounted, handle, rerenderWith, unmount } = setup(first.state);
		await flush();
		expect(mounted).toHaveLength(1);
		const run = played([prompt(1, 0), tool("r1", 10)]);
		const next = { ...run.state, animations: run.animations };
		rerenderWith(next);
		await flush();
		const sent = handle.update.mock.calls.map(([, anims]) => (anims as { eventId: string }[]).map((a) => a.eventId));
		expect(sent.flat()).toEqual(expect.arrayContaining(["tool:r1"]));
		rerenderWith(next);
		await flush();
		expect(handle.update.mock.calls.map(([, anims]) => (anims as unknown[]).length).filter((n) => n > 0).length).toBeLessThanOrEqual(1);
		unmount();
		expect(handle.destroy).toHaveBeenCalledOnce();
	});

	it("without a 2D canvas says so, keeps the modules' buttons and shows no camera controls", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { state } = played([]);
		const { container } = setup(state, fakeHandle(), () => {
			throw new Error("live map: no 2D canvas");
		});
		await flush();
		expect(container.querySelector("[data-id=observe-stage]")?.getAttribute("data-status")).toBe("still");
		expect(screen.getByText(t.map.still)).toBeTruthy();
		expect(container.querySelectorAll(".lm-hit")).toHaveLength(12);
		expect(container.querySelector(".lm-camctl")).toBeNull();
	});

	it("opens with a link's event in the detail", async () => {
		const { state } = played([prompt(1, 0), tool("r1", 10, { target: "src/app.ts" })]);
		const { container } = setup(state, fakeHandle(), undefined, { initialEvent: "tool:r1" });
		await flush();
		expect(text(container, "observe-detail-status")).toContain(c.side.running);
	});
});
