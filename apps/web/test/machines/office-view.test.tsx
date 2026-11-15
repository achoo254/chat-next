// The office tab: the note for an older tunelo (and no frame to it), the
// rooms of a floor with their people and boards on a plain background, the
// floor tabs, the line for an AI that does not report its staff, the baked
// picture with each person at their anchor, and the session header's view
// switch (shown only with two views or more) with the office's route.
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
import OfficeView, { refusalText } from "../../src/machines/office/office-view.tsx";
import { ModeSwitch, modePath, officeOffered, rememberSessionMode, sessionModeOf, sessionModes, sessionPath } from "../../src/machines/session-mode.tsx";
import { matchRoute } from "../../src/router.tsx";
import { act, director, session, snapshot, staff } from "./office-builders.ts";

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

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});

afterEach(() => {
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

	it("shows the floor's rooms with their people, the meeting room's +N and the boards", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		expect(fake.sent).toEqual([{ case: "officeWatch", value: { threadId: "t1", on: true } }]);
		const types = ["scout", "tester", "planner", "debugger", "docs-manager", "general-purpose", "a", "b", "c"];
		const staffList = types.map((t, i) => staff(`s${i}`, t, { state: OfficeActorState.DONE }));
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ activity: act("t1", OfficeRoom.POST, "Bash") }), ...staffList], { session: session({ tasksDone: 7 }) }) });
		// The director works in the post room, on floor 2: following goes there.
		const post = await screen.findByRole("region", { name: "Bưu phòng" });
		expect(within(post).getByText("Giám đốc")).toBeTruthy();
		expect(screen.getByRole("button", { name: "T2, có người đang làm" }).getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(screen.getByRole("button", { name: "T1" }));
		const work = screen.getByRole("region", { name: "Phòng làm việc chung" });
		expect(within(work).getByText("Tí Trinh Sát")).toBeTruthy();
		const meeting = screen.getByRole("region", { name: "Phòng họp" });
		expect(within(meeting).getByLabelText("1 người chờ bàn trong phòng họp").textContent).toBe("+1");
		const lobby = screen.getByRole("region", { name: "Sảnh" });
		expect(within(lobby).getByRole("region", { name: "Bảng tin" }).textContent).toContain("7");
	});

	it("goes to the floor the user picks, and says when the AI does not report its staff", async () => {
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ activity: act("t1", OfficeRoom.QA, "run_command") })], { reportsStaff: false }) });
		expect(await screen.findByText("AI này chưa báo cáo nhân viên: chỉ có Giám đốc.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "T1" }));
		expect(screen.getByRole("region", { name: "Sảnh" })).toBeTruthy();
		const audit = screen.queryByRole("region", { name: "Phòng Kiểm toán" });
		expect(audit).toBeNull();
	});

	it("puts each person at their anchor on the baked picture", async () => {
		const fixture = readFileSync(resolve(process.cwd(), "test/machines/fixtures/office-assets.json"), "utf8");
		vi.stubGlobal("fetch", vi.fn(async () => new Response(fixture, { status: 200, headers: { "content-type": "application/json" } })));
		const fake = fakeLink();
		wrap(<OfficeView link={fake.link} threadId="t1" info={info("3.6.0")} online />);
		fake.deliver({ case: "officeSnapshot", value: snapshot([director({ state: OfficeActorState.IDLE }), staff("s1", "scout", { state: OfficeActorState.DONE })], { session: session({ busy: false }) }) });
		const picture = await waitFor(() => {
			const img = document.querySelector("img");
			if (img === null) throw new Error("no picture yet");
			return img;
		});
		expect(picture.getAttribute("src")).toMatch(/^\/office\/office-2d-floor-1-(day|night)-(desktop|phone)\.webp$/);
		const parsed = JSON.parse(fixture) as { floors: { views: Record<string, { anchors: Record<string, [number, number]> }> }[] };
		const size = picture.getAttribute("src")?.includes("phone") === true ? "phone" : "desktop";
		const desk = parsed.floors[0]?.views[size]?.anchors["desk-0"];
		const marker = document.querySelector<HTMLElement>('[data-id="office-person-scout#1"]');
		expect(marker?.style.left).toBe(`${desk?.[0]}%`);
		expect(marker?.style.top).toBe(`${desk?.[1]}%`);
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
});
