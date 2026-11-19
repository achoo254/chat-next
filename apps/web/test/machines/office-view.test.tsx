// The office tab: the note for an older tunelo (and no frame to it), every
// room of the plan grouped by zone with its people and boards on a plain
// background, the framing button, the line for an AI that does not report its
// staff, the baked picture with each person at their anchor and the work
// zone's framing on a phone, and the session header's view switch (shown only
// with two views or more) with the office's route.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, MachineInfoSchema, OfficeActorState, OfficeRoom, type Frame } from "@achoo254/chat-proto/remote/remote";
import { act as reactAct, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { aiPaths } from "../../src/machines/ai-paths.ts";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import OfficeView, { openingFraming, refusalText } from "../../src/machines/office/office-view.tsx";
import { Office2D, pictureFraming, WORK_ZONE, zoneBox } from "../../src/machines/office/office-2d.tsx";
import type { AssetView, OfficeAssets } from "../../src/machines/office/office-assets.ts";
import { officeDaypart } from "../../src/machines/office/office-daypart.ts";
import type { ScreenSize } from "../../src/machines/office/office-geometry.ts";
import { OFFICE_LAYOUT, type OfficeLayout } from "../../src/machines/office/office-layout.ts";
import { EMPTY_MEMORY, officePlacement } from "../../src/machines/office/office-placement.ts";
import type { OfficeFraming } from "../../src/machines/office/office-renderer.ts";
import { ModeSwitch, modePath, officeOffered, openSessionIn, pickedMode, rememberSessionMode, rowMode, sessionModeOf, sessionModes, sessionPath } from "../../src/machines/session-mode.tsx";
import { matchRoute } from "../../src/router.tsx";
import { act, director, session, snapshot, staff, storeAt } from "./office-builders.ts";

/** The shipped layout (the tests of office-layout.ts check it parses). */
function shippedLayout(): OfficeLayout {
	if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("; "));
	return OFFICE_LAYOUT.value;
}

type FixtureView = { width: number; height: number; day: string; night: string; anchors: Record<string, [number, number]> };
const FIXTURE_TEXT = readFileSync(resolve(process.cwd(), "test/machines/fixtures/office-assets.json"), "utf8");
const FIXTURE = JSON.parse(FIXTURE_TEXT) as { views: Record<ScreenSize, FixtureView> };

function assetView(view: FixtureView): AssetView {
	return { width: view.width, height: view.height, day: view.day, night: view.night, anchors: new Map(Object.entries(view.anchors)) };
}

const FIXTURE_ASSETS: OfficeAssets = { views: { desktop: assetView(FIXTURE.views.desktop), phone: assetView(FIXTURE.views.phone) } };

type Body = Parameters<MachineLink["request"]>[0];

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

/** A link that records requests and lets the test play the machine's frames. */
function fakeLink() {
	const sent: Body[] = [];
	const rejects: ((err: unknown) => void)[] = [];
	const frames = new Set<(body: Frame["body"]) => void>();
	const link = {
		request: (body: Body) => {
			sent.push(body);
			return new Promise<Frame>((_resolve, reject) => rejects.push(reject));
		},
		onFrame: (listener: (body: Frame["body"]) => void) => {
			frames.add(listener);
			return () => frames.delete(listener);
		},
		subscribe: () => () => undefined,
		snapshot: () => ({ status: { kind: "open" } }) as LinkState,
	};
	return {
		link: link as unknown as MachineLink,
		sent,
		deliver: (body: Frame["body"]) => reactAct(() => frames.forEach((listener) => listener(body))),
		/** The oldest request fails. */
		reject: (err: unknown) => reactAct(async () => rejects.shift()?.(err)),
	};
}

const info = (agentVersion: string) => create(MachineInfoSchema, { agentVersion });

/** Office hours on the viewer's clock: off-duty people stay on the work floors (office-life-schedule.ts). */
const OFFICE_HOURS = new Date(2026, 10, 16, 10, 0).getTime();

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(OFFICE_HOURS);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	window.localStorage.clear();
});

describe("the office tab", () => {
	it("asks an older tunelo to update and sends it nothing", () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.5.1")} online />);
		expect(screen.getByRole("status").textContent).toMatch(/Cập nhật tunelo trên máy \(3\.6\.0 trở lên\)/);
		expect(fake.sent).toEqual([]);
	});

	it("shows every room of the plan at once, grouped by zone, with their people and the meeting room's +N, and opens with the overview panel beside them", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		expect(fake.sent).toEqual([{ case: "officeWatch", value: { threadId: "t1", on: true, advisorRole: true } }]);
		const types = ["scout", "tester", "planner", "debugger", "docs-manager", "general-purpose", "a", "b", "c"];
		const staffList = types.map((t, i) => staff(`s${i}`, t, { state: OfficeActorState.DONE }));
		const sender = staff("s9", "researcher", { activity: act("t1", OfficeRoom.POST, "Bash") });
		fake.deliver({ case: "officeSnapshot", value: snapshot([director(), ...staffList, sender], { session: session({ tasksDone: 7 }) }) });
		// The research analyst works in the post room of the records zone, shown beside the work zone without any pick.
		const records = await screen.findByRole("region", { name: "Hồ sơ" });
		const post = within(records).getByRole("region", { name: "Bưu phòng" });
				expect(within(post).getByText("Kỹ sư R&D")).toBeTruthy();
		const management = screen.getByRole("region", { name: "Điều hành" });
		const work = within(management).getByRole("region", { name: "Phòng làm việc chung" });
		expect(within(work).getByText("Giám đốc Công nghệ")).toBeTruthy();
		// Everyone has a seat of their own: nobody waits for a desk in the meeting room.
		const meeting = within(management).getByRole("region", { name: "Phòng họp" });
		expect(within(meeting).queryByLabelText(/người chờ bàn trong phòng họp/)).toBeNull();
		// The wall boards are gone from the rooms: their counts and the news are in the panel beside the plan, open from the start.
		expect(document.querySelector(".of-board")).toBeNull();
		const overview = screen.getByRole("complementary", { name: "Tổng quan văn phòng" });
		const working = within(overview).getByRole("region", { name: /Đang làm/ });
		expect(working.textContent).toContain("Kỹ sư R&D");
		expect(within(overview).getByText("Việc xong").nextElementSibling?.textContent).toBe("7");
		// No floor tabs and no follow switch any more.
		expect(document.querySelector('[data-id="office-floors"]')).toBeNull();
		expect(document.querySelector('[data-id="office-follow"]')).toBeNull();
	});

	it("groups the room cards by the layout's zones, in its order, each zone with exactly its rooms", async () => {
		const layout = shippedLayout();
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director()]) });
		const zones = await screen.findAllByRole("region", { name: /^(Điều hành|Hồ sơ|Kiểm soát|Sinh hoạt)$/ });
		expect(zones.map((z) => z.getAttribute("data-zone"))).toEqual(layout.zones.map((z) => z.id));
		for (const [i, zone] of layout.zones.entries()) {
			const section = zones[i];
			if (section === undefined) throw new Error(`no section for zone ${zone.id}`);
			expect([...section.querySelectorAll(".of-room")].map((r) => r.getAttribute("data-room"))).toEqual([...zone.rooms]);
		}
	});

	it("after 23:00 sends the off-duty people to bed in the living zone", async () => {
		vi.setSystemTime(new Date(2026, 10, 16, 23, 30).getTime());
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ state: OfficeActorState.IDLE }), staff("s1", "scout", { state: OfficeActorState.DONE })], { session: session({ busy: false }) }) });
		const living = await screen.findByRole("region", { name: "Sinh hoạt" });
		const dorm = within(living).getByRole("region", { name: "Ký túc" });
		expect(within(dorm).getByText("Giám đốc điều hành")).toBeTruthy();
		expect(within(dorm).getByText("Giám đốc Công nghệ")).toBeTruthy();
		// Everyone sleeps: the director, the 13 staff and Advisor, Backend & DevOps included.
		expect(within(dorm).getAllByTitle(/· Đang ngủ$/)).toHaveLength(15);
		expect(document.querySelectorAll('[data-anchor^="bed-"]')).toHaveLength(15);
	});

	it("says when the AI does not report its staff, with the lobby and the QA room both in view", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ activity: act("t1", OfficeRoom.QA, "run_command") })], { reportsStaff: false }) });
		expect(await screen.findByText("AI này không báo cáo nhân viên: việc của công cụ do các phòng ban làm.")).toBeTruthy();
		expect(screen.getByRole("region", { name: "Sảnh" })).toBeTruthy();
		const control = screen.getByRole("region", { name: "Kiểm soát" });
		// The director's tool in the QA room is the QA tester's work.
		expect(within(within(control).getByRole("region", { name: "Phòng QA/ISO" })).getByText("Kiểm thử phần mềm")).toBeTruthy();
	});

	it("opens a phone on the work zone and a wide screen on the whole plan", () => {
		expect(openingFraming("phone")).toBe("work");
		expect(openingFraming("desktop")).toBe("overview");
	});

	it("toggles the framing with one button naming the other framing: a wide screen opens on the whole plan", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director()]) });
		const stage = await waitFor(() => {
			const el = document.querySelector<HTMLElement>('[data-renderer="2d"]');
			if (el === null) throw new Error("no 2D stage yet");
			return el;
		});
		// The test's window is a desktop one: it opens on the overview, the button offers the work zone.
		expect(stage.getAttribute("data-framing")).toBe("overview");
		expect(screen.queryByRole("button", { name: "Toàn cảnh" })).toBeNull();
		const back = screen.getByRole("button", { name: "Về khu làm việc" });
		expect(back.getAttribute("data-id")).toBe("office-framing");
		expect(back.getAttribute("title")).toBe("Quay về khung nhìn khu làm việc");
		await userEvent.click(back);
		expect(document.querySelector('[data-renderer="2d"]')?.getAttribute("data-framing")).toBe("work");
		const button = screen.getByRole("button", { name: "Toàn cảnh" });
		expect(button.getAttribute("title")).toBe("Thu ra xem nhiều khu hơn");
		await userEvent.click(button);
		expect(screen.getByRole("button", { name: "Về khu làm việc" })).toBeTruthy();
		expect(document.querySelector('[data-renderer="2d"]')?.getAttribute("data-framing")).toBe("overview");
		// The old follow choice is no longer read or written.
		expect(window.localStorage.getItem("ai:office:follow")).toBeNull();
	});

	it("puts each person at their anchor on the baked picture of the whole plan", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(FIXTURE_TEXT, { status: 200, headers: { "content-type": "application/json" } })));
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ state: OfficeActorState.IDLE }), staff("s1", "scout", { state: OfficeActorState.DONE })], { session: session({ busy: false }) }) });
		const picture = await waitFor(() => {
			const img = document.querySelector("img");
			if (img === null) throw new Error("no picture yet");
			return img;
		});
		expect(picture.getAttribute("src")).toMatch(/^\/office\/office-2d-plan-(day|night)-(desktop|phone)\.webp$/);
		const size: ScreenSize = picture.getAttribute("src")?.includes("phone") === true ? "phone" : "desktop";
		const desk = FIXTURE.views[size].anchors["desk-1"];
		const marker = document.querySelector<HTMLElement>('[data-id="office-person-title:techLead"]');
		expect(marker?.style.left).toBe(`${desk?.[0]}%`);
		expect(marker?.style.top).toBe(`${desk?.[1]}%`);
	});
});

describe("the 2D picture", () => {
	/** The 2D view of `size` and `framing` with the director and a scout at office hours. */
	function draw(size: ScreenSize, framing: OfficeFraming) {
		const layout = shippedLayout();
		const { store } = storeAt(OFFICE_HOURS);
		store.applySnapshot(snapshot([director({ state: OfficeActorState.IDLE }), staff("s1", "scout", { state: OfficeActorState.DONE })], { session: session({ busy: false }) }));
		const state = store.state();
		const { placements } = officePlacement(state, layout, OFFICE_HOURS, EMPTY_MEMORY, null);
		return wrap(<Office2D state={state} placements={placements} talks={[]} layout={layout} framing={framing} size={size} daypart={officeDaypart(OFFICE_HOURS)} assets={{ ok: true, value: FIXTURE_ASSETS }} now={OFFICE_HOURS} />);
	}

	it("places every person's dot at the asset's anchor percent, on the day picture of the screen size", () => {
		draw("phone", "work");
		expect(document.querySelector("img")?.getAttribute("src")).toBe(`/office/${FIXTURE.views.phone.day}`);
		const markers = [...document.querySelectorAll<HTMLElement>(".of-picture .of-marker")];
		expect(markers.length).toBeGreaterThanOrEqual(2);
		for (const m of markers) {
			const anchor = m.getAttribute("data-anchor") ?? "";
			const at = FIXTURE.views.phone.anchors[anchor];
			if (at === undefined) throw new Error(`no fixture point for ${anchor}`);
			expect(m.style.left).toBe(`${at[0]}%`);
			expect(m.style.top).toBe(`${at[1]}%`);
		}
	});

	it("zooms the picture onto the work zone in work on any screen, and fits the whole plan in the overview", () => {
		const layout = shippedLayout();
		const box = zoneBox(layout, "phone", WORK_ZONE);
		if (box === null) throw new Error("no work zone");
		// The work zone's box holds every anchor of its rooms on the baked phone picture.
		const zone = layout.zones.find((z) => z.id === WORK_ZONE);
		const inZone = layout.anchors.filter((a) => a.room !== null && zone?.rooms.includes(a.room) === true);
		expect(inZone.length).toBeGreaterThan(0);
		for (const a of inZone) {
			const at = FIXTURE.views.phone.anchors[a.id];
			if (at === undefined) throw new Error(`no fixture point for ${a.id}`);
			expect(at[0]).toBeGreaterThanOrEqual(box.left);
			expect(at[0]).toBeLessThanOrEqual(box.right);
			expect(at[1]).toBeGreaterThanOrEqual(box.top);
			expect(at[1]).toBeLessThanOrEqual(box.bottom);
		}
		const work = pictureFraming(layout, "phone", "work");
		expect(work.zoomX).toBeCloseTo(100 / (box.right - box.left), 6);
		expect(work.zoomY).toBeCloseTo(100 / (box.bottom - box.top), 6);
		expect(work.zoomX).toBeGreaterThan(1);
		expect(work.focus).toEqual([(box.left + box.right) / 2, (box.top + box.bottom) / 2]);
		expect(pictureFraming(layout, "phone", "overview")).toEqual({ zoomX: 1, zoomY: 1, focus: [50, 50] });
		expect(pictureFraming(layout, "desktop", "overview")).toEqual({ zoomX: 1, zoomY: 1, focus: [50, 50] });
		// A wide screen's work framing zooms its picture onto the same zone.
		const wide = zoneBox(layout, "desktop", WORK_ZONE);
		if (wide === null) throw new Error("no work zone on the desktop picture");
		const desktopWork = pictureFraming(layout, "desktop", "work");
		expect(desktopWork.zoomX).toBeCloseTo(100 / (wide.right - wide.left), 6);
		expect(desktopWork.zoomY).toBeCloseTo(100 / (wide.bottom - wide.top), 6);
		expect(desktopWork.zoomX).toBeGreaterThan(1);
		expect(desktopWork.focus).toEqual([(wide.left + wide.right) / 2, (wide.top + wide.bottom) / 2]);
		for (const a of inZone) {
			const at = FIXTURE.views.desktop.anchors[a.id];
			if (at === undefined) throw new Error(`no fixture point for ${a.id}`);
			expect(at[0]).toBeGreaterThanOrEqual(wide.left);
			expect(at[0]).toBeLessThanOrEqual(wide.right);
		}

		const { unmount } = draw("phone", "work");
		const picture = document.querySelector<HTMLElement>(".of-picture");
		expect(Number(picture?.style.getPropertyValue("--of-zoom-x"))).toBeCloseTo(work.zoomX, 6);
		expect(Number(picture?.style.getPropertyValue("--of-zoom-y"))).toBeCloseTo(work.zoomY, 6);
		expect(Number(picture?.style.getPropertyValue("--of-aspect"))).toBe(FIXTURE.views.phone.width / FIXTURE.views.phone.height);
		unmount();
		draw("phone", "overview");
		expect(document.querySelector<HTMLElement>(".of-picture")?.style.getPropertyValue("--of-zoom-x")).toBe("1");
	});

	it("centres the work zone again when the frame changes size (a phone turned)", () => {
		const observers: (() => void)[] = [];
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private readonly callback: () => void) {}
				observe(): void {
					observers.push(this.callback);
				}
				disconnect(): void {}
			},
		);
		const { focus } = pictureFraming(shippedLayout(), "phone", "work");
		draw("phone", "work");
		const frame = document.querySelector<HTMLElement>('[data-id="office-picture"]');
		const picture = document.querySelector<HTMLElement>(".of-picture");
		if (frame === null || picture === null) throw new Error("no picture");
		const sizeTo = (frameW: number, frameH: number, pictureW: number, pictureH: number): void => {
			Object.defineProperty(frame, "clientWidth", { configurable: true, value: frameW });
			Object.defineProperty(frame, "clientHeight", { configurable: true, value: frameH });
			Object.defineProperty(picture, "offsetWidth", { configurable: true, value: pictureW });
			Object.defineProperty(picture, "offsetHeight", { configurable: true, value: pictureH });
		};
		expect(observers).toHaveLength(1);
		// Turned to landscape: the frame is wider, the picture larger; the zone's point is centred again.
		sizeTo(800, 360, 2400, 1800);
		frame.scrollLeft = 0;
		frame.scrollTop = 0;
		observers.forEach((notify) => notify());
		expect(frame.scrollLeft).toBeCloseTo(Math.max(0, (focus[0] / 100) * 2400 - 400));
		expect(frame.scrollTop).toBeCloseTo(Math.max(0, (focus[1] / 100) * 1800 - 180));
		// A notice without a size change leaves the viewer's own scrolling alone.
		frame.scrollLeft = 7;
		observers.forEach((notify) => notify());
		expect(frame.scrollLeft).toBe(7);
	});
});

describe("the session's views", () => {
	it("offers the office from tunelo 3.6.0 and lists the views in order", () => {
		expect(officeOffered(info("3.5.1"))).toBe(false);
		expect(officeOffered(info("3.6.0"))).toBe(true);
		expect(officeOffered(null)).toBe(false);
		expect(sessionModes(true, true)).toEqual(["chat", "terminal", "office"]);
		expect(sessionModes(false, true)).toEqual(["chat", "office"]);
		expect(sessionModes(false, false)).toEqual(["chat"]);
		// A remembered office on a machine offline or back on an older tunelo: still a way back to chat.
		expect(sessionModes(false, false, "office")).toEqual(["chat", "office"]);
		expect(sessionModes(false, false, "terminal")).toEqual(["chat"]);
	});

	it("shows the switch only with two views: chat, terminal and office; chat and office; nothing for chat alone", () => {
		const { container, rerender } = wrap(<ModeSwitch machine="1" threadId="s1" mode="office" modes={["chat", "terminal", "office"]} />);
		const group = within(container).getByRole("group");
		expect(within(group).getAllByRole("button").map((b) => [b.getAttribute("data-id"), b.getAttribute("aria-pressed")])).toEqual([
			["session-mode-chat", "false"],
			["session-mode-terminal", "false"],
			["session-mode-office", "true"],
		]);
		rerender(
			<I18nProvider>
				<ModeSwitch machine="1" threadId="s1" mode="chat" modes={["chat", "office"]} />
			</I18nProvider>,
		);
		expect(within(container).getAllByRole("button").map((b) => b.textContent)).toEqual(["Trò chuyện", "Văn phòng"]);
		rerender(
			<I18nProvider>
				<ModeSwitch machine="1" threadId="s1" mode="chat" modes={["chat"]} />
			</I18nProvider>,
		);
		expect(container.innerHTML).toBe("");
	});

	/** Storage changed outside this page's own writes (another tab, a clear): the page hears it as a storage event. */
	const storageChanged = (key: string | null): void => {
		window.dispatchEvent(new StorageEvent("storage", { key }));
	};

	it("opens the next session in the view last picked on a switch, where that session offers it", () => {
		window.localStorage.clear();
		storageChanged(null);
		const other = { id: "s9", terminalSession: 0, open: false };
		expect(pickedMode()).toBeNull();
		expect(sessionPath("1", other, true)).toBe("/ai/1/s/s9");
		// Picked the office on one session: the next one opens there too, the same address format.
		openSessionIn("1", "abc", "office");
		expect(pickedMode()).toBe("office");
		expect(sessionPath("1", other, true, true)).toBe("/ai/1/s/s9/office");
		expect(sessionPath("2", other, false, true)).toBe("/ai/2/s/s9/office");
		// A machine without the office (an older tunelo): as before (chat, or the mode that session was left in).
		expect(sessionPath("2", other, false, false)).toBe("/ai/2/s/s9");
		rememberSessionMode("2", "s9", "terminal");
		expect(sessionPath("2", other, true, false)).toBe("/ai/2/s/s9/terminal");
		// The terminal picked: only where it is offered; a session held in a terminal stays there.
		openSessionIn("1", "abc", "terminal");
		expect(sessionPath("1", other, true)).toBe("/ai/1/s/s9/terminal");
		expect(sessionPath("1", { ...other, id: "s8" }, false)).toBe("/ai/1/s/s8");
		openSessionIn("1", "abc", "chat");
		expect(sessionPath("1", { ...other, terminalSession: 3 }, true)).toBe("/ai/1/s/s9/terminal");
		expect(sessionPath("1", other, true)).toBe("/ai/1/s/s9");
		// A value this app does not know: no pick.
		window.localStorage.setItem("ai:mode:picked", "garden");
		storageChanged("ai:mode:picked");
		expect(pickedMode()).toBeNull();
		window.localStorage.clear();
		storageChanged(null);
	});

	it("a row's icon says the session's own mode or hold, never the device's pick, and the pick does not erase it", () => {
		window.localStorage.clear();
		storageChanged(null);
		const row = { id: "s5", terminalSession: 0, open: false };
		rememberSessionMode("1", "s5", "terminal");
		openSessionIn("1", "other", "office");
		// The row still names where this session was last opened, and opening it from the list goes there, not to the pick.
		expect(rowMode("1", row)).toBe("terminal");
		expect(rowMode("1", { ...row, open: true })).toBe("chat");
		expect(sessionModeOf("1", "s5")).toBe("terminal");
		expect(sessionPath("1", row, true, true)).toBe("/ai/1/s/s5/terminal");
		expect(sessionPath("1", row, true, false)).toBe("/ai/1/s/s5/terminal");
		window.localStorage.clear();
		storageChanged(null);
	});

	it("a session left in chat opens in chat again, whatever view was picked on another session", () => {
		window.localStorage.clear();
		storageChanged(null);
		const left = { id: "old", terminalSession: 0, open: false };
		const fresh = { id: "never", terminalSession: 0, open: false };
		rememberSessionMode("1", "old", "chat");
		// The terminal picked on another session: the one left in chat stays in chat; one never opened here takes the pick.
		openSessionIn("1", "other", "terminal");
		expect(sessionPath("1", left, true, true)).toBe("/ai/1/s/old");
		expect(sessionPath("1", fresh, true, true)).toBe("/ai/1/s/never/terminal");
		// The office picked: the same.
		openSessionIn("1", "other", "office");
		expect(sessionPath("1", left, true, true)).toBe("/ai/1/s/old");
		expect(sessionPath("1", fresh, true, true)).toBe("/ai/1/s/never/office");
		// A session left in the office opens there with chat picked.
		rememberSessionMode("1", "old", "office");
		openSessionIn("1", "other", "chat");
		expect(sessionPath("1", left, true, true)).toBe("/ai/1/s/old/office");
		window.localStorage.clear();
		storageChanged(null);
	});

	it("reads the pick from storage once, and again only when another tab changes it", () => {
		window.localStorage.clear();
		storageChanged(null);
		const read = vi.spyOn(Storage.prototype, "getItem");
		try {
			for (let i = 0; i < 20; i++) pickedMode();
			expect(read.mock.calls.filter(([key]) => key === "ai:mode:picked")).toHaveLength(1);
			// Another tab picks the terminal.
			window.localStorage.setItem("ai:mode:picked", "terminal");
			expect(pickedMode()).toBeNull();
			storageChanged("ai:mode:picked");
			expect(pickedMode()).toBe("terminal");
			expect(read.mock.calls.filter(([key]) => key === "ai:mode:picked")).toHaveLength(2);
		} finally {
			read.mockRestore();
			window.localStorage.clear();
			storageChanged(null);
		}
	});

	it("routes /office, remembers it per session, and reads an unknown kept value as chat", () => {
		expect(matchRoute("/ai/1/s/abc/office")).toEqual({ name: "machines", view: { page: "session-office", machine: "1", threadId: "abc" } });
		expect(aiPaths.sessionOffice("1", "abc")).toBe("/ai/1/s/abc/office");
		expect(modePath("1", "abc", "office")).toBe("/ai/1/s/abc/office");
		rememberSessionMode("1", "abc", "office");
		expect(sessionModeOf("1", "abc")).toBe("office");
		const thread = { id: "abc", terminalSession: 0, open: false };
		expect(sessionPath("1", thread, false)).toBe("/ai/1/s/abc/office");
		window.localStorage.setItem("ai:mode:1:abc", "garden");
		expect(sessionModeOf("1", "abc")).toBe("chat");
	});
});

describe("a refused watch", () => {
	it("says the machine has too many offices open, and that the office could not open otherwise", () => {
		const limit = new RemoteError(ErrorCode.INVALID, "too many", ErrorReason.OFFICE_WATCH_LIMIT, "");
		expect(refusalText(viMachines, limit)).toBe(viMachines.errors.reasons.officeWatchLimit);
		expect(refusalText(viMachines, new Error("x"))).toBe(viMachines.office.failed);
	});

	it("offers to try again after the limit of offices, and the warning goes once the office opens", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		await fake.reject(new RemoteError(ErrorCode.INVALID, "too many", ErrorReason.OFFICE_WATCH_LIMIT, ""));
		expect(await screen.findByText(viMachines.errors.reasons.officeWatchLimit)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
		expect(fake.sent.filter((b) => b.case === "officeWatch")).toHaveLength(2);
		expect(screen.queryByText(viMachines.errors.reasons.officeWatchLimit)).toBeNull();
		await fake.reject(new RemoteError(ErrorCode.INVALID, "too many", ErrorReason.OFFICE_WATCH_LIMIT, ""));
		expect(await screen.findByText(viMachines.errors.reasons.officeWatchLimit)).toBeTruthy();
		fake.deliver({ case: "officeSnapshot", value: snapshot([director()]) });
		await waitFor(() => expect(screen.queryByText(viMachines.errors.reasons.officeWatchLimit)).toBeNull());
	});

	it("a session the machine does not have: only that it is not there, no empty office", async () => {
		const fake = fakeLink();
		const { container } = wrap(<OfficeView link={fake.link} threadId="gone" info={info("3.6.0")} online />);
		await fake.reject(new RemoteError(ErrorCode.NOT_FOUND, "no such thread", ErrorReason.THREAD_NOT_FOUND, ""));
		expect(await screen.findByText(viMachines.errors.reasons.threadNotFound)).toBeTruthy();
		expect(container.querySelector(".of-body")).toBeNull();
		expect(screen.queryByRole("button", { name: "Thử lại" })).toBeNull();
	});
});
