// The tunelo update on a machine's page: what each state says, and the
// requests the buttons send.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
	AgentUpdateInfoSchema,
	AgentUpdatePhase,
	AgentUpdateProgressSchema,
	FrameSchema,
	MachineInfoSchema,
	type AgentUpdateProgress,
	type Frame,
} from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AgentUpdateSetting } from "../../src/machines/agent-update-setting.tsx";
import { updateView } from "../../src/machines/agent-update-view.ts";

type Body = NonNullable<MessageInitShape<typeof FrameSchema>["body"]>;

function fakeLink() {
	const sent: Frame["body"][] = [];
	return {
		sent,
		link: {
			request: (body: Body) => {
				sent.push(create(FrameSchema, { body }).body);
				return Promise.resolve(create(FrameSchema, { body: { case: "ack", value: {} } }));
			},
		},
	};
}

const info = (agentUpdate: MessageInitShape<typeof AgentUpdateInfoSchema> | undefined, openSessions = 0) =>
	create(MachineInfoSchema, { agentVersion: "2.2.3", openSessions, ...(agentUpdate === undefined ? {} : { agentUpdate }) });
const progress = (p: MessageInitShape<typeof AgentUpdateProgressSchema>) => create(AgentUpdateProgressSchema, p);

function show(machine: ReturnType<typeof info>, update: AgentUpdateProgress | null = null, online = true) {
	const { link, sent } = fakeLink();
	render(
		<I18nProvider>
			<AgentUpdateSetting link={link} info={machine} progress={update} online={online} />
		</I18nProvider>,
	);
	return sent;
}

describe("what the page says about updating tunelo", () => {
	it("tells a machine from before 2.3.0 to update at the machine", () => {
		expect(updateView(info(undefined), null).kind).toBe("manual");
		show(info(undefined));
		expect(screen.getByText(/chạy `tunelo update` trên máy/i)).toBeTruthy();
	});

	it("shows a newer version and updates with one click when no session is open", async () => {
		const sent = show(info({ supported: true, latestVersion: "2.3.0" }));
		expect(screen.getByText("Có bản mới 2.3.0")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Cập nhật" }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "agentUpdateStart" })]));
	});

	it("asks first when sessions are open", async () => {
		const sent = show(info({ supported: true, latestVersion: "2.3.0" }, 2));
		await userEvent.click(screen.getByRole("button", { name: "Cập nhật" }));
		expect(sent).toEqual([]);
		expect(screen.getByText(/Máy đang có 2 phiên mở/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Vẫn cập nhật" }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "agentUpdateStart" })]));
	});

	it("checks for a newer version on request when up to date", async () => {
		const sent = show(info({ supported: true, latestVersion: "" }));
		expect(screen.getByText("Đã là bản mới nhất.")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Kiểm tra bản mới" }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "agentUpdateCheck" })]));
	});

	it("explains a machine that cannot replace its own file", () => {
		expect(updateView(info({ supported: false, latestVersion: "2.3.0" }), null).kind).toBe("unsupported");
		show(info({ supported: false, latestVersion: "2.3.0" }));
		expect(screen.queryByRole("button", { name: "Cập nhật" })).toBeNull();
	});

	it("shows the download percentage", () => {
		show(
			info({ supported: true, latestVersion: "2.3.0", updating: true }),
			progress({ phase: AgentUpdatePhase.DOWNLOADING, version: "2.3.0", received: 25n, total: 100n }),
		);
		expect(screen.getByText("Đang tải 25%")).toBeTruthy();
		expect(screen.getByRole("progressbar").getAttribute("value")).toBe("25");
		expect(screen.queryByRole("button", { name: "Cập nhật" })).toBeNull();
	});

	it("shows the restart until the machine is back on the new version", () => {
		const restarting = progress({ phase: AgentUpdatePhase.RESTARTING, version: "2.3.0" });
		expect(updateView(info({ supported: true }), restarting).kind).toBe("restarting");
		const back = create(MachineInfoSchema, { agentVersion: "2.3.0", agentUpdate: { supported: true } });
		expect(updateView(back, restarting).kind).toBe("upToDate");
	});

	it("shows why an update failed and offers to try again", async () => {
		const sent = show(
			info({ supported: true, latestVersion: "2.3.0" }),
			progress({ phase: AgentUpdatePhase.FAILED, version: "2.3.0", message: "signature check failed" }),
		);
		expect(screen.getByRole("alert").textContent).toContain("signature check failed");
		await userEvent.click(screen.getByRole("button", { name: "Thử cập nhật lại" }));
		await waitFor(() => expect(sent).toEqual([expect.objectContaining({ case: "agentUpdateStart" })]));
	});

	it("shows the percentage as unknown when the size is not known", () => {
		expect(updateView(info({ supported: true, updating: true }), progress({ phase: AgentUpdatePhase.DOWNLOADING, received: 5n, total: 0n }))).toMatchObject({ kind: "working", percent: null });
	});
});
