// The banner of a Mac whose tunelo lacks Full Disk Access: shown only when the
// machine says so; why it is asked for, what happens without it and that only
// those folders need it, always; the steps pick tunelo by the path the machine
// reports (a hidden folder, never in Applications); it opens the settings on
// the machine again; "granted" is one green line that hides itself and stays
// hidden per machine. On a page the steps are open the first time and folded
// after; in a session it is one line whose details open on "Hướng dẫn".
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FrameSchema, MachineInfoSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { DiskAccessBanner, GRANTED_SHOWN_MS } from "../../src/machines/disk-access-banner.tsx";
import { binaryPlace } from "../../src/machines/disk-access-guide.tsx";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

function fakeLink() {
	const sent: Frame["body"][] = [];
	const link = {
		request: (body: Body) => {
			sent.push(create(FrameSchema, { body }).body);
			return Promise.resolve(create(FrameSchema, { body: { case: "machineInfo", value: {} } }));
		},
	};
	return { link, sent };
}

describe("Full Disk Access banner", () => {
	beforeEach(() => window.localStorage.clear());

	it("stays hidden when the machine has it, or says nothing (other systems, older tunelo)", () => {
		const { link } = fakeLink();
		const { container, rerender } = render(
			<I18nProvider>
				<DiskAccessBanner machine="1" link={link} info={null} online />
			</I18nProvider>,
		);
		expect(container.textContent).toBe("");
		rerender(
			<I18nProvider>
				<DiskAccessBanner machine="1" link={link} info={create(MachineInfoSchema, { os: "darwin" })} online />
			</I18nProvider>,
		);
		expect(container.textContent).toBe("");
	});

	it("says why, what happens without it and that it is optional, always; the steps pick tunelo by its real path", async () => {
		const { link, sent } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner
					machine="1"
					link={link}
					info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true, home: "/Users/an", agentBinary: "/Users/an/.local/bin/tunelo" })}
					online
				/>
			</I18nProvider>,
		);
		const alert = screen.getByRole("alert");
		for (const line of [viMachines.diskAccess.title, viMachines.diskAccess.why, viMachines.diskAccess.without, viMachines.diskAccess.optional]) expect(alert.textContent).toContain(line);
		// First time on this device: the steps are open.
		const steps = within(alert).getAllByRole("listitem").map((li) => li.textContent);
		expect(steps).toEqual(expect.arrayContaining(viMachines.diskAccess.steps("~/.local/bin/", "tunelo")));
		expect(steps.join(" ")).toContain("Cmd+Shift+G");
		expect(alert.textContent).toContain(viMachines.diskAccess.dragNote);
		await userEvent.click(screen.getByRole("button", { name: viMachines.diskAccess.reopen }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "openDiskAccessSettings" })]));
		const result = await screen.findByText(viMachines.diskAccess.reopened);
		expect(result.parentElement?.className).toBe("mx-disk-actions");
	});

	it("knows where tunelo is: the machine's path, else the installer's folder", () => {
		expect(binaryPlace("/Users/an/.local/bin/tunelo", "/Users/an")).toEqual({ folder: "~/.local/bin/", name: "tunelo" });
		expect(binaryPlace("/opt/tools/tunelo-beta", "/Users/an")).toEqual({ folder: "/opt/tools/", name: "tunelo-beta" });
		expect(binaryPlace("", "/Users/an")).toEqual({ folder: "~/.local/bin/", name: "tunelo" });
	});

	it("granted: one green line with one check, hidden after a few seconds or on Ẩn, and stays hidden for that machine", () => {
		vi.useFakeTimers();
		try {
			const { link } = fakeLink();
			const at = (needed: boolean) => (
				<I18nProvider>
					<DiskAccessBanner machine="1" link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: needed })} online />
				</I18nProvider>
			);
			const view = render(at(true));
			view.rerender(at(false));
			const status = screen.getByRole("status");
			expect(status.className).toContain("mx-disk-ok");
			expect(status.textContent).toBe(viMachines.diskAccess.granted + viMachines.diskAccess.dismiss);
			expect(status.textContent).not.toContain("✓");
			expect(status.querySelectorAll("svg")).toHaveLength(1);
			act(() => vi.advanceTimersByTime(GRANTED_SHOWN_MS + 10));
			expect(screen.queryByRole("status")).toBeNull();
			expect(window.localStorage.getItem("ai:disk-access-granted-seen:1")).toBe("1");
			view.unmount();
			// Another page of the same machine: nothing more to say.
			const again = render(at(true));
			again.rerender(at(false));
			expect(screen.getByRole("status")).toBeTruthy();
			act(() => screen.getByRole("button", { name: viMachines.diskAccess.dismiss }).click());
			expect(screen.queryByRole("status")).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("cannot open the settings while the machine is offline", () => {
		const { link } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner machine="1" link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: true })} online={false} />
			</I18nProvider>,
		);
		expect((screen.getByRole("button", { name: viMachines.diskAccess.reopen }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("on a page: the steps are folded after the first time, the reason stays", () => {
		window.localStorage.setItem("ai:disk-access-guide-seen", "1");
		const { link } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner machine="1" link={link} info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true })} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Hướng dẫn" }).getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText(viMachines.diskAccess.dragNote)).toBeNull();
		expect(screen.getByText(viMachines.diskAccess.without)).toBeTruthy();
	});

	it("in a session: one line, the reason, steps and button after Hướng dẫn", async () => {
		const { link } = fakeLink();
		const { container } = render(
			<I18nProvider>
				<DiskAccessBanner machine="1" link={link} info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true })} online bar />
			</I18nProvider>,
		);
		expect(container.querySelector(".mx-disk-bar")).toBeTruthy();
		expect(screen.queryByText(viMachines.diskAccess.why)).toBeNull();
		expect(screen.queryByRole("button", { name: viMachines.diskAccess.reopen })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Hướng dẫn" }));
		expect(screen.getByText(viMachines.diskAccess.why)).toBeTruthy();
		expect(screen.getByRole("button", { name: viMachines.diskAccess.reopen })).toBeTruthy();
	});

	it("has the same four steps, the reason and the consequence in every language", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			const steps = copy.diskAccess.steps("~/.local/bin/", "tunelo");
			expect(steps).toHaveLength(4);
			expect(steps[2]).toContain("Cmd+Shift+G");
			expect(steps[2]).toContain("~/.local/bin/");
			for (const key of ["why", "without", "optional", "dragNote", "dismiss"] as const) expect(copy.diskAccess[key]).not.toBe("");
			expect(copy.diskAccess.granted).not.toContain("✓");
		}
	});
});
