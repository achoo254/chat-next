// tunelo's services on a machine's page: each one's state and why it does not
// run, what it is for, and the requests its buttons send.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
	AgentPortKind,
	AgentServiceAction,
	AgentServiceProblem,
	AgentServiceState,
	FrameSchema,
	MachineInfoSchema,
	type Frame,
} from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AgentServicesPanel } from "../../src/machines/agent-services-panel.tsx";
import { serviceCounts, serviceRows } from "../../src/machines/agent-services-view.ts";

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

const RUNNING = AgentServiceState.RUNNING;
const STOP = AgentServiceAction.STOP;
const RESTART = AgentServiceAction.RESTART;

const machine = (failedObservatory = false, openSessions = 0) =>
	create(MachineInfoSchema, {
		openSessions,
		runtime: {
			pid: 10,
			startedAt: 1n,
			restartable: true,
			serviceControl: true,
			ports: [
				{ kind: AgentPortKind.DEVICE_LINK, port: 54501, listening: true, state: RUNNING },
				failedObservatory
					? { kind: AgentPortKind.OBSERVATORY, port: 0, state: AgentServiceState.FAILED, problem: AgentServiceProblem.NO_FREE_PORT, controls: [STOP, RESTART] }
					: { kind: AgentPortKind.OBSERVATORY, port: 47300, listening: true, state: RUNNING, controls: [STOP, RESTART] },
				{ kind: AgentPortKind.TUNNEL_HTTP, port: 3000, listening: true, state: RUNNING, tunnelId: "t1", urls: ["https://dev.example.test"], controls: [STOP] },
			],
		},
	});

const restarts: number[] = [];

function show(info: ReturnType<typeof machine>) {
	restarts.length = 0;
	const { link, sent } = fakeLink();
	render(
		<I18nProvider>
			<AgentServicesPanel link={link} info={info} machineName="Mac mini" online restarting={false} onRestartAsked={() => restarts.push(1)} />
		</I18nProvider>,
	);
	return sent;
}

const item = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`) ?? (null as never);

describe("serviceRows", () => {
	it("reads an older tunelo's ports from whether they listen, with no buttons", () => {
		const rows = serviceRows(
			create(MachineInfoSchema, {
				runtime: { ports: [{ kind: AgentPortKind.OBSERVATORY, port: 4318, listening: false, controls: [STOP] }] },
			}).runtime ?? (undefined as never),
		);
		expect(rows).toMatchObject([{ kind: "observatory", state: "portTaken", controls: [] }]);
		expect(serviceCounts(rows)).toEqual({ total: 1, running: 0, problems: 1 });
	});
});

describe("AgentServicesPanel", () => {
	it("shows each service's state, port and purpose, and a summary", () => {
		show(machine());
		expect(screen.getByText("3/3 đang chạy")).toBeTruthy();
		const link = item("agent-service-link-54501");
		expect(within(link).getByText("Kết nối thiết bị")).toBeTruthy();
		expect(within(link).getByText("Đang chạy")).toBeTruthy();
		expect(within(link).getByText(/điều khiển máy này qua tunnel/)).toBeTruthy();
		// The link only stops with tunelo: no button of its own, and the reason in its details.
		expect(within(link).queryByRole("button")).toBeNull();
		expect(within(link).getByText(/Chỉ dừng cùng tunelo/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "https://dev.example.test" })).toBeTruthy();
	});

	it("says why Observatory failed and how to fix it", () => {
		show(machine(true));
		expect(screen.getByText("2/3 đang chạy · 1 cần xem")).toBeTruthy();
		const obs = item("agent-service-observatory-0");
		expect(within(obs).getByText("Lỗi")).toBeTruthy();
		expect(within(obs).getByText("chưa có cổng")).toBeTruthy();
		expect(within(obs).getByText(/Hết cổng trống trong dải 47300–47399/)).toBeTruthy();
	});

	it("restarts Observatory, and closes a tunnel only after confirming", async () => {
		const sent = show(machine());
		await userEvent.click(within(item("agent-service-observatory-47300")).getByRole("button", { name: /Khởi động lại/ }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]).toMatchObject({ case: "agentServiceControl", value: { kind: AgentPortKind.OBSERVATORY, action: RESTART } });

		await userEvent.click(within(item("agent-service-tunnelHttp-3000")).getByRole("button", { name: "Đóng tunnel · Tunnel HTTP 3000" }));
		expect(sent).toHaveLength(1);
		expect(within(screen.getByRole("dialog")).getByText("Đóng tunnel của cổng 3000?")).toBeTruthy();
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Đóng tunnel" }));
		await waitFor(() => expect(sent).toHaveLength(2));
		expect(sent[1]).toMatchObject({ case: "agentServiceControl", value: { kind: AgentPortKind.TUNNEL_HTTP, action: STOP, tunnelId: "t1" } });
	});

	it("restarts tunelo after a confirmation that warns of open sessions", async () => {
		const sent = show(machine(false, 2));
		await userEvent.click(screen.getByRole("button", { name: "Khởi động lại tunelo" }));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText(/2 phiên mở/)).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: "Khởi động lại tunelo" }));
		await waitFor(() => expect(sent).toHaveLength(1));
		expect(sent[0]?.case).toBe("agentRestart");
		await waitFor(() => expect(restarts).toEqual([1]));
	});
});
