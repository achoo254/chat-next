// Opening a person's panel in the office tab: a press on a name opens it beside
// the scene (a column; a sheet on a phone), the same name again, Esc or its
// close button closes it and puts the focus back on the name, a press on
// nothing closes it, the chairman is nobody to open, a machine that left says
// so for a while and then the panel goes, and another session starts with no
// panel. The holder of the panel's content is pure (holdInspected).
import { create } from "@bufbuild/protobuf";
import { MachineInfoSchema, OfficeActorState, OfficeEventsSchema, OfficeRoom, type Frame } from "@achoo254/chat-proto/remote/remote";
import { act as reactAct, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import type { LinkState, MachineLink } from "../../src/machines/link/machine-link.ts";
import { OFFICE_LAYOUT } from "../../src/machines/office/office-layout.ts";
import { holdInspected, LEFT_SHOWN_MS } from "../../src/machines/office/office-inspector.ts";
import { EMPTY_MEMORY, officePlacement } from "../../src/machines/office/office-placement.ts";
import OfficeView from "../../src/machines/office/office-view.tsx";
import { act, director, ev, machine, session, snapshot, staff, storeAt, T0 } from "./office-builders.ts";

const OFFICE_HOURS = new Date(2026, 10, 16, 10, 0).getTime();
const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);
const info = create(MachineInfoSchema, { agentVersion: "3.6.0" });

/** A link that lets the test play the machine's frames. */
function fakeLink() {
	const frames = new Set<(body: Frame["body"]) => void>();
	const link = {
		request: () => new Promise<Frame>(() => undefined),
		onFrame: (listener: (body: Frame["body"]) => void) => {
			frames.add(listener);
			return () => frames.delete(listener);
		},
		subscribe: () => () => undefined,
		snapshot: () => ({ status: { kind: "open" } }) as LinkState,
	};
	return { link: link as unknown as MachineLink, deliver: (body: Frame["body"]) => reactAct(() => frames.forEach((listener) => listener(body))) };
}

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

const nameButton = (name: string) => screen.getByRole("button", { name: `Xem thông tin ${name}` });
const panel = () => screen.queryByRole("complementary", { name: "Thông tin nhân vật" });

async function openOffice(actors: Parameters<typeof snapshot>[0], options: Parameters<typeof snapshot>[1] = {}) {
	const fake = fakeLink();
	const view = wrap(<OfficeView link={fake.link} threadId="t1" info={info} online />);
	fake.deliver({ case: "officeSnapshot", value: snapshot(actors, options) });
	await screen.findByRole("region", { name: "Điều hành" });
	return { fake, view };
}

describe("the inspector panel in the office tab", () => {
	it("opens beside the scene for a person whose name is pressed, shows who they are and what they do, and the same name closes it", async () => {
		const user = userEvent.setup();
		await openOffice([director(), staff("s1", "tester", { activity: act("q1", OfficeRoom.QA, "Bash", OFFICE_HOURS) })]);
		expect(panel()).toBeNull();
		const button = nameButton("Kiểm thử phần mềm");
		expect(button.getAttribute("aria-pressed")).toBe("false");
		await user.click(button);
		const opened = await screen.findByRole("complementary", { name: "Thông tin nhân vật" });
		expect(within(opened).getByRole("heading", { name: "Kiểm thử phần mềm" })).toBeTruthy();
		expect(within(opened).getByText("Việc đang làm")).toBeTruthy();
		expect(opened.textContent).toContain("Bash");
		expect(nameButton("Kiểm thử phần mềm").getAttribute("aria-pressed")).toBe("true");
		// The scene and the panel are beside each other in one body.
		expect(document.querySelector('[data-id="office"] .of-body')?.getAttribute("data-panel")).toBe("open");
		await user.click(nameButton("Kiểm thử phần mềm"));
		expect(panel()).toBeNull();
	});

	it("closes on Esc and puts the focus back on the name", async () => {
		const user = userEvent.setup();
		await openOffice([director()]);
		await user.click(nameButton("Giám đốc điều hành"));
		await screen.findByRole("complementary", { name: "Thông tin nhân vật" });
		await user.keyboard("{Escape}");
		expect(panel()).toBeNull();
		expect(document.activeElement).toBe(nameButton("Giám đốc điều hành"));
	});

	it("closes with its own button", async () => {
		const user = userEvent.setup();
		await openOffice([director()]);
		await user.click(nameButton("Giám đốc điều hành"));
		await user.click(await screen.findByRole("button", { name: "Đóng" }));
		expect(panel()).toBeNull();
	});

	it("switches to another person when another name is pressed, and says an off-duty person's life is simulated", async () => {
		const user = userEvent.setup();
		vi.setSystemTime(new Date(2026, 10, 16, 23, 30).getTime());
		await openOffice([director({ state: OfficeActorState.IDLE }), staff("s1", "tester", { state: OfficeActorState.DONE })], { session: session({ busy: false }) });
		await user.click(nameButton("Giám đốc điều hành"));
		expect(within(await screen.findByRole("complementary")).getByRole("heading", { name: "Giám đốc điều hành" })).toBeTruthy();
		await user.click(nameButton("Kiểm thử phần mềm"));
		const second = await screen.findByRole("heading", { name: "Kiểm thử phần mềm" });
		expect(second).toBeTruthy();
		expect(screen.getByRole("complementary").textContent).toContain("mô phỏng");
	});

	it("is not offered for the chairman, who is the viewer", async () => {
		await openOffice([director()], { session: session({ waitingForUser: true }) });
		const chairman = document.querySelector('[data-id="office-person-chairman"]');
		expect(chairman).not.toBeNull();
		expect(chairman?.querySelector("button")).toBeNull();
	});

	it("shows a machine that has left as gone for a while and then closes", async () => {
		const user = userEvent.setup();
		const { fake } = await openOffice([director(), machine("m1")]);
		await user.click(nameButton("Máy Bash"));
		await screen.findByRole("complementary", { name: "Thông tin nhân vật" });
		await fake.deliver({ case: "officeEvents", value: create(OfficeEventsSchema, { threadId: "t1", epoch: 1n, events: [ev(1, { case: "actorLeave", value: { actorId: "m1" } })] }) });
		expect((await screen.findByRole("complementary", { name: "Thông tin nhân vật" })).textContent).toContain("Đã rời văn phòng");
		vi.setSystemTime(OFFICE_HOURS + LEFT_SHOWN_MS + 2_000);
		await waitFor(() => expect(panel()).toBeNull(), { timeout: 4_000 });
	});

	it("starts another session with no panel", async () => {
		const user = userEvent.setup();
		const fake = fakeLink();
		const { rerender } = wrap(<OfficeView link={fake.link} threadId="t1" info={info} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director()]) });
		await screen.findByRole("region", { name: "Điều hành" });
		await user.click(nameButton("Giám đốc điều hành"));
		await screen.findByRole("complementary", { name: "Thông tin nhân vật" });
		rerender(
			<I18nProvider>
				<OfficeView link={fake.link} threadId="t2" info={info} online />
			</I18nProvider>,
		);
		expect(panel()).toBeNull();
	});
});

describe("what the panel holds for the person chosen", () => {
	function placed() {
		if (!OFFICE_LAYOUT.ok) throw new Error(OFFICE_LAYOUT.errors.join("\n"));
		const { store } = storeAt();
		store.applySnapshot(snapshot([director(), machine("m1")]));
		const placements = officePlacement(store.state(), OFFICE_LAYOUT.value, T0, EMPTY_MEMORY).placements;
		return { store, placements };
	}

	it("shows a person who is here as they are and closes nothing", () => {
		const { store, placements } = placed();
		const result = holdInspected(null, "director", placements, store.state(), T0);
		expect(result.close).toBe(false);
		expect(result.shown).toMatchObject({ key: "director", leftAt: null });
	});

	it("keeps the record last seen of someone who has gone, with when they left, and closes after a while", () => {
		const { store, placements } = placed();
		const here = holdInspected(null, "machine:m1", placements, store.state(), T0).shown;
		const without = placements.filter((p) => p.key !== "machine:m1");
		const gone = holdInspected(here, "machine:m1", without, store.state(), T0 + 1_000);
		expect(gone.close).toBe(false);
		expect(gone.shown).toMatchObject({ key: "machine:m1", leftAt: T0 + 1_000 });
		const later = holdInspected(gone.shown, "machine:m1", without, store.state(), T0 + 1_000 + LEFT_SHOWN_MS);
		expect(later.close).toBe(true);
	});

	it("closes at once for a key that was never shown, and shows nothing when none is chosen", () => {
		const { store, placements } = placed();
		expect(holdInspected(null, "title:nobody", placements, store.state(), T0)).toEqual({ shown: null, close: true });
		expect(holdInspected(null, null, placements, store.state(), T0)).toEqual({ shown: null, close: false });
	});
});
