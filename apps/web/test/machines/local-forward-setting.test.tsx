// The switch for Localman's requests to localhost on a machine's page: it
// shows what the machine holds, sends MachineSettingsSet over the link, says
// when the tunnel server does not carry the requests yet, and shows a failure.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { FrameSchema, MachineSettingsSchema, type Frame } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { LocalForwardSetting } from "../../src/machines/local-forward-setting.tsx";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

function fakeLink(fail = false) {
	const sent: Frame["body"][] = [];
	const link = {
		request: (body: Body) => {
			const frame = create(FrameSchema, { body });
			sent.push(frame.body);
			return fail ? Promise.reject(new Error("offline")) : Promise.resolve(create(FrameSchema, { body: { case: "machineInfo", value: {} } }));
		},
	};
	return { link, sent };
}

const settings = (localForward: boolean, localForwardAvailable = true) => create(MachineSettingsSchema, { localForward, localForwardAvailable });

describe("forwarding to localhost on a machine's page", () => {
	it("shows the switch on and turns it off over the link", async () => {
		const { link, sent } = fakeLink();
		render(
			<I18nProvider>
				<LocalForwardSetting link={link} settings={settings(true)} online />
			</I18nProvider>,
		);
		const toggle = screen.getByRole("switch", { name: "Cho Localman gửi request tới localhost trên máy này" });
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(screen.queryByRole("note")).toBeNull();
		await userEvent.click(toggle);
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "machineSettingsSet", value: expect.objectContaining({ localForward: false }) })]));
	});

	it("off: says how Localman sees it; on but not carried yet: says so", () => {
		const { link } = fakeLink();
		const { rerender } = render(
			<I18nProvider>
				<LocalForwardSetting link={link} settings={settings(false)} online />
			</I18nProvider>,
		);
		expect(screen.getByText(/Đã tắt: Localman báo/)).toBeTruthy();
		rerender(
			<I18nProvider>
				<LocalForwardSetting link={link} settings={settings(true, false)} online />
			</I18nProvider>,
		);
		expect(screen.getByRole("note").textContent).toMatch(/Máy chủ tunnel chưa chuyển/);
	});

	it("shows a failure, and cannot be switched while the machine is offline", async () => {
		const { link } = fakeLink(true);
		const { rerender } = render(
			<I18nProvider>
				<LocalForwardSetting link={link} settings={settings(true)} online />
			</I18nProvider>,
		);
		await userEvent.click(screen.getByRole("switch"));
		expect((await screen.findByRole("alert")).textContent).toBe("Không đổi được cài đặt. Thử lại.");
		rerender(
			<I18nProvider>
				<LocalForwardSetting link={link} settings={settings(true)} online={false} />
			</I18nProvider>,
		);
		expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
	});
});
