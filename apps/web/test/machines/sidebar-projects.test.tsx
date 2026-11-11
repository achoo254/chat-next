// The AI Agent column, project-first: sessions show only inside projects
// (no "Khác"), no inbox row or filter tabs but one toggle for what needs the
// user or runs, "Thêm dự án" next to it, the machine's name on each project
// only with several machines, and an offline machine still listed in a line.
import { createConnectTransport } from "@connectrpc/connect-web";
import { type Frame } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import MachinesScreen from "../../src/machines/machines-screen.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import type { MachinesView } from "../../src/router.tsx";
import { FakeMachines } from "../support/fake-machines.ts";
import { routerFetch } from "../support/router-fetch.ts";
import { defaultAnswer, FakeMachine } from "./fake-machine.ts";

let machine: FakeMachine;
let device: KeyPair;

vi.mock("../../src/machines/link/device-keys.ts", () => ({
	deviceKeyStore: () => ({
		device: async () => device,
		pinned: async () => machine.keys.publicKey,
		pin: async () => undefined,
		forget: async () => undefined,
	}),
}));

const services = { toasts: { show: () => undefined } } as unknown as Services;
const NativeWebSocket = window.WebSocket;
const thread = (id: string, dir: string, state: number) => ({ id, title: id, dir, provider: "claude", state, updatedAt: 1n });

beforeEach(async () => {
	window.sessionStorage.clear();
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	machine.handler = (frame: Frame) => {
		switch (frame.body.case) {
			case "machineInfoRequest":
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.5.0", maxSessions: 3, providers: [{ id: "claude", name: "Claude Code" }] } }];
			case "threadList":
				// t1 waits for the user (state 3), t2 is idle, t3 sits in a folder that is no project.
				return [{ case: "threadListResult", value: { threads: [thread("t1", "/w/app", 3), thread("t2", "/w/app/src", 1), thread("t3", "/tmp/scratch", 1)], openSessions: 0, maxSessions: 3 } }];
			case "projectList":
				return [{ case: "projectListResult", value: { projects: [{ id: "p1", name: "app", dir: "/w/app" }, { id: "p2", name: "docs", dir: "/w/docs" }], suggestions: [{ dir: "/tmp/scratch", sessions: 1 }] } }];
			default:
				return defaultAnswer(frame);
		}
	};
	window.WebSocket = function (url: string) {
		return machine.factory(url);
	} as unknown as typeof WebSocket;
});

afterEach(() => {
	window.WebSocket = NativeWebSocket;
});

function column(hosts: { name: string; online: boolean }[], view: MachinesView = { page: "machines" }) {
	const machines = new FakeMachines();
	hosts.forEach((h, i) =>
		machines.add({ name: h.name, tunnelUrl: h.online ? `wss://m-${i + 1}.tunnel.hoandat.com` : "", lastSeenAt: h.online ? BigInt(Math.floor(Date.now() / 1000)) : 0n }),
	);
	const transport = createConnectTransport({ baseUrl: "http://localhost/rpc", useBinaryFormat: true, fetch: routerFetch((r) => machines.routes(r)) });
	render(
		<I18nProvider>
			<ServicesContext value={{ ...services, transport } as unknown as Services}>
				<MachineLinksProvider>
					<MachinesScreen view={view} />
				</MachineLinksProvider>
			</ServicesContext>
		</I18nProvider>,
	);
	return document.querySelector<HTMLElement>(".mx-list") ?? document.body;
}

describe("the project-first column", () => {
	it("shows sessions only inside projects, with a dot for what needs the user, and no inbox row or filter tabs", async () => {
		const list = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t1");
		expect(within(list).getByText("app")).toBeTruthy();
		expect(within(list).getByText("docs")).toBeTruthy();
		expect(within(list).getByText("t2")).toBeTruthy();
		// A folder that is no project: its session is reachable from "Thêm dự án", not listed.
		expect(within(list).queryByText("t3")).toBeNull();
		expect(within(list).queryByText("Khác")).toBeNull();
		expect(within(list).queryByRole("tab")).toBeNull();
		expect(list.querySelector(".mx-srow .mx-sdot.need")).toBeTruthy();
		// One machine: no machine names on projects.
		expect(list.querySelector(".mx-host")).toBeNull();
		expect(within(list).getByRole("button", { name: "Thêm dự án" })).toBeTruthy();
		expect(within(list).getByRole("link", { name: /Quản lý máy/ })).toBeTruthy();
	});

	it("one toggle keeps only what needs the user or runs", async () => {
		const list = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t2");
		const toggle = within(list).getByRole("button", { name: /Chỉ hiện cần bạn \/ đang chạy/ });
		await userEvent.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => expect(within(list).queryByText("t2")).toBeNull());
		expect(within(list).getByText("t1")).toBeTruthy();
		// A project with nothing for the user hides too.
		expect(within(list).queryByText("docs")).toBeNull();
	});

	it("several machines: each project names its machine, and a machine that is offline still shows in a line", async () => {
		const list = column([
			{ name: "Mac mini", online: true },
			{ name: "Old PC", online: false },
		]);
		await within(list).findByText("t1");
		expect([...list.querySelectorAll(".mx-host")].map((e) => e.textContent)).toContain("Mac mini");
		await waitFor(() => expect(within(list).getByText("Old PC")).toBeTruthy());
	});

	it("an old address of a session in no project still opens it, offering to add its folder", async () => {
		column([{ name: "Mac mini", online: true }], { page: "session", machine: "1", threadId: "t3" });
		const note = await screen.findByText("scratch chưa là dự án nên phiên này không hiện trong danh sách.");
		const strip = note.closest("[data-id=session-not-in-project]");
		expect(strip).toBeTruthy();
		await userEvent.click(within(strip as HTMLElement).getByRole("button", { name: "Thêm dự án" }));
		// The dialog starts in that folder.
		expect(await screen.findByRole("dialog")).toBeTruthy();
	});
});
