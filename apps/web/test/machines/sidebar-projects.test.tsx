// The AI Agent column, project-first: sessions show inside projects, and a
// folder with sessions that was never added shows as one too (offering
// "Thêm làm dự án"), so a user who had sessions before projects loses
// nothing; no inbox row or filter tabs but one switch for what needs the user
// or runs, with "Thêm dự án" on the same row; one empty state for the whole
// list; the machine's name on each project only with several machines; a
// machine with nothing to list stays under "Quản lý máy".
import { createConnectTransport } from "@connectrpc/connect-web";
import { type Frame } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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
type Row = ReturnType<typeof thread>;
let threads: Row[];
let projects: { id: string; name: string; dir: string }[];

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
	// t1 waits for the user (state 3), t2 is idle, t3 sits in a folder that is no project.
	threads = [thread("t1", "/w/app", 3), thread("t2", "/w/app/src", 1), thread("t3", "/tmp/scratch", 1)];
	projects = [
		{ id: "p1", name: "app", dir: "/w/app" },
		{ id: "p2", name: "docs", dir: "/w/docs" },
	];
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	machine.handler = (frame: Frame) => {
		switch (frame.body.case) {
			case "machineInfoRequest":
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.5.0", maxSessions: 3, providers: [{ id: "claude", name: "Claude Code" }] } }];
			case "threadList":
				return [{ case: "threadListResult", value: { threads, openSessions: 0, maxSessions: 3 } }];
			case "projectList":
				return [{ case: "projectListResult", value: { projects, suggestions: [] } }];
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
	it("a machine with added projects: sessions inside them; a folder with sessions and no project shows as one too", async () => {
		const list = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t1");
		expect(within(list).getByText("app")).toBeTruthy();
		expect(within(list).getByText("docs")).toBeTruthy();
		expect(within(list).getByText("t2")).toBeTruthy();
		expect(within(list).getByText("scratch")).toBeTruthy();
		expect(within(list).getByText("t3")).toBeTruthy();
		expect(within(list).getByText("Chưa là dự án")).toBeTruthy();
		expect(within(list).queryByText("Khác")).toBeNull();
		expect(within(list).queryByText("Chưa có dự án")).toBeNull();
		expect(within(list).queryByRole("tab")).toBeNull();
		expect(list.querySelector(".mx-srow .mx-sdot.need")).toBeTruthy();
		// One machine: no machine names on projects.
		expect(list.querySelector(".mx-host")).toBeNull();
		// One row: the switch, then "+" for a project.
		const row = list.querySelector(".mx-nav-top");
		expect(within(row as HTMLElement).getByRole("switch", { name: /Chỉ hiện cần bạn \/ đang chạy/ })).toBeTruthy();
		const add = within(row as HTMLElement).getByRole("button", { name: "Thêm dự án" });
		expect(add.getAttribute("title")).toBe("Thêm dự án");
		expect(within(list).getByRole("link", { name: /Quản lý máy/ })).toBeTruthy();
	});

	it("a machine with sessions but no added project (before projects existed): every folder shows, and is added in one tap", async () => {
		projects = [];
		const list = column([{ name: "Mac mini", online: true }]);
		expect(await within(list).findByText("app")).toBeTruthy();
		expect(within(list).getByText("src")).toBeTruthy();
		expect(within(list).getByText("scratch")).toBeTruthy();
		expect(within(list).getByText("t1")).toBeTruthy();
		expect(within(list).queryByText("Chưa có dự án")).toBeNull();
		await userEvent.click(within(list).getByRole("button", { name: "Tuỳ chọn cho dự án scratch" }));
		await userEvent.click(within(list).getByRole("menuitem", { name: "Thêm làm dự án" }));
		await waitFor(() => expect(machine.received.some((f) => f.body.case === "projectAdd" && f.body.value.dir === "/tmp/scratch")).toBe(true));
	});

	it("nothing on any machine: one empty state for the whole list, never one per machine", async () => {
		projects = [];
		threads = [];
		const list = column([
			{ name: "Mac mini", online: true },
			{ name: "Mac studio", online: true },
		]);
		const empty = await within(list).findByText("Chưa có dự án");
		expect(within(list).getAllByText("Chưa có dự án")).toHaveLength(1);
		expect(empty.textContent).not.toMatch(/Mac/);
		const box = empty.closest("[data-id=sidebar-empty]");
		expect(within(box as HTMLElement).getByRole("button", { name: "Thêm dự án" }).className).toContain("btn-primary");
	});

	it("one toggle keeps only what needs the user or runs", async () => {
		const list = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t2");
		const toggle = within(list).getByRole("switch", { name: /Chỉ hiện cần bạn \/ đang chạy/ });
		await userEvent.click(toggle);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		await waitFor(() => expect(within(list).queryByText("t2")).toBeNull());
		expect(within(list).getByText("t1")).toBeTruthy();
		// A project with nothing for the user hides too.
		expect(within(list).queryByText("docs")).toBeNull();
	});

	it("several machines: each project names its machine; a machine offline with nothing known stays out of the list", async () => {
		const list = column([
			{ name: "Mac mini", online: true },
			{ name: "Old PC", online: false },
		]);
		await within(list).findByText("t1");
		expect([...list.querySelectorAll(".mx-host")].map((e) => e.textContent)).toContain("Mac mini");
		await act(() => new Promise((r) => setTimeout(r, 50)));
		expect(within(list).queryByText("Old PC")).toBeNull();
		expect(within(list).queryByRole("link", { name: "Ghép thiết bị này" })).toBeNull();
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

	it("the machine's settings: the Full Disk Access card sits in the page's column; a session shows its folder's name, the whole path on hover", async () => {
		const base = machine.handler;
		machine.handler = (frame, socket) =>
			frame.body.case === "machineInfoRequest"
				? [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.5.0", maxSessions: 3, needsFullDiskAccess: true, providers: [{ id: "claude", name: "Claude Code" }] } }]
				: base(frame, socket);
		column([{ name: "Mac mini", online: true }], { page: "info", machine: "1" });
		const card = await screen.findByRole("alert");
		expect(card.closest(".mx-body")).toBeTruthy();
		const folder = await screen.findByText("scratch", { selector: ".mx-session-row span" });
		expect(folder.getAttribute("title")).toBe("/tmp/scratch");
	});
});
