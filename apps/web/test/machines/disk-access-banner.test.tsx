// The banner of a Mac whose tunelo lacks Full Disk Access: shown only when the
// machine says so, with the steps and a drawing, opens the settings on the
// machine again, and says so once it is granted. On a page the steps are
// open the first time and folded after; in a session it is one line whose
// steps open on "Hướng dẫn".
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FrameSchema, MachineInfoSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { enMachines } from "../../src/machines/copy-en.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { zhCNMachines } from "../../src/machines/copy-zh-CN.ts";
import { DiskAccessBanner } from "../../src/machines/disk-access-banner.tsx";

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
	it("stays hidden when the machine has it, or says nothing (other systems, older tunelo)", () => {
		const { link } = fakeLink();
		const { container, rerender } = render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={null} online />
			</I18nProvider>,
		);
		expect(container.textContent).toBe("");
		rerender(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { os: "darwin" })} online />
			</I18nProvider>,
		);
		expect(container.textContent).toBe("");
	});

	it("shows the two steps with a drawing, and opens the settings on the machine again", async () => {
		const { link, sent } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true })} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("alert").textContent).toContain(viMachines.diskAccess.title);
		expect(screen.getAllByRole("listitem")).toHaveLength(2);
		expect(screen.getByRole("img", { name: viMachines.diskAccess.figure })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: viMachines.diskAccess.reopen }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "openDiskAccessSettings" })]));
		expect(await screen.findByText(viMachines.diskAccess.reopened)).toBeTruthy();
	});

	it("says it is granted once the machine reports it", () => {
		const { link } = fakeLink();
		const { rerender } = render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: true })} online />
			</I18nProvider>,
		);
		rerender(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: false })} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("status").textContent).toBe(viMachines.diskAccess.granted);
	});

	it("cannot open the settings while the machine is offline", () => {
		const { link } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: true })} online={false} />
			</I18nProvider>,
		);
		expect((screen.getByRole("button", { name: viMachines.diskAccess.reopen }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("on a page: the steps open the first time only; the button and its result stay on one row", async () => {
		window.localStorage.removeItem("ai:disk-access-guide-seen");
		const { link } = fakeLink();
		const info = create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true });
		const first = render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={info} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Hướng dẫn" }).getAttribute("aria-expanded")).toBe("true");
		expect(screen.getByRole("img", { name: viMachines.diskAccess.figure })).toBeTruthy();
		first.unmount();
		render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={info} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("button", { name: "Hướng dẫn" }).getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("img", { name: viMachines.diskAccess.figure })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: viMachines.diskAccess.reopen }));
		const result = await screen.findByText(viMachines.diskAccess.reopened);
		expect(result.parentElement?.className).toBe("mx-disk-actions");
	});

	it("in a session: one line, the steps and the button only after Hướng dẫn", async () => {
		const { link } = fakeLink();
		const { container } = render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true })} online bar />
			</I18nProvider>,
		);
		expect(container.querySelector(".mx-disk-bar")).toBeTruthy();
		expect(screen.queryByText(viMachines.diskAccess.body)).toBeNull();
		expect(screen.queryByRole("button", { name: viMachines.diskAccess.reopen })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Hướng dẫn" }));
		expect(screen.getByText(viMachines.diskAccess.body)).toBeTruthy();
		expect(screen.getByRole("button", { name: viMachines.diskAccess.reopen })).toBeTruthy();
	});

	it("has the same steps in every language", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			expect(copy.diskAccess.steps).toHaveLength(2);
			expect(copy.diskAccess.steps.join(" ")).toContain("tunelo");
		}
	});
});
