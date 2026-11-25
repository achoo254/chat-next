// The Live Map's frame with a stand-in renderer: the activity card over the
// scene; a name tag per place (the account's email at the input port, the
// last file at the files district); "Ẩn chi tiết" hides names (remembered on
// the device); the context reads as approximate when its window was assumed;
// each place is a button reachable by keyboard that selects it and switches
// the camera to focus, a click on empty ground clears the selection and goes
// back to auto, a drag pans (free), the camera's buttons and note; a click on
// a moving packet opens its event; new animations go to the renderer once; a
// renderer that cannot start leaves the still plate with its note; leaving
// destroys the renderer. MCP tool names stay hidden in tags and boards with
// "Ẩn chi tiết"; a focused district's button never scrolls the frame and the
// camera frames it; a plain wheel scrolls the page unless the camera is free;
// live times read in the machine's clock.
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
import { prompt, T0, tool } from "../machines/observatory/live-map-fixtures.ts";
import { fixtureAssets, played } from "./render-fixtures.ts";

const t = viMachines.observe;
const c = OBSERVATORY_COPY.vi;

type Fake = LiveMapHandle & {
	update: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
	setCameraMode: ReturnType<typeof vi.fn>;
	select: ReturnType<typeof vi.fn>;
	pan: ReturnType<typeof vi.fn>;
	peek: ReturnType<typeof vi.fn>;
	zoomAt: ReturnType<typeof vi.fn>;
};

function fakeHandle(over: Partial<LiveMapHandle> = {}): Fake {
	return {
		renderer: "webgl",
		plate: fixtureAssets().table.plate.full,
		canvas: document.createElement("canvas"),
		update: vi.fn(),
		resize: vi.fn(),
		hitEvent: () => null,
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

function setup(state: LiveMapState, handle = fakeHandle(), mount?: (o: LiveMapMountOptions) => Promise<LiveMapHandle>, selectedPlace: LiveMapStageProps["selectedPlace"] = null, extra: Partial<LiveMapStageProps> = {}) {
	const onStation = vi.fn();
	const onEvent = vi.fn();
	const onDeselect = vi.fn();
	const mounted: LiveMapMountOptions[] = [];
	const mountLiveMap = mount ?? ((o: LiveMapMountOptions) => (mounted.push(o), Promise.resolve(handle)));
	const loadAssets = () => Promise.resolve(fixtureAssets());
	const loadRenderer = () => Promise.resolve({ mountLiveMap });
	const view = (s: LiveMapState) => (
		<I18nProvider>
			<LiveMapStage state={s} accountEmail="ban@example.com" selectedPlace={selectedPlace} onStation={onStation} onEvent={onEvent} onDeselect={onDeselect} loadAssets={loadAssets} loadRenderer={loadRenderer} {...extra} />
		</I18nProvider>
	);
	const r = render(view(state));
	return { ...r, onStation, onEvent, onDeselect, mounted, handle, rerenderWith: (s: LiveMapState) => r.rerender(view(s)) };
}

type LiveMapStageProps = Parameters<typeof LiveMapStage>[0];

beforeEach(() => {
	localStorage.clear();
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(720);
});

afterEach(() => vi.restoreAllMocks());

describe("the Live Map frame", () => {
	it("tags every place, the input port with the account's email and the prompt count, the files with their last file", async () => {
		const { state } = played([prompt(1, 0), prompt(2, 10), tool("r1", 20, { target: "src/app.ts" }), tool("r1", 30, { target: "src/app.ts", success: true })]);
		const { container } = setup(state);
		await flush();
		expect(container.querySelectorAll(".lm-tag")).toHaveLength(13);
		const desk = container.querySelector("[data-id=observe-tag-user-desk]");
		expect(desk?.textContent).toContain("ban@example.com");
		expect(desk?.textContent).toContain(t.map.prompt(2));
		const files = container.querySelector("[data-id=observe-tag-files]");
		expect(files?.textContent).toContain("src/app.ts");
		expect(files?.textContent).toContain(t.map.calls(1, 0));
		expect(container.querySelector("[data-id=observe-road-files]")?.textContent).toContain(c.board.calls(1));
	});

	it("shows the activity card over the scene, and its details button opens the event", async () => {
		const { state } = played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "SANDBOX" })]);
		const { container, onEvent } = setup(state);
		await flush();
		const card = container.querySelector("[data-id=observe-card]");
		expect(card?.getAttribute("data-status")).toBe("run");
		expect(container.querySelector("[data-id=observe-card-what]")?.textContent).toBe("Bash pnpm");
		expect(container.querySelector("[data-id=observe-card-bar]")).not.toBeNull();
		await userEvent.click(screen.getByRole("button", { name: c.card.more }));
		expect(onEvent).toHaveBeenCalledWith("tool:b1");
	});

	it("a place with a running call is at work: its tag names the tool and target, the details switch hides the target, and it stops when the call ends", async () => {
		const running = played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "TESTING" }), tool("b2", 21, { toolName: "Bash", target: "git", station: "TESTING" })]).state;
		const { container, rerenderWith } = setup(running);
		await flush();
		const testing = container.querySelector("[data-id=observe-tag-testing] [data-id=observe-working]");
		expect(testing?.textContent).toBe("Bash +1 · pnpm");
		expect(container.querySelector("[data-id=observe-place-testing]")?.hasAttribute("data-working")).toBe(true);
		await userEvent.click(screen.getByLabelText(t.map.hideDetails));
		expect(container.querySelector("[data-id=observe-tag-testing] [data-id=observe-working]")?.textContent).toBe("Bash +1");
		expect(container.querySelector("[data-id=observe-card-what]")?.textContent).toBe("Bash");
		rerenderWith(played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "TESTING" }), tool("b1", 30, { toolName: "Bash", target: "pnpm", station: "TESTING", success: true })]).state);
		await flush();
		expect(container.querySelector("[data-id=observe-tag-testing] [data-id=observe-working]")).toBeNull();
	});

	it("'Ẩn chi tiết' hides file names and the email, and is remembered", async () => {
		const { state } = played([tool("r1", 20, { target: "src/app.ts", success: true })]);
		const first = setup(state);
		await flush();
		await userEvent.click(screen.getByLabelText(t.map.hideDetails));
		expect(first.container.textContent).not.toContain("src/app.ts");
		expect(first.container.textContent).not.toContain("ban@example.com");
		expect(localStorage.getItem(HIDE_DETAILS_KEY)).toBe("1");
		first.unmount();
		const again = setup(state);
		await flush();
		expect(again.container.textContent).not.toContain("src/app.ts");
		expect((screen.getByLabelText(t.map.hideDetails) as HTMLInputElement).checked).toBe(true);
	});

	it("'Ẩn chi tiết' hides an MCP tool's name in the tag, the board and the card", async () => {
		const mcp = tool("m1", 20, { toolName: "mcp__acme-crm__lookup_customer", mcpServer: "acme-crm", target: "acme-crm › lookup_customer", station: "MCP" });
		const ended = tool("m0", 5, { toolName: "mcp__acme-crm__list", mcpServer: "acme-crm", target: "acme-crm › list", station: "MCP", success: true, durationMs: 3 });
		const { state } = played([prompt(1, 0), ended, mcp]);
		let report: ((c: CameraState) => void) | undefined;
		const handle = fakeHandle();
		const { container } = setup(state, handle, (o) => ((report = o.onCamera), Promise.resolve(handle)));
		await flush();
		act(() => report?.({ mode: "auto", zone: "mcp", contentZone: "mcp", switches: 1 }));
		expect(container.querySelector("[data-id=observe-board-mcp]")?.textContent).toContain("mcp__acme-crm__lookup_customer");
		await userEvent.click(screen.getByLabelText(t.map.hideDetails));
		expect(container.querySelector("[data-id=observe-tag-mcp] [data-id=observe-working]")?.textContent).toBe(c.detail.kinds.tool);
		expect(container.querySelector("[data-id=observe-board-mcp]")?.textContent).toContain(`▶ ${c.detail.kinds.tool}`);
		expect(container.querySelector("[data-id=observe-card-what]")?.textContent).toBe(c.detail.kinds.tool);
		expect(container.textContent).not.toContain("mcp__");
		expect(container.textContent).not.toContain("acme-crm");
	});

	it("focusing a district's button never scrolls the frame and frames the district; leaving the map lets the camera go", async () => {
		const { state } = played([]);
		const { handle, container } = setup(state);
		await flush();
		const frame = container.querySelector<HTMLElement>(".lm-frame");
		if (frame === null) throw new Error("no frame");
		const git = screen.getByRole("button", { name: t.stations.GIT });
		frame.scrollLeft = 120;
		frame.scrollTop = 40;
		act(() => git.focus());
		expect(handle.peek).toHaveBeenLastCalledWith("git");
		expect([frame.scrollLeft, frame.scrollTop]).toEqual([0, 0]);
		// The browser scrolls the clipped frame to show a focused child: it is put back at once.
		frame.scrollLeft = 300;
		fireEvent.scroll(frame);
		expect(frame.scrollLeft).toBe(0);
		// From one district to the next: the next is framed, the camera is not let go in between.
		act(() => screen.getByRole("button", { name: t.stations.CORE }).focus());
		expect(handle.peek).toHaveBeenLastCalledWith("core");
		expect(handle.peek).not.toHaveBeenCalledWith(null);
		act(() => screen.getByLabelText(t.map.hideDetails).focus());
		expect(handle.peek).toHaveBeenLastCalledWith(null);
	});

	it("a plain wheel scrolls the page; Ctrl or Cmd + wheel zooms, and in free the wheel alone does", async () => {
		const { state } = played([]);
		let report: ((c: CameraState) => void) | undefined;
		const handle = fakeHandle();
		const { container } = setup(state, handle, (o) => ((report = o.onCamera), Promise.resolve(handle)));
		await flush();
		const frame = container.querySelector(".lm-frame");
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

	it("reads live times in the machine's clock: the card's runtime and the renderer's clock", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			// The viewer's clock is 5 s behind the machine's: 2 s after the call started there.
			vi.setSystemTime(T0 + 20 + 2_000 - 5_000);
			const { state } = played([prompt(1, 0), tool("b1", 20, { toolName: "Bash", target: "pnpm", station: "SANDBOX" })]);
			const { container, mounted } = setup(state, fakeHandle(), undefined, null, { clockSkewMs: 5_000 });
			await flush();
			expect(container.querySelector("[data-id=observe-card-runtime]")?.textContent).toBe("2 s");
			expect(mounted[0]?.wallClock?.()).toBe(T0 + 20 + 2_000);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows the context as approximate when its window was assumed", async () => {
		const { state } = played([prompt(1, 0)]);
		const exact = setup({ ...state, live: live({}) });
		await flush();
		expect(exact.container.querySelector("[data-id=observe-context]")?.textContent).toBe(t.map.context(62));
		exact.unmount();
		const assumed = setup({ ...state, live: live({ contextWindowAssumed: true }) });
		await flush();
		const context = assumed.container.querySelector("[data-id=observe-context]");
		expect(context?.textContent).toBe(t.map.contextApprox(62));
		expect(context?.getAttribute("title")).toBe(t.map.contextApproxHint);
	});

	it("each place is a button: Tab reaches it, Enter selects it and focuses the camera on it", async () => {
		const { state } = played([]);
		const { onStation, handle } = setup(state);
		await flush();
		const core = screen.getByRole("button", { name: t.stations.CORE });
		core.focus();
		await userEvent.keyboard("{Enter}");
		expect(onStation).toHaveBeenCalledWith("core");
		expect(handle.select).toHaveBeenCalledWith("core");
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("focus");
		await userEvent.click(screen.getByRole("button", { name: t.map.gateway }));
		expect(onStation).toHaveBeenLastCalledWith("security");
	});

	it("a click on empty ground clears the selection and goes back to auto", async () => {
		const { state } = played([]);
		const { onDeselect, handle, container } = setup(state);
		await flush();
		const frame = container.querySelector(".lm-frame");
		if (frame === null) throw new Error("no frame");
		fireEvent.click(frame, { detail: 1 });
		expect(onDeselect).toHaveBeenCalledOnce();
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("auto");
	});

	it("a drag pans the camera (free) and is not a click", async () => {
		const { state } = played([]);
		const { onDeselect, handle, container } = setup(state);
		await flush();
		const frame = container.querySelector(".lm-frame");
		if (frame === null) throw new Error("no frame");
		fireEvent.pointerDown(frame, { pointerId: 1, clientX: 100, clientY: 100 });
		fireEvent.pointerMove(frame, { pointerId: 1, clientX: 140, clientY: 110 });
		fireEvent.pointerMove(frame, { pointerId: 1, clientX: 160, clientY: 110 });
		fireEvent.pointerUp(frame, { pointerId: 1, clientX: 160, clientY: 110 });
		fireEvent.click(frame, { detail: 1 });
		expect(handle.pan).toHaveBeenCalled();
		expect(onDeselect).not.toHaveBeenCalled();
	});

	it("the camera's buttons switch its mode; focus with nothing selected selects the zone; the note tells where it looks", async () => {
		const { state } = played([]);
		let report: ((c: CameraState) => void) | undefined;
		const { handle, onStation, container } = setup(state, fakeHandle(), (o) => ((report = o.onCamera), Promise.resolve(handle)));
		await flush();
		await userEvent.click(screen.getByRole("button", { name: c.camera.free }));
		expect(handle.setCameraMode).toHaveBeenLastCalledWith("free");
		act(() => report?.({ mode: "auto", zone: "files", contentZone: "files", switches: 1 }));
		expect(container.querySelector("[data-id=observe-camera-note]")?.textContent).toBe(c.camera.note(t.stations.FILES, 1));
		expect(container.querySelector("[data-id=observe-board-files]")).not.toBeNull();
		await userEvent.click(screen.getByRole("button", { name: c.camera.focus }));
		expect(onStation).toHaveBeenLastCalledWith("files");
	});

	it("a click on a moving packet opens its source event", async () => {
		const handle = fakeHandle({ hitEvent: () => "tool:r1" });
		const { state } = played([]);
		const { onEvent, onStation } = setup(state, handle);
		await flush();
		await userEvent.click(screen.getByRole("button", { name: t.stations.FILES }));
		expect(onEvent).toHaveBeenCalledWith("tool:r1");
		expect(onStation).not.toHaveBeenCalled();
	});

	it("gives the renderer each new animation once, and destroys it on leaving", async () => {
		const first = played([prompt(1, 0)]);
		const { mounted, handle, rerenderWith, unmount, container } = setup(first.state);
		await flush();
		expect(mounted).toHaveLength(1);
		expect(container.querySelector("[data-id=observe-stage]")?.getAttribute("data-renderer")).toBe("webgl");
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

	it("without WebGL or Canvas shows the still plate, the tags and a note, and no camera controls", async () => {
		const { state } = played([]);
		const { container } = setup(state, fakeHandle(), () => Promise.reject(new Error("No available renderer for the current environment")));
		await flush();
		expect(container.querySelector("[data-id=observe-stage]")?.getAttribute("data-status")).toBe("still");
		expect(container.querySelector(".lm-plate")).not.toBeNull();
		expect(screen.getByText(t.map.still)).toBeTruthy();
		expect(container.querySelectorAll(".lm-hit")).toHaveLength(13);
		expect(container.querySelector("[data-id=observe-camera]")).toBeNull();
	});

	it("a lost context shows the plate until it is restored; a second loss keeps it still and destroys the renderer", async () => {
		const handle = fakeHandle();
		let opts: LiveMapMountOptions | null = null;
		const { state } = played([]);
		const { container } = setup(state, handle, (o) => ((opts = o), Promise.resolve(handle)));
		await flush();
		const o = opts as LiveMapMountOptions | null;
		if (o === null) throw new Error("not mounted");
		act(() => o.onStill?.("lost"));
		expect(screen.getByText(t.map.lost)).toBeTruthy();
		expect(container.querySelector(".lm-plate")).not.toBeNull();
		act(() => o.onRestored?.());
		expect(container.querySelector(".lm-plate")).toBeNull();
		act(() => o.onStill?.("given-up"));
		expect(handle.destroy).toHaveBeenCalledOnce();
		expect(screen.getByText(t.map.still)).toBeTruthy();
	});
});
