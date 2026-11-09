// The banner of a Mac whose tunelo lacks Full Disk Access: shown only when the
// machine says so, with the steps, and "Check again" asks the machine anew.
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

	it("shows the steps and asks the machine again", async () => {
		const { link, sent } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { os: "darwin", needsFullDiskAccess: true })} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("alert").textContent).toContain(viMachines.diskAccess.title);
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		await userEvent.click(screen.getByRole("button", { name: viMachines.diskAccess.recheck }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "machineInfoRequest" })]));
	});

	it("cannot ask again while the machine is offline", () => {
		const { link } = fakeLink();
		render(
			<I18nProvider>
				<DiskAccessBanner link={link} info={create(MachineInfoSchema, { needsFullDiskAccess: true })} online={false} />
			</I18nProvider>,
		);
		expect((screen.getByRole("button", { name: viMachines.diskAccess.recheck }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("has the same steps in every language", () => {
		for (const copy of [viMachines, enMachines, zhCNMachines]) {
			expect(copy.diskAccess.steps).toHaveLength(3);
			expect(copy.diskAccess.steps.join(" ")).toContain("~/.local/bin/tunelo");
			expect(copy.diskAccess.steps.join(" ")).toContain("tunelo start");
		}
	});
});
