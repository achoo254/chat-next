// The AI Agent column as Project > Workspace > sessions, with no machine in
// it: only folders the user added on a machine are projects (one project per
// repository across machines; a folder the machine keeps that nobody added
// never shows by itself), a workspace shows its folder,
// branch and state dot, and the machine's name only when its project spans
// two machines; sessions in no workspace wait, folded, in "Chưa phân loại",
// each folder offering "Tạo dự án" and "Thêm vào dự án…" (another
// repository's project refused); "Thêm dự án" takes a name and an optional
// repository; an empty project offers "Thêm workspace"; "Làm mới danh sách"
// lists again, with "+" beside it in the column's head.
import { createConnectTransport } from "@connectrpc/connect-web";
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, TerminalAvailability, type Frame, type Project } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { MachineLinksProvider } from "../../src/machines/link/connection-provider.tsx";
import MachinesScreen from "../../src/machines/machines-screen.tsx";
import { AgentWorkspaceKind } from "../../src/machines/agent-projects-client.ts";
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
		renew: async () => device,
		seenMachineKey: async () => null,
		rememberMachineKey: async () => undefined,
		forgetMachineKey: async () => undefined,
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
	machine.trusted = [device.publicKey];
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

/**
 * The folders the machines keep (`projects`), recorded on the server as the
 * user added them on each online machine: one project per repository across
 * machines, a project of its own for a folder outside one.
 */
function recordAdded(server: FakeMachines["projects"], hosts: readonly { online: boolean }[]): void {
	const byRemote = new Map<string, { name: string; workspaces: { machineId: number; dir: string; branch: string; kind: AgentWorkspaceKind }[] }>();
	hosts.forEach((h, i) => {
		if (!h.online) return;
		for (const p of projects) {
			const workspace = { machineId: i + 1, dir: p.dir, branch: p.git?.branch ?? "", kind: AgentWorkspaceKind.CLONE };
			if (p.gitRemote === "") server.seed(p.name, "", [workspace]);
			else {
				const group = byRemote.get(p.gitRemote) ?? { name: p.name, workspaces: [] };
				group.workspaces.push(workspace);
				byRemote.set(p.gitRemote, group);
			}
		}
	});
	for (const [remote, group] of byRemote) server.seed(group.name, remote, group.workspaces);
}

function column(hosts: { name: string; online: boolean }[], view: MachinesView = { page: "machines" }, before?: (server: FakeMachines["projects"]) => void, added = true) {
	const machines = new FakeMachines();
	hosts.forEach((h, i) =>
		machines.add({ name: h.name, tunnelUrl: h.online ? `wss://m-${i + 1}.tunnel.hoandat.com` : "", lastSeenAt: h.online ? BigInt(Math.floor(Date.now() / 1000)) : 0n, publicKey: machine.keys.publicKey }),
	);
	if (added) recordAdded(machines.projects, hosts);
	before?.(machines.projects);
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
	it("the folders added on the machine are projects, sessions sit in their workspace, no machine anywhere", async () => {
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
		// The column's head: "Làm mới danh sách" and "+" for a project beside "Quản lý máy"; no filter switch.
		const row = list.querySelector<HTMLElement>(".mx-list-head");
		if (row === null) throw new Error("no head");
		expect(within(row).getByRole("button", { name: "Làm mới danh sách" })).toBeTruthy();
		expect(within(row).queryByRole("switch")).toBeNull();
		expect(within(row).getByRole("button", { name: "Thêm dự án" })).toBeTruthy();
		expect(within(list).getByRole("link", { name: /Quản lý máy/ })).toBeTruthy();
	});

	it("a folder the machine keeps that nobody added never shows as a project by itself: its sessions wait in 'Chưa phân loại'", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }], { page: "machines" }, undefined, false);
		await waitFor(() => expect(within(list).getAllByRole("button", { name: /Chưa phân loại/ }).length).toBeGreaterThan(0), WAIT);
		// The column lists the machine's folders once, then the sync pass asks again (it reads the list fresh): wait for that pass.
		await waitFor(() => expect(machine.received.filter((f) => f.body.case === "projectList").length).toBeGreaterThanOrEqual(2), WAIT);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(server.projects).toEqual([]);
		expect(server.workspaces).toEqual([]);
		expect(list.querySelector("[data-project-id]")).toBeNull();
	});

	it("a workspace and its project working with Claude show Claude's running mark, as the session row does", async () => {
		threads = [thread("t1", "/w/app", 2), thread("t2", "/w/app/src", 1)];
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t1", undefined, WAIT);
		const app = projectRow(list, "app");
		for (const where of [".mx-project-head", ".mx-ws-head", ".mx-srow"]) {
			await waitFor(() => expect(app.querySelector(`${where} .mx-glyph.running`)?.getAttribute("data-ai")).toBe("claude"), WAIT);
		}
	});

	it("one repository added on two machines: one project, each workspace names its machine", async () => {
		const { list, server } = column([
			{ name: "Mac mini", online: true },
			{ name: "Mac studio", online: true },
		]);
		await waitFor(() => expect(server.workspaces).toHaveLength(4), WAIT);
		expect(server.projects.map((p) => p.name).sort()).toEqual(["app", "docs", "docs"]);
		const app = await waitFor(() => projectRow(list, "app"), WAIT);
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

	it("every workspace offers 'Cài đặt phiên mới': a folder the machine keeps no project for is added first, then its settings open", async () => {
		// A workspace in a subfolder, added on another device: the machine keeps no project for it.
		const { list, server } = column([{ name: "Mac mini", online: true }], { page: "machines" }, (s) => s.seed("panel", "", [{ machineId: 1, dir: "/w/panel/src", branch: "main", kind: AgentWorkspaceKind.FOLDER }]));
		await waitFor(() => expect(server.projects.map((p) => p.name)).toContain("app"), WAIT);
		await waitFor(() => projectRow(list, "panel"), WAIT);
		const toggle = projectRow(list, "panel").querySelector<HTMLElement>(".mx-project-toggle");
		if (toggle?.getAttribute("aria-expanded") === "false") await userEvent.click(toggle);
		await userEvent.click(await within(list).findByRole("button", { name: "Tuỳ chọn cho workspace src" }, WAIT));
		await userEvent.click(within(list).getByRole("menuitem", { name: "Cài đặt phiên mới" }));
		await waitFor(() => expect(machine.received.some((f) => f.body.case === "projectAdd" && f.body.value.dir === "/w/panel/src")).toBe(true), WAIT);
		expect(await screen.findByRole("dialog", { name: "Cài đặt phiên mới trong src" }, WAIT)).toBeTruthy();
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

	it("archived sessions wait behind one row at the column's foot, which leads back too", async () => {
		threads = [...threads, { ...thread("t9", "/w/app", 1), archived: true }];
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t1", undefined, WAIT);
		expect(within(list).queryByText("t9")).toBeNull();
		const foot = list.querySelector<HTMLElement>(".mx-list-foot");
		if (foot === null) throw new Error("no foot");
		await userEvent.click(within(foot).getByRole("button", { name: "Phiên đã lưu trữ (1)" }));
		expect(await within(list).findByText("Phiên đã lưu trữ (1)")).toBeTruthy();
		expect(await within(list).findByText("t9")).toBeTruthy();
		expect(within(list).queryByText("t1")).toBeNull();
		const back = within(foot).getByRole("button", { name: "Quay lại danh sách phiên" });
		expect(back.getAttribute("aria-pressed")).toBe("true");
		await userEvent.click(back);
		expect(await within(list).findByText("t1")).toBeTruthy();
		expect(within(list).queryByText("Phiên đã lưu trữ (1)")).toBeNull();
	});

	it("the refresh button lists the machine's sessions again", async () => {
		const { list } = column([{ name: "Mac mini", online: true }]);
		await within(list).findByText("t1", undefined, WAIT);
		threads = [...threads, thread("t4", "/w/app", 3)];
		expect(within(list).queryByText("t4")).toBeNull();
		await userEvent.click(within(list).getByRole("button", { name: "Làm mới danh sách" }));
		expect(await within(list).findByText("t4", undefined, WAIT)).toBeTruthy();
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

	it("the machine's settings ask for nothing on macOS, and sessions are left to the column and the overview", async () => {
		const base = machine.handler;
		machine.handler = (frame, socket) =>
			frame.body.case === "machineInfoRequest"
				? [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "3.17.0", maxSessions: 3, providers: [{ id: "claude", name: "Claude Code" }] } }]
				: base(frame, socket);
		column([{ name: "Mac mini", online: true }], { page: "info", machine: "1" });
		const body = await waitFor(() => {
			const found = document.querySelector(".mx-body");
			expect(found).toBeTruthy();
			return found;
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByText(/Full Disk Access/)).toBeNull();
		expect(body?.querySelector(".mx-session-row")).toBeNull();
	});
});

describe("shells in the column", () => {
	it("a machine's live shells sit under the workspace holding their folder, each opening in the machine's terminal", async () => {
		const base = machine.handler;
		machine.handler = (frame, socket) => {
			if (frame.body.case === "machineInfoRequest")
				return [{ case: "machineInfo", value: { name: "Mac mini", os: "darwin", agentVersion: "2.6.0", maxSessions: 3, terminal: TerminalAvailability.AVAILABLE, providers: [{ id: "claude", name: "Claude Code" }] } }];
			if (frame.body.case === "termListRequest")
				return [
					{
						case: "termListResult",
						value: {
							sessions: [
								{ session: 11, title: "pnpm dev", cwd: "/w/app/apps/web", createdAt: BigInt(Date.now() - 60_000), attached: false },
								{ session: 12, title: "", cwd: "/w/app", createdAt: BigInt(Date.now()), attached: true },
								// An AI's own CLI is its session's row; an ended shell and one outside every workspace stay out.
								{ session: 13, title: "claude", cwd: "/w/app", threadId: "t1" },
								{ session: 14, title: "old", cwd: "/w/app", exited: true },
								{ session: 15, title: "tmp", cwd: "/tmp" },
							],
							maxSessions: 8,
						},
					},
				];
			return base(frame, socket);
		};
		const { list } = column([{ name: "Mac mini", online: true }]);
		const app = await waitFor(() => {
			const row = projectRow(list, "app");
			expect(row.querySelector("[data-id=sidebar-shell-11]")).toBeTruthy();
			return row;
		}, WAIT);
		const shells = [...app.querySelectorAll<HTMLAnchorElement>(".mx-shell")];
		expect(shells.map((a) => a.dataset.id)).toEqual(["sidebar-shell-12", "sidebar-shell-11"]);
		// No title: "Shell"; a device shows it or it runs in the background; a subfolder is named.
		expect(shells[0]?.textContent).toContain("Shell");
		expect(shells[0]?.textContent).toContain("Đang mở ở thiết bị");
		expect(shells[1]?.textContent).toContain("pnpm dev");
		expect(shells[1]?.textContent).toContain("Chạy nền · apps/web");
		expect(shells[1]?.getAttribute("href")).toBe("/ai/1/terminal?open=11");
		expect(list.querySelector("[data-id=sidebar-shell-13], [data-id=sidebar-shell-14], [data-id=sidebar-shell-15]")).toBeNull();
	});
});

describe("the projects' order", () => {
	const names = (list: HTMLElement) => [...list.querySelectorAll("[data-project-id] .mx-project-toggle b")].map((b) => b.textContent);
	const serverOrder = (server: ReturnType<typeof column>["server"]) => server.list().map((p) => p.name);

	it("follows the user's order, not what needs the user; 'Lên trên' and 'Xuống dưới' move a project one place, on the server too", async () => {
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects.map((p) => p.name).sort()).toEqual(["app", "docs"]), WAIT);
		await within(list).findByText("t1", undefined, WAIT);
		const first = names(list);
		expect(first).toEqual(serverOrder(server));
		const [top, second] = first;
		if (top == null || second == null) throw new Error("two projects expected");
		// The first one cannot go up, the last one cannot go down.
		await userEvent.click(within(list).getByRole("button", { name: `Tuỳ chọn cho dự án ${top}` }));
		expect(within(list).queryByRole("menuitem", { name: "Lên trên" })).toBeNull();
		await userEvent.click(within(list).getByRole("menuitem", { name: "Xuống dưới" }));
		await waitFor(() => expect(names(list)).toEqual([second, top]), WAIT);
		await waitFor(() => expect(serverOrder(server)).toEqual([second, top]), WAIT);
		await userEvent.click(within(list).getByRole("button", { name: `Tuỳ chọn cho dự án ${top}` }));
		expect(within(list).queryByRole("menuitem", { name: "Xuống dưới" })).toBeNull();
		await userEvent.click(within(list).getByRole("menuitem", { name: "Lên trên" }));
		await waitFor(() => expect(serverOrder(server)).toEqual([top, second]), WAIT);
	});

	it("a mouse drags a project by its row; the click ending the drag does not fold it, and a plain click still does", async () => {
		HTMLElement.prototype.setPointerCapture = () => undefined;
		const { list, server } = column([{ name: "Mac mini", online: true }]);
		await waitFor(() => expect(server.projects.map((p) => p.name).sort()).toEqual(["app", "docs"]), WAIT);
		await within(list).findByText("t1", undefined, WAIT);
		const [top, second] = names(list);
		if (top == null || second == null) throw new Error("two projects expected");
		const rows = [...list.querySelectorAll<HTMLElement>("[data-project-id]")];
		rows.forEach((row, i) => (row.getBoundingClientRect = () => ({ top: i * 100, bottom: i * 100 + 80, height: 80, left: 0, right: 300, width: 300 }) as DOMRect));
		const head = rows[0]?.querySelector<HTMLElement>(".mx-project-toggle");
		if (head == null) throw new Error("no row");
		const expanded = head.getAttribute("aria-expanded");
		fireEvent.pointerDown(head, { button: 0, pointerId: 1, pointerType: "mouse", clientX: 10, clientY: 10 });
		fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 40 });
		expect(rows[0]?.dataset.drag).toBe("dragging");
		fireEvent.pointerMove(window, { pointerId: 1, clientX: 10, clientY: 170 });
		expect(rows[1]?.dataset.drag).toBe("after");
		fireEvent.pointerUp(window, { pointerId: 1, clientX: 10, clientY: 170 });
		fireEvent.click(head);
		expect(head.getAttribute("aria-expanded")).toBe(expanded);
		await waitFor(() => expect(names(list)).toEqual([second, top]), WAIT);
		await waitFor(() => expect(serverOrder(server)).toEqual([second, top]), WAIT);
		// No drag: a click folds or opens as before.
		const moved = projectRow(list, top).querySelector<HTMLElement>(".mx-project-toggle");
		const before = moved?.getAttribute("aria-expanded");
		if (moved == null) throw new Error("no row");
		await userEvent.click(moved);
		expect(moved.getAttribute("aria-expanded")).not.toBe(before);
	});
});
