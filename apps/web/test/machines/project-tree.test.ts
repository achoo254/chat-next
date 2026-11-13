// The AI Agent column as data (project-tree.ts): sessions to the workspace
// with the longest path prefix, the rest to "Chưa phân loại" by folder; a
// workspace's state (needs you > failed > running > done unseen > idle,
// "offline" over the last state known); projects needing the user first,
// then by their newest session; a machine label only for projects on two
// machines or more.
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, ThreadState, ThreadSummarySchema, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { AgentWorkspaceKind, type AgentProject, type AgentWorkspace } from "../../src/machines/agent-projects-client.ts";
import type { LinkState, MachineLink } from "../../src/machines/link/machine-link.ts";
import type { Conn } from "../../src/machines/machine-status.ts";
import { buildTree, locate, shortHost, statusOf, threadStatus, unseenDone, workspaceLabels, worstStatus } from "../../src/machines/project-tree.ts";
import type { MachineView } from "../../src/machines/use-machines.ts";

let nextId = 100;
const ws = (projectId: number, machineId: number, dir: string, branch = ""): AgentWorkspace => ({ id: nextId++, projectId, machineId, dir, branch, kind: AgentWorkspaceKind.FOLDER, createdAt: 1 });
const project = (id: number, name: string, workspaces: AgentWorkspace[], createdAt = 1): AgentProject => ({ id, name, gitRemote: "", order: id, createdAt, workspaces });
const thread = (id: string, dir: string, state: ThreadState, updatedAt = 1000, extra: { busyElsewhere?: boolean; terminalSession?: number; archived?: boolean } = {}): ThreadSummary =>
	create(ThreadSummarySchema, { id, title: id, dir, state, updatedAt: BigInt(updatedAt), ...extra });

function machine(id: number, name: string, threads: ThreadSummary[], online = true, own: { dir: string; branch: string }[] = []): MachineView {
	const state = {
		threads,
		projects: { projects: own.map((o) => create(ProjectSchema, { id: o.dir, dir: o.dir, git: { git: true, branch: o.branch } })), suggestions: [] },
		info: null,
	} as unknown as LinkState;
	const conn = (online ? { kind: "on" } : { kind: "offline", lastSeenMs: 1 }) as Conn;
	return { entry: { ref: String(id), id, name, os: "darwin", arch: "arm64", agentVersion: "2.6.0", claudeVersion: "", tunnelUrl: "", createdAt: 0, lastSeenAt: 0, publicKey: new Uint8Array(32) }, link: {} as MachineLink, state, conn };
}

const none = new Map<string, number>();

describe("a workspace's state", () => {
	it("needs you > failed > running > done unseen > open in a terminal > idle; archived sessions never count", () => {
		const seen = new Map([["d", 1000]]);
		const idle = thread("i", "/w", ThreadState.IDLE);
		const done = thread("d", "/w", ThreadState.IDLE, 2000);
		const running = thread("r", "/w", ThreadState.RUNNING);
		const failed = thread("f", "/w", ThreadState.ERROR);
		const waiting = thread("n", "/w", ThreadState.WAITING);
		expect(statusOf([idle], seen)).toBe("idle");
		expect(statusOf([idle, done], seen)).toBe("done");
		expect(statusOf([done, running], seen)).toBe("running");
		expect(statusOf([running, failed], seen)).toBe("failed");
		expect(statusOf([failed, waiting], seen)).toBe("need");
		expect(statusOf([thread("a", "/w", ThreadState.WAITING, 1, { archived: true })], seen)).toBe("idle");
		// Running means the AI works now: a turn here, or busy elsewhere (in a terminal too).
		expect(statusOf([thread("e", "/w", ThreadState.IDLE, 1, { busyElsewhere: true })], seen)).toBe("running");
		expect(statusOf([thread("t", "/w", ThreadState.IDLE, 1, { terminalSession: 3, busyElsewhere: true })], seen)).toBe("running");
		// Held by a terminal while its AI waits at the prompt: open, never running (no spinner).
		const held = thread("h", "/w", ThreadState.IDLE, 1, { terminalSession: 3 });
		expect(threadStatus(held, false)).toBe("open");
		expect(statusOf([held], seen)).toBe("open");
		expect(statusOf([held, idle], seen)).toBe("open");
		expect(statusOf([held, done], seen)).toBe("done");
		expect(statusOf([held, running], seen)).toBe("running");
		expect(statusOf([held, waiting], seen)).toBe("need");
		// A new session opened in the terminal and never used yet: still not working.
		expect(threadStatus(thread("new", "/w", ThreadState.IDLE, 1, { terminalSession: 9 }), false)).toBe("open");
		expect(worstStatus(["idle", "open", "done"])).toBe("done");
		expect(worstStatus(["open", "idle"])).toBe("open");
	});

	it("a workspace and its project spin only when one of their sessions works; a terminal held at its prompt does not", () => {
		const m = machine(1, "Mac", [thread("h", "/w/app", ThreadState.IDLE, 1, { terminalSession: 4 }), thread("i", "/w/app", ThreadState.IDLE)]);
		const tree = buildTree([project(1, "App", [ws(1, 1, "/w/app")])], [m], "all", none);
		expect(tree.projects[0]?.workspaces[0]?.status).toBe("open");
		expect(tree.projects[0]?.status).toBe("open");
		const working = machine(1, "Mac", [thread("h", "/w/app", ThreadState.IDLE, 1, { terminalSession: 4, busyElsewhere: true })]);
		const busy = buildTree([project(1, "App", [ws(1, 1, "/w/app")])], [working], "all", none);
		expect(busy.projects[0]?.workspaces[0]?.status).toBe("running");
		expect(busy.projects[0]?.status).toBe("running");
	});

	it("done only for a session seen before that changed since; one never seen here is not", () => {
		expect(unseenDone(thread("d", "/w", ThreadState.IDLE, 2000), new Map([["d", 1000]]))).toBe(true);
		expect(unseenDone(thread("d", "/w", ThreadState.IDLE, 1000), new Map([["d", 1000]]))).toBe(false);
		expect(unseenDone(thread("d", "/w", ThreadState.IDLE, 2000), none)).toBe(false);
	});

	it("offline lies over the last state known, it does not replace it", () => {
		const m = machine(1, "Mac", [thread("n", "/w/app", ThreadState.WAITING)], false);
		const tree = buildTree([project(1, "App", [ws(1, 1, "/w/app")])], [m], "all", none);
		const node = tree.projects[0]?.workspaces[0];
		expect(node?.status).toBe("need");
		expect(node?.offline).toBe(true);
	});

	it("a removed machine's workspace (machine 0) stays, offline and without sessions", () => {
		const tree = buildTree([project(1, "App", [ws(1, 0, "/w/app")])], [machine(1, "Mac", [thread("x", "/w/app", ThreadState.IDLE)])], "all", none);
		const node = tree.projects[0]?.workspaces[0];
		expect(node?.machine).toBeNull();
		expect(node?.offline).toBe(true);
		expect(node?.threads).toEqual([]);
		// Its machine's sessions in that folder wait under "Chưa phân loại".
		expect(tree.loose.map((f) => f.dir)).toEqual(["/w/app"]);
	});
});

describe("the tree", () => {
	it("sessions go to the workspace with the longest path prefix on their machine; the rest by folder, unclassified", () => {
		const outer = ws(1, 1, "/w/mono");
		const inner = ws(2, 1, "/w/mono/packages/web");
		const m = machine(1, "Mac", [thread("a", "/w/mono/packages/web/src", ThreadState.IDLE), thread("b", "/w/mono/docs", ThreadState.IDLE), thread("c", "/tmp/x", ThreadState.IDLE), thread("d", "/tmp/x", ThreadState.IDLE)]);
		const tree = buildTree([project(1, "Mono", [outer]), project(2, "Web", [inner])], [m], "all", none);
		const ids = (name: string) => tree.projects.find((p) => p.project.name === name)?.workspaces[0]?.threads.map((x) => x.id);
		expect(ids("Web")).toEqual(["a"]);
		expect(ids("Mono")).toEqual(["b"]);
		expect(tree.loose.map((f) => [f.dir, f.threads.map((x) => x.id)])).toEqual([["/tmp/x", ["c", "d"]]]);
		expect(locate([project(1, "Mono", [outer]), project(2, "Web", [inner])], 1, "/w/mono/packages/web/x")?.project.name).toBe("Web");
	});

	it("a folder on another machine is another workspace: the same path on machine 2 is not machine 1's", () => {
		const tree = buildTree([project(1, "App", [ws(1, 1, "/w/app")])], [machine(1, "Mac", []), machine(2, "PC", [thread("x", "/w/app", ThreadState.IDLE)])], "all", none);
		expect(tree.projects[0]?.workspaces[0]?.threads).toEqual([]);
		expect(tree.loose.map((f) => f.machine.entry.name)).toEqual(["PC"]);
	});

	it("a machine's chip name: no .local, no domain; an address or a name with spaces stays whole", () => {
		expect(shortHost("Hoans-Mac-mini.local")).toBe("Hoans-Mac-mini");
		expect(shortHost("Hoans-Mac-mini.local.")).toBe("Hoans-Mac-mini");
		expect(shortHost("build.lab.example.com")).toBe("build");
		expect(shortHost("dattqh-cloud-1")).toBe("dattqh-cloud-1");
		expect(shortHost("10.0.0.12")).toBe("10.0.0.12");
		expect(shortHost("Máy nhà")).toBe("Máy nhà");
	});

	it("projects in the user's order, whatever needs the user or ran last", () => {
		const m = machine(1, "Mac", [thread("old", "/w/a", ThreadState.IDLE, 1_000), thread("new", "/w/b", ThreadState.IDLE, 5_000), thread("wait", "/w/c", ThreadState.WAITING, 10)]);
		const ordered = (p: AgentProject, order: number): AgentProject => ({ ...p, order });
		const tree = buildTree(
			[ordered(project(1, "A", [ws(1, 1, "/w/a")]), 2), ordered(project(2, "B", [ws(2, 1, "/w/b")]), 4), ordered(project(3, "C", [ws(3, 1, "/w/c")]), 3), ordered(project(4, "Empty", [], 3), 1)],
			[m],
			"all",
			none,
		);
		expect(tree.projects.map((p) => p.project.name)).toEqual(["Empty", "A", "C", "B"]);
		expect(tree.projects.find((p) => p.project.name === "C")?.need).toBe(1);
	});

	it("the branch comes from the machine when it keeps the folder, else as recorded", () => {
		const m = machine(1, "Mac", [], true, [{ dir: "/w/app", branch: "feature" }]);
		const tree = buildTree([project(1, "App", [ws(1, 1, "/w/app", "main"), ws(1, 1, "/w/other", "dev")])], [m], "all", none);
		expect(tree.projects[0]?.workspaces.map((w) => w.branch).sort()).toEqual(["dev", "feature"]);
	});

	it("the attention switch keeps only what needs the user or runs, hiding projects and folders with none", () => {
		const m = machine(1, "Mac", [thread("run", "/w/a", ThreadState.RUNNING), thread("idle", "/w/b", ThreadState.IDLE), thread("x", "/tmp", ThreadState.IDLE)]);
		const tree = buildTree([project(1, "A", [ws(1, 1, "/w/a")]), project(2, "B", [ws(2, 1, "/w/b")]), project(3, "Empty", [])], [m], "attention", none);
		expect(tree.projects.map((p) => p.project.name)).toEqual(["A"]);
		expect(tree.loose).toEqual([]);
	});
});

describe("workspace titles", () => {
	const node = (id: number, dir: string, branch: string, kind = AgentWorkspaceKind.CLONE, createdAt = id) => ({ workspace: { ...ws(1, 1, dir, branch), id, kind, createdAt }, branch });

	it("the branch, with the folder under it; the folder when two share a branch or there is none; never the project's name alone", () => {
		const labels = workspaceLabels("app", [node(1, "/w/app", "main"), node(2, "/w/app-fix", "fix/login", AgentWorkspaceKind.WORKTREE), node(3, "/srv/app", "main"), node(4, "/tmp/notes", "")]);
		expect(labels.get(1)).toEqual({ title: "w/app", byBranch: false, sub: "", primary: true });
		expect(labels.get(2)).toEqual({ title: "fix/login", byBranch: true, sub: "app-fix", primary: false });
		expect(labels.get(3)?.title).toBe("srv/app");
		expect(labels.get(4)).toEqual({ title: "notes", byBranch: false, sub: "", primary: false });
	});

	it("one workspace: no primary badge; a branch named like the project gives way to the folder", () => {
		expect(workspaceLabels("app", [node(1, "/w/site", "main")]).get(1)).toEqual({ title: "main", byBranch: true, sub: "site", primary: false });
		expect(workspaceLabels("main", [node(1, "/w/site", "main")]).get(1)?.title).toBe("site");
	});

	it("primary is the oldest checkout that is not a git worktree", () => {
		const labels = workspaceLabels("x", [node(1, "/w/wt", "a", AgentWorkspaceKind.WORKTREE, 1), node(2, "/w/x", "b", AgentWorkspaceKind.CLONE, 5), node(3, "/w/y", "c", AgentWorkspaceKind.FOLDER, 9)]);
		expect([...labels].filter(([, l]) => l.primary).map(([id]) => id)).toEqual([2]);
	});
});
