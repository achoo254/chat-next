// Workspaces and the project dialogs: paths compared as the machine names
// them; a workspace's "+" opening a session at once with the folder's
// defaults in the mode last used (no dialog), none in a folder that is gone;
// "Thêm workspace" picking the machine only when there are several, a recent
// folder in one tap, a sensitive folder asked first, a folder of another
// repository refused; "Thêm dự án" from a folder on a picked machine.
import { create } from "@bufbuild/protobuf";
import { ActivityPhase, ErrorCode, ErrorReason, ProjectSchema, TerminalAvailability, ThreadState, ThreadSummarySchema, type Frame, type Project, type ThreadActivity, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { AddAgentProjectDialog, AddWorkspaceDialog } from "../../src/machines/agent-project-dialogs.tsx";
import { AgentProjectsStore } from "../../src/machines/agent-projects-store.ts";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import type { Conn } from "../../src/machines/machine-status.ts";
import { buildTree } from "../../src/machines/project-tree.ts";
import { ProjectItem, type TreeContext } from "../../src/machines/project-tree-view.tsx";
import { inFolder, projectsSupported, samePath } from "../../src/machines/projects-view.ts";
import type { MachineView } from "../../src/machines/use-machines.ts";
import { FakeAgentProjects } from "../support/fake-agent-projects.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

type Req = Parameters<MachineLink["request"]>[0];
const ACK = { body: { case: "ack", value: {} } } as unknown as Frame;
const listing = (path: string): Frame => ({ body: { case: "dirListResult", value: { path, parent: "/", entries: [{ name: "app", git: true, branch: "main" }] } } }) as unknown as Frame;

/** A machine keeping `own` (its folders), answering like tunelo; `answer` first when it returns a frame. */
function machine(
	id: number,
	name: string,
	own: Project[],
	options: { answer?: (req: Req) => Promise<Frame | null>; info?: object; suggestions?: { dir: string; sessions: number; gitRemote?: string }[]; threads?: ThreadSummary[]; activity?: ThreadActivity } = {},
) {
	const sent: Req[] = [];
	const projects = { projects: own, suggestions: (options.suggestions ?? []).map((s) => ({ gitRemote: "", branch: "", ...s })) };
	const result = () => ({ body: { case: "projectListResult", value: projects } }) as unknown as Frame;
	const link = {
		activity: () => options.activity,
		onActivity: () => () => undefined,
		request: async (req: Req) => {
			sent.push(req);
			const custom = (await options.answer?.(req)) ?? null;
			if (custom !== null) return custom;
			if (req.case === "dirList") return listing(req.value.path || "/w");
			if (req.case === "projectAdd") {
				const dir = req.value.dir ?? "";
				own.push(create(ProjectSchema, { id: dir, name: dir, dir, gitRemote: projects.suggestions.find((s) => s.dir === dir)?.gitRemote ?? "" }));
				return result();
			}
			if (req.case === "projectList") return result();
			return ACK;
		},
	} as unknown as MachineLink;
	const state = { info: { agentVersion: "2.6.0", providers: [{ id: "claude", name: "Claude Code" }], home: "/w", ...options.info }, threads: options.threads ?? [], projects, threadInfo: new Map(), status: { kind: "open" } } as unknown as LinkState;
	const view: MachineView = {
		entry: { ref: String(id), id, name, os: "darwin", arch: "arm64", agentVersion: "2.6.0", claudeVersion: "", tunnelUrl: "", createdAt: 0, lastSeenAt: 0, publicKey: new Uint8Array(32) },
		link,
		state,
		conn: { kind: "on" } as Conn,
	};
	return { view, sent };
}

afterEach(() => {
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
});

describe("folders as the machine names them", () => {
	it("compares Windows folders without case and either slash; a trailing separator does not count", () => {
		expect(inFolder("D:\\Work\\App\\src", "d:\\work\\app")).toBe(true);
		expect(inFolder("D:\\Work\\Apples", "D:\\Work\\App")).toBe(false);
		expect(samePath("C:/Code/App/", "c:\\code\\app")).toBe(true);
		expect(samePath("/w/App", "/w/app")).toBe(false);
		expect(samePath("/w/app/", "/w/app")).toBe(true);
	});

	it("machines keep folders as projects from tunelo 2.0.7", () => {
		expect(projectsSupported("2.0.6")).toBe(false);
		expect(projectsSupported("2.0.7")).toBe(true);
		expect(projectsSupported(undefined)).toBe(false);
	});
});

async function oneProject(server: FakeAgentProjects, views: MachineView[]) {
	const store = new AgentProjectsStore(server.api());
	await store.refresh();
	const ctx: TreeContext = { store, projects: store.snapshot().projects, machines: views, now: Date.now(), seen: new Map(), current: null };
	const node = buildTree(store.snapshot().projects, views, "all", new Map()).projects[0];
	if (node === undefined) throw new Error("no project");
	return { store, ctx, node };
}

describe("a workspace row", () => {
	const terminal = { terminal: TerminalAvailability.AVAILABLE, providers: [{ id: "claude", name: "Claude Code", capabilities: { terminal: true } }] };

	it("'+' opens a session at once in the folder, with its defaults, in the mode last used on the machine; no dialog", async () => {
		window.localStorage.setItem("ai:mode:1", "terminal");
		const own = [create(ProjectSchema, { id: "p", name: "app", dir: "/w/app", defaults: { model: "sonnet", permissionMode: "plan", projectSettings: true }, git: { git: true, branch: "main" } })];
		const mac = machine(1, "Mac", own, {
			info: terminal,
			answer: async (req) => (req.case === "threadCreate" ? ({ body: { case: "threadCreated", value: { thread: { id: "t9", provider: "claude", dir: "/w/app" } } } } as unknown as Frame) : null),
		});
		const server = new FakeAgentProjects();
		server.seed("App", "", [{ machineId: 1, dir: "/w/app", branch: "main", kind: 1 }]);
		const { ctx, node } = await oneProject(server, [mac.view]);
		wrap(<ProjectItem node={node} open onToggle={() => undefined} ctx={ctx} />);
		expect(screen.getByText("main")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Phiên mới trong app" }));
		await waitFor(() => expect(window.location.pathname).toBe("/ai/1/s/t9/terminal"));
		const create_ = mac.sent.find((r) => r.case === "threadCreate");
		expect(create_?.case === "threadCreate" ? [create_.value.dir, create_.value.model, create_.value.permissionMode] : null).toEqual(["/w/app", "sonnet", "plan"]);
		expect(document.querySelector("[role=dialog]")).toBeNull();
	});

	it("offers no new session in a folder that is gone from the machine", async () => {
		const own = [create(ProjectSchema, { id: "p", name: "app", dir: "/w/app", missing: true })];
		const server = new FakeAgentProjects();
		server.seed("App", "", [{ machineId: 1, dir: "/w/app", branch: "", kind: 3 }]);
		const { ctx, node } = await oneProject(server, [machine(1, "Mac", own).view]);
		wrap(<ProjectItem node={node} open onToggle={() => undefined} ctx={ctx} />);
		expect((screen.getByRole("button", { name: "Phiên mới trong app" }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("Thêm workspace", () => {
	it("one machine: no picker; a recent folder with sessions joins the project in one tap", async () => {
		const server = new FakeAgentProjects();
		const project = server.seed("App");
		const store = new AgentProjectsStore(server.api());
		const mac = machine(1, "Mac", [], { suggestions: [{ dir: "/w/api", sessions: 3 }] });
		let closed = false;
		wrap(<AddWorkspaceDialog store={store} project={project} machines={[mac.view]} onClose={() => (closed = true)} />);
		expect(screen.queryByRole("group", { name: "Máy" })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Thêm api" }));
		await waitFor(() => expect(closed).toBe(true));
		expect(server.workspaces.map((w) => [w.projectId, w.machineId, w.dir])).toEqual([[project.id, 1, "/w/api"]]);
	});

	it("asks first for a sensitive folder, then adds it with the user's consent", async () => {
		let asked = 0;
		const server = new FakeAgentProjects();
		const project = server.seed("Keys");
		const store = new AgentProjectsStore(server.api());
		const mac = machine(1, "Mac", [], {
			suggestions: [{ dir: "/w/.ssh", sessions: 1 }],
			answer: async (req) => {
				if (req.case === "projectAdd" && asked++ === 0) throw new RemoteError(ErrorCode.NEEDS_CONSENT, "", ErrorReason.SENSITIVE_FOLDER);
				return null;
			},
		});
		let closed = false;
		wrap(<AddWorkspaceDialog store={store} project={project} machines={[mac.view]} onClose={() => (closed = true)} />);
		await userEvent.click(screen.getByRole("button", { name: "Thêm .ssh" }));
		await userEvent.click(await screen.findByRole("button", { name: "Vẫn thêm" }));
		await waitFor(() => expect(closed).toBe(true));
		expect(mac.sent.filter((r) => r.case === "projectAdd").map((r) => (r.case === "projectAdd" ? r.value.consent?.sensitive : undefined))).toEqual([false, true]);
	});

	it("lists the recent folders of another repository last, marked and without Thêm", async () => {
		const server = new FakeAgentProjects();
		const project = server.seed("App", "git@github.com:a/app.git");
		const store = new AgentProjectsStore(server.api());
		const mac = machine(1, "Mac", [], {
			suggestions: [
				{ dir: "/w/other", sessions: 5, gitRemote: "https://github.com/a/other" },
				{ dir: "/w/app", sessions: 1, gitRemote: "https://github.com/a/app" },
			],
		});
		wrap(<AddWorkspaceDialog store={store} project={project} machines={[mac.view]} onClose={() => undefined} />);
		const recent = screen.getByRole("region", { name: "Thư mục gần đây có phiên AI" });
		const rows = within(recent).getAllByRole("listitem");
		expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("app"), expect.stringContaining("repo khác")]);
		expect((screen.getByRole("button", { name: "Thêm other" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Thêm app" }) as HTMLButtonElement).disabled).toBe(false);
		expect(mac.sent.some((r) => r.case === "projectAdd")).toBe(false);
	});
});

describe("Thêm dự án from a folder", () => {
	it("several machines: the machine is picked, and the project and its first workspace are made in one step", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = machine(1, "Mac", []);
		const pc = machine(2, "PC", [], { suggestions: [{ dir: "/srv/site", sessions: 2, gitRemote: "git@github.com:a/site.git" }] });
		wrap(<AddAgentProjectDialog store={store} machines={[mac.view, pc.view]} onClose={() => undefined} />);
		await userEvent.click(screen.getByRole("button", { name: "Chọn thư mục trên máy" }));
		const picker = screen.getByRole("radiogroup", { name: "Máy" });
		await userEvent.click(within(picker).getByRole("radio", { name: "PC" }));
		await userEvent.click(await screen.findByRole("button", { name: "Thêm site" }));
		await waitFor(() => expect(server.projects.map((p) => [p.name, p.gitRemote])).toEqual([["site", "github.com/a/site"]]));
		expect(server.workspaces.map((w) => [w.machineId, w.dir])).toEqual([[2, "/srv/site"]]);
		expect(mac.sent.some((r) => r.case === "projectAdd")).toBe(false);
	});

	it("one machine: no machine picker", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		wrap(<AddAgentProjectDialog store={store} machines={[machine(1, "Mac", []).view]} onClose={() => undefined} />);
		await userEvent.click(screen.getByRole("button", { name: "Chọn thư mục trên máy" }));
		expect(screen.queryByRole("radiogroup", { name: "Máy" })).toBeNull();
		expect(await screen.findByText("app")).toBeTruthy();
	});

	it("switching machines keeps the dialog in place: the same name field and text, each machine's folders cached, the list's place kept", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		const mac = machine(1, "Mac", [], { suggestions: [{ dir: "/w/api", sessions: 3 }] });
		const pc = machine(2, "PC", []);
		wrap(<AddAgentProjectDialog store={store} machines={[mac.view, pc.view]} onClose={() => undefined} />);
		await userEvent.type(screen.getByRole("textbox", { name: "Tên dự án" }), "Kho");
		const nameField = screen.getByRole("textbox", { name: "Tên dự án" });
		await userEvent.click(screen.getByRole("button", { name: "Chọn thư mục trên máy" }));
		expect(await screen.findByText("app")).toBeTruthy();
		const dirs = document.querySelector(".mx-pick-dirs");
		const picker = screen.getByRole("radiogroup", { name: "Máy" });
		// Arrow keys move between machines, like any radio group.
		within(picker).getByRole("radio", { name: "Mac" }).focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(within(picker).getByRole("radio", { name: "PC" }).getAttribute("aria-checked")).toBe("true");
		// The recent folders keep their place, saying PC has none.
		expect(screen.getByText("Máy này chưa có thư mục nào có phiên AI.")).toBeTruthy();
		await waitFor(() => expect(pc.sent.filter((r) => r.case === "dirList")).toHaveLength(1));
		await userEvent.click(within(picker).getByRole("radio", { name: "Mac" }));
		// Back on Mac: its folder list from before, no second request; nothing remounted, nothing typed lost.
		expect(mac.sent.filter((r) => r.case === "dirList")).toHaveLength(1);
		expect(screen.getByText("api")).toBeTruthy();
		expect(document.querySelector(".mx-pick-dirs")).toBe(dirs);
		expect(screen.getByRole("textbox", { name: "Tên dự án" })).toBe(nameField);
		expect((nameField as HTMLInputElement).value).toBe("Kho");
	});

	it("three machines or more: a list opened from one button, by mouse or keyboard", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		const hosts = [machine(1, "Mac", []), machine(2, "PC", []), machine(3, "Một máy chủ có tên rất dài ở phòng lab", [])];
		wrap(<AddAgentProjectDialog store={store} machines={hosts.map((h) => h.view)} onClose={() => undefined} />);
		await userEvent.click(screen.getByRole("button", { name: "Chọn thư mục trên máy" }));
		const combo = screen.getByRole("combobox", { name: "Máy" });
		expect(combo.textContent).toBe("Mac");
		combo.focus();
		await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
		expect(screen.queryByRole("listbox")).toBeNull();
		expect(combo.textContent).toBe("PC");
		await userEvent.click(combo);
		await userEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: /phòng lab/ }));
		expect(combo.textContent).toBe("Một máy chủ có tên rất dài ở phòng lab");
	});
});

describe("a project's git link and splitting a workspace off", () => {
	it("'Liên kết kho git' checks the address with the shared rule, then links the repository's key", async () => {
		const server = new FakeAgentProjects();
		server.seed("App", "", [{ machineId: 1, dir: "/w/app", branch: "", kind: 1 }]);
		const { ctx, node } = await oneProject(server, [machine(1, "Mac", []).view]);
		wrap(<ProjectItem node={node} open onToggle={() => undefined} ctx={ctx} />);
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho dự án App" }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Liên kết kho git" }));
		const dialog = await screen.findByRole("dialog", { name: "Liên kết kho git cho App" });
		const field = within(dialog).getByRole("textbox", { name: "Repo git (tuỳ chọn)" });
		await userEvent.type(field, "/srv/git/app.git");
		expect((within(dialog).getByRole("button", { name: "Lưu liên kết" }) as HTMLButtonElement).disabled).toBe(true);
		await userEvent.clear(field);
		await userEvent.type(field, "https://user:tok@github.com/A/App.git");
		await userEvent.click(within(dialog).getByRole("button", { name: "Lưu liên kết" }));
		await waitFor(() => expect(server.projects[0]?.gitRemote).toBe("github.com/a/app"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("'Tách thành dự án riêng' shows only in a project with several workspaces, and moves the folder to a project of its own", async () => {
		const server = new FakeAgentProjects();
		server.seed("Mixed", "", [
			{ machineId: 1, dir: "/w/app", branch: "", kind: 3 },
			{ machineId: 1, dir: "/root", branch: "", kind: 3 },
		]);
		const { ctx, node } = await oneProject(server, [machine(1, "Mac", []).view]);
		wrap(<ProjectItem node={node} open onToggle={() => undefined} ctx={ctx} />);
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho workspace root" }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Tách thành dự án riêng" }));
		await waitFor(() => expect(server.projects.map((p) => [p.name, server.workspaces.filter((w) => w.projectId === p.id).map((w) => w.dir)])).toEqual([
			["Mixed", ["/w/app"]],
			["root", ["/root"]],
		]));
	});
});

describe("a session row", () => {
	it("shows a glyph, the AI, its age and what the turn does now, live; a session in the terminal shows an icon, not words", async () => {
		const now = Date.now();
		const running = create(ThreadSummarySchema, { id: "r", title: "Sửa lỗi", dir: "/w/app", provider: "claude", state: ThreadState.RUNNING, updatedAt: BigInt(now), open: true });
		const held = create(ThreadSummarySchema, { id: "h", title: "Trong terminal", dir: "/w/app", provider: "claude", state: ThreadState.IDLE, updatedAt: BigInt(now - 60_000), open: true, terminalSession: 2, busyElsewhere: false });
		const activity = { threadId: "r", phase: ActivityPhase.TOOL, tool: "Bash", turnStartedAt: BigInt(now - 27_000), outputTokens: 1200n } as unknown as ThreadActivity;
		const mac = machine(1, "Mac", [], { threads: [running, held], activity });
		const server = new FakeAgentProjects();
		server.seed("App", "", [{ machineId: 1, dir: "/w/app", branch: "", kind: 3 }]);
		const { ctx, node } = await oneProject(server, [mac.view]);
		wrap(<ProjectItem node={node} open onToggle={() => undefined} ctx={ctx} />);
		const row = screen.getByText("Sửa lỗi").closest<HTMLElement>(".mx-srow");
		if (row === null) throw new Error("no row");
		expect(row.querySelector(".mx-glyph.running")).toBeTruthy();
		expect(within(row).getByRole("img", { name: "Claude Code · Đang chạy" })).toBeTruthy();
		expect(row.querySelector(".sub")?.textContent).toMatch(/^Đang chạy Bash · 2[7-9] giây · ↓ 1,2\sN token$/);
		const inTerminal = screen.getByText("Trong terminal").closest<HTMLElement>(".mx-srow");
		if (inTerminal === null) throw new Error("no row");
		// Held by the terminal while its AI waits at the prompt: open there, not running (no spinner).
		expect(within(inTerminal).getByRole("img", { name: "Mở trong terminal" })).toBeTruthy();
		expect(inTerminal.querySelector(".mx-glyph.open")).toBeTruthy();
		expect(inTerminal.querySelector(".mx-glyph.running")).toBeNull();
		expect(inTerminal.querySelector(".sub")?.textContent).not.toContain("trong terminal");
	});
});
