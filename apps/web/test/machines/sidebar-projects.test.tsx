// The AI Agent column as Project > Workspace > sessions, with no machine in
// it: the folders a machine keeps become projects on first connect (one
// project per repository across machines), a workspace shows its folder,
// branch and state dot, and the machine's name only when its project spans
// two machines; sessions in no workspace wait, folded, in "Chưa phân loại",
// each folder offering "Tạo dự án" and "Thêm vào dự án…" (another
// repository's project refused); "Thêm dự án" takes a name and an optional
// repository; an empty project offers "Thêm workspace"; one switch for what
// needs the user or runs, with "+" on the same row.
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, type Frame, type Project } from "@achoo254/chat-proto/remote/remote";
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
type Row = ReturnType<typeof thread>;
let threads: Row[];
let projects: Project[];
let suggestions: { dir: string; sessions: number; gitRemote: string; branch: string }[];

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
const own = (id: string, dir: string, gitRemote = "", branch = "main") => create(ProjectSchema, { id, name: dir.split("/").at(-1) ?? dir, dir, gitRemote, git: { git: true, branch } });
const WAIT = { timeout: 4000 };

beforeEach(async () => {
	window.sessionStorage.clear();
	window.localStorage.clear();
	// t1 waits for the user (state 3), t2 is idle, t3 sits in a folder no workspace holds.
	threads = [thread("t1", "/w/app", 3), thread("t2", "/w/app/src", 1), thread("t3", "/tmp/scratch", 1)];
	projects = [own("p1", "/w/app", "git@github.com:a/app.git", "feature-x"), own("p2", "/w/docs")];
	suggestions = [{ dir: "/tmp/scratch", sessions: 1, gitRemote: "git@github.com:a/scratch.git", branch: "main" }];
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	machine.handler = (frame: Frame) => {
		switch (frame.body.case) {
			case "machineInfoRequest":
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.6.0", maxSessions: 3, providers: [{ id: "claude", name: "Claude Code" }] } }];
			case "threadList":
				return [{ case: "threadListResult", value: { threads, openSessions: 0, maxSessions: 3 } }];
			case "projectAdd": {
				const dir = frame.body.value.dir;
				projects = [...projects, own(`p-${dir}`, dir, suggestions.find((s) => s.dir === dir)?.gitRemote ?? "")];
				return [{ case: "projectListResult", value: { projects, suggestions } }];
			}
			case "projectList":
				return [{ case: "projectListResult", value: { projects, suggestions } }];
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
	return { list: document.querySelector<HTMLElement>(".mx-list") ?? document.body, server: machines.projects };
}

const projectRow = (list: HTMLElement, name: string) => {
	const head = within(list)
		.getAllByRole("button", { expanded: true })
		.concat(within(list).queryAllByRole("button", { expanded: false }))
		.find((b) => b.classList.contains("mx-project-toggle") && b.querySelector("b")?.textContent === name);
	if (head === undefined) throw new Error(`no project ${name}`);
	return head.closest<HTMLElement>(".mx-project") ?? head;
};

describe("the project column", () => {
	it("first connect: the machine's folders become projects, sessions sit in their workspace, no machine anywhere", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects.map((p) => p.name).sort()).toEqual(["app", "docs"]), WAIT);
		await within(list).findByText("t1", undefined, WAIT);
		const app = projectRow(list, "app");
		// The project needing the user is open, with its workspace: folder, branch, state dot.
		expect(within(app).getByText("t1")).toBeTruthy();
		expect(within(app).getByText("t2")).toBeTruthy();
		// The workspace is titled by its branch, the folder under it; never the project's name again.
		const title = app.querySelector(".mx-ws-title b");
		expect(title?.textContent).toBe("feature-x");
		// The folder is the project's name: not said again under the branch.
		expect(app.querySelector(".mx-ws-sub")).toBeNull();
		// States are glyphs: the workspace and its waiting session need the user, the idle one keeps its own icon.
		expect(app.querySelector(".mx-ws-head .mx-glyph.need")?.getAttribute("aria-label")).toBe("Cần bạn");
		// The project row counts what needs the user instead of a glyph.
		expect(app.querySelector(".mx-project-head .badge")?.textContent).toBe("1");
		expect(app.querySelectorAll(".mx-srow .mx-glyph.need")).toHaveLength(1);
		expect(app.querySelectorAll(".mx-srow .mx-glyph.idle")).toHaveLength(1);
		// Every workspace row names its machine, even with one machine (owner, 11/12/2026); no machine header row.
		const rows = [...list.querySelectorAll(".mx-ws")];
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			const chip = row.querySelector(".mx-ws-head .mx-ws-host");
			expect(chip?.textContent).toBe("Mac mini");
			// On the title line, at its end.
			expect(chip?.parentElement?.className).toBe("mx-ws-title");
		}
		expect(list.querySelector(".mx-group-head")).toBeNull();
		// "docs" has nothing for the user: folded.
		expect(projectRow(list, "docs").querySelector(".mx-ws")).toBeNull();
		// The session outside every workspace waits, folded, in "Chưa phân loại".
		expect(within(list).getByRole("button", { name: "Chưa phân loại (1)" }).getAttribute("aria-expanded")).toBe("false");
		expect(within(list).queryByText("t3")).toBeNull();
		// The top row: the switch, then "+" for a project.
		const row = list.querySelector<HTMLElement>(".mx-nav-top");
		if (row === null) throw new Error("no top row");
		expect(within(row).getByRole("switch", { name: /Chỉ hiện cần bạn \/ đang chạy/ })).toBeTruthy();
		expect(within(row).getByRole("button", { name: "Thêm dự án" })).toBeTruthy();
		expect(within(list).getByRole("link", { name: /Quản lý máy/ })).toBeTruthy();
	});

	it("one repository on two machines: one project, each workspace names its machine", async () => {
		const { list, server } = column([
			{ name: "Mac mini", online: true },
			{ name: "Mac studio", online: true },
		]);
		await waitFor(() => expect(server.workspaces).toHaveLength(4), WAIT);
		expect(server.projects.map((p) => p.name).sort()).toEqual(["app", "docs", "docs"]);
		const app = projectRow(list, "app");
		await waitFor(() => expect([...app.querySelectorAll(".mx-ws-host")].map((e) => e.textContent).sort()).toEqual(["Mac mini", "Mac studio"]), WAIT);
		// Every workspace row shown has exactly one chip.
		for (const row of list.querySelectorAll(".mx-ws")) expect(row.querySelectorAll(".mx-ws-host")).toHaveLength(1);
	});

	it("a folder in 'Chưa phân loại' becomes a project in one tap, named after its repository", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects).toHaveLength(2), WAIT);
		await userEvent.click(await within(list).findByRole("button", { name: "Chưa phân loại (1)" }, WAIT));
		expect(within(list).getByText("t3")).toBeTruthy();
		await userEvent.click(within(list).getByRole("button", { name: "Tuỳ chọn cho workspace scratch" }));
		await userEvent.click(within(list).getByRole("menuitem", { name: "Tạo dự án" }));
		await waitFor(() => expect(server.projects.map((p) => [p.name, p.gitRemote])).toContainEqual(["scratch", "github.com/a/scratch"]), WAIT);
		expect(machine.received.some((f) => f.body.case === "projectAdd" && f.body.value.dir === "/tmp/scratch")).toBe(true);
		await waitFor(() => expect(within(list).queryByRole("button", { name: /Chưa phân loại/ })).toBeNull(), WAIT);
	});

	it("'Thêm vào dự án…' refuses a project linking another repository", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects).toHaveLength(2), WAIT);
		await userEvent.click(await within(list).findByRole("button", { name: "Chưa phân loại (1)" }, WAIT));
		await userEvent.click(within(list).getByRole("button", { name: "Tuỳ chọn cho workspace scratch" }));
		await userEvent.click(within(list).getByRole("menuitem", { name: "Thêm vào dự án…" }));
		const dialog = await screen.findByRole("dialog");
		const app = within(dialog).getByRole("radio", { name: /app/ });
		expect((app as HTMLInputElement).disabled).toBe(true);
		expect(within(dialog).getByText("repo khác")).toBeTruthy();
		// "docs" links no repository: it takes the folder.
		await userEvent.click(within(dialog).getByRole("radio", { name: /docs/ }));
		await userEvent.click(within(dialog).getByRole("button", { name: "Lưu" }));
		await waitFor(() => expect(server.workspaces.find((w) => w.dir === "/tmp/scratch")?.projectId).toBe(server.projects.find((p) => p.name === "docs")?.id), WAIT);
	});

	it("'Thêm dự án': a name and an optional repository (checked), then an empty project offering 'Thêm workspace'", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects).toHaveLength(2), WAIT);
		await userEvent.click(within(list).getByRole("button", { name: "Thêm dự án" }));
		const dialog = await screen.findByRole("dialog");
		const submit = within(dialog).getByRole("button", { name: "Tạo dự án" });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Tên dự án" }), "Kế hoạch");
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Repo git (tuỳ chọn)" }), "/local/path");
		await userEvent.click(submit);
		expect(await within(dialog).findByText(/Không đọc được địa chỉ repo này/)).toBeTruthy();
		await userEvent.clear(within(dialog).getByRole("textbox", { name: "Repo git (tuỳ chọn)" }));
		await userEvent.type(within(dialog).getByRole("textbox", { name: "Repo git (tuỳ chọn)" }), "https://tok:en@github.com/a/plan.git");
		await userEvent.click(submit);
		await waitFor(() => expect(server.projects.map((p) => [p.name, p.gitRemote])).toContainEqual(["Kế hoạch", "github.com/a/plan"]), WAIT);
		// A new, empty project shows open, its next step first.
		const plan = projectRow(list, "Kế hoạch");
		expect(within(plan).getByText("Dự án chưa có workspace.")).toBeTruthy();
		await userEvent.click(within(plan).getByRole("button", { name: "Thêm workspace" }));
		expect(await screen.findByRole("dialog", { name: "Thêm workspace vào Kế hoạch" })).toBeTruthy();
	});

	it("the switch keeps only what needs the user or runs", async () => {
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t2", undefined, WAIT);
		const toggle = within(list).getByRole("switch", { name: /Chỉ hiện cần bạn \/ đang chạy/ });
		await userEvent.click(toggle);
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		await waitFor(() => expect(within(list).queryByText("t2")).toBeNull());
		expect(within(list).getByText("t1")).toBeTruthy();
		expect(within(list).queryByText("docs")).toBeNull();
	});

	it("the count on the switch turns the filter on; it never turns it off", async () => {
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t2", undefined, WAIT);
		const count = within(list).getByRole("button", { name: "Chỉ hiện 1 mục cần bạn hoặc đang chạy" });
		await userEvent.click(count);
		expect(within(list).getByRole("switch").getAttribute("aria-checked")).toBe("true");
		await userEvent.click(within(list).getByRole("button", { name: "Chỉ hiện 1 mục cần bạn hoặc đang chạy" }));
		expect(within(list).getByRole("switch").getAttribute("aria-checked")).toBe("true");
	});

	it("the keyboard: one row in the tab order, arrows move, Left and Right fold and open a project, Enter opens", async () => {
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t2", undefined, WAIT);
		await waitFor(() => expect(list.querySelectorAll(".mx-project-toggle")).toHaveLength(3), WAIT);
		const rows = () => [...list.querySelectorAll<HTMLElement>(".mx-groups [data-row]")];
		await waitFor(() => expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1));
		const app = projectRow(list, "app").querySelector<HTMLElement>(".mx-project-toggle");
		if (app === null) throw new Error("no project row");
		app.focus();
		await userEvent.keyboard("{ArrowDown}");
		expect(document.activeElement?.textContent).toContain("t1");
		expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
		expect(app.tabIndex).toBe(-1);
		// Left from a session goes up to its project; Left again folds it; Right opens it.
		await userEvent.keyboard("{ArrowLeft}");
		expect(document.activeElement).toBe(app);
		await userEvent.keyboard("{ArrowLeft}");
		expect(app.getAttribute("aria-expanded")).toBe("false");
		await userEvent.keyboard("{ArrowRight}");
		expect(app.getAttribute("aria-expanded")).toBe("true");
		await userEvent.keyboard("{ArrowDown}{Enter}");
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/t1"));
	});

	it("nothing on any machine: one empty state for the whole list", async () => {
		projects = [];
		threads = [];
		const { list } = column([
			{ name: "Mac mini", online: true },
			{ name: "Mac studio", online: true },
		]);
		const empty = await within(list).findByText("Chưa có dự án", undefined, WAIT);
		expect(within(list).getAllByText("Chưa có dự án")).toHaveLength(1);
		const box = empty.closest<HTMLElement>("[data-id=sidebar-empty]");
		if (box === null) throw new Error("no empty state");
		expect(within(box).getByRole("button", { name: "Thêm dự án" }).className).toContain("btn-primary");
	});

	it("an old address of a session still opens it; its header names the project, the folder and the machine", async () => {
		column([{ name: "Mac mini", online: true }], { page: "session", machine: "1", threadId: "t2" });
		const head = await screen.findByText("app", { selector: ".mx-head .mono" }, WAIT);
		expect(head.getAttribute("title")).toBe("/w/app/src");
		expect(screen.getAllByText(/Mac mini/).length).toBeGreaterThan(0);
		expect(screen.queryByText(/chưa là dự án/)).toBeNull();
	});

	it("the machine's settings: the Full Disk Access card sits in the page's column; a session shows its folder's name, the whole path on hover", async () => {
		const base = machine.handler;
		machine.handler = (frame, socket) =>
			frame.body.case === "machineInfoRequest"
				? [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.6.0", maxSessions: 3, needsFullDiskAccess: true, providers: [{ id: "claude", name: "Claude Code" }] } }]
				: base(frame, socket);
		column([{ name: "Mac mini", online: true }], { page: "info", machine: "1" });
		const card = await screen.findByRole("alert");
		expect(card.closest(".mx-body")).toBeTruthy();
		const folder = await screen.findByText("scratch", { selector: ".mx-session-row span" });
		expect(folder.getAttribute("title")).toBe("/tmp/scratch");
	});
});
