// Folders of the machines into the server's projects (project-sync.ts,
// project-actions.ts): idempotent, safe with several devices at once (the
// server's unique keys decide, a race lost is success, a project made for
// nothing in a race is deleted again), merged by git repository across
// machines, and never a project for sessions found running outside the app.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ProjectSchema, ProjectSuggestionSchema, ThreadSummarySchema, type Frame, type Project, type ProjectSuggestion } from "@achoo254/chat-proto/remote/remote";
import { RemoteError, type MachineLink } from "../../src/machines/link/machine-link.ts";

type FrameBody = Parameters<MachineLink["request"]>[0];
import { afterEach, describe, expect, it } from "vitest";
import { AgentProjectsStore } from "../../src/machines/agent-projects-store.ts";
import { adoptStarted, detachWorkspace, linkRepository, placeByHand, RemoteMismatchError, splitWorkspace, syncHosts, type SyncHost } from "../../src/machines/project-actions.ts";
import { misplaced, placeFolder, syncFolders, type FolderInfo } from "../../src/machines/project-sync.ts";
import { FakeAgentProjects } from "../support/fake-agent-projects.ts";

const folder = (machineId: number, dir: string, remote = "", name = ""): FolderInfo => ({ machineId, dir, remote, branch: remote === "" ? "" : "main", git: remote !== "", name });

const own = (dir: string, gitRemote = "", id = dir): Project => create(ProjectSchema, { id, name: dir.split("/").at(-1) ?? dir, dir, gitRemote, git: gitRemote === "" ? undefined : { git: true, branch: "main" } });

/** A machine keeping `projects`, answering projectAdd/projectList/projectRemove like tunelo. */
function host(id: number, projects: Project[]): Omit<SyncHost, "link"> & { link: SyncHost["link"]; sent: FrameBody[]; projects: Project[] } {
	const sent: FrameBody[] = [];
	const suggestions: ProjectSuggestion[] = [];
	const state = { projects: { projects, suggestions }, info: { agentVersion: "2.6.0" } } as unknown as SyncHost["state"];
	const result = (): Frame => ({ body: { case: "projectListResult", value: { projects, suggestions: [] } } }) as unknown as Frame;
	return {
		id,
		ready: true,
		state,
		sent,
		projects,
		link: {
			request: async (body: FrameBody) => {
				sent.push(body);
				// The machine reads the folder's remote as it adds it.
				if (body.case === "projectAdd") projects.push(own(body.value.dir ?? "", suggestions.find((x) => x.dir === body.value.dir)?.gitRemote ?? ""));
				if (body.case === "projectRemove") projects.splice(projects.findIndex((p) => p.id === body.value.id), 1);
				return result();
			},
		},
	};
}

afterEach(() => window.localStorage.clear());

describe("placing folders", () => {
	it("is idempotent: a second pass over the same folders changes nothing", async () => {
		const server = new FakeAgentProjects();
		const api = server.api();
		const folders = [folder(1, "/w/app", "git@github.com:a/app.git"), folder(1, "/w/notes")];
		const first = await syncFolders(api, await api.list(), folders, () => false);
		expect(first.placed).toBe(2);
		const changes = server.log.length;
		const second = await syncFolders(api, await api.list(), folders, () => false);
		expect(second).toEqual({ placed: 0, failed: [] });
		expect(server.log.length).toBe(changes);
		const list = await api.list();
		expect(list.map((p) => [p.name, p.gitRemote, p.workspaces.map((w) => w.dir)])).toEqual([
			["app", "github.com/a/app", ["/w/app"]],
			["notes", "", ["/w/notes"]],
		]);
	});

	it("merges one repository's clones on two machines into one project", async () => {
		const server = new FakeAgentProjects();
		const api = server.api();
		await syncFolders(api, await api.list(), [folder(1, "/Users/me/app", "git@github.com:a/app.git")], () => false);
		await syncFolders(api, await api.list(), [folder(2, "C:\\code\\app", "https://github.com/A/App")], () => false);
		const list = await api.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.workspaces.map((w) => [w.machineId, w.dir])).toEqual([
			[1, "/Users/me/app"],
			[2, "C:\\code\\app"],
		]);
	});

	it("two devices at once, a folder outside git: one project stays, the one made for nothing is deleted", async () => {
		const server = new FakeAgentProjects();
		const a = server.api();
		const b = server.api();
		const f = [folder(1, "/w/notes")];
		const [ra, rb] = await Promise.all([syncFolders(a, await a.list(), f, () => false), syncFolders(b, await b.list(), f, () => false)]);
		expect(ra.failed).toEqual([]);
		expect(rb.failed).toEqual([]);
		const list = await a.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.workspaces.map((w) => w.dir)).toEqual(["/w/notes"]);
		// Both devices made a project; the one that lost the race deleted its own.
		expect(server.log.filter((x) => x.startsWith("create:"))).toHaveLength(2);
		expect(server.log.filter((x) => x.startsWith("delete:"))).toHaveLength(1);
	});

	it("two devices at once, one repository: the second joins the project the first made", async () => {
		const server = new FakeAgentProjects();
		const a = server.api();
		const b = server.api();
		const [ra, rb] = await Promise.all([
			syncFolders(a, await a.list(), [folder(1, "/w/app", "git@github.com:a/app.git")], () => false),
			syncFolders(b, await b.list(), [folder(2, "/srv/app", "https://github.com/a/app.git")], () => false),
		]);
		expect([...ra.failed, ...rb.failed]).toEqual([]);
		const list = await a.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.workspaces.map((w) => w.machineId).sort()).toEqual([1, 2]);
	});

	it("never deletes a project another device attached to in the race", async () => {
		const server = new FakeAgentProjects();
		const a = server.api();
		const b = server.api();
		// Same folder, same repository, from two devices: one creates, the other joins it; nothing is deleted.
		const f = [folder(1, "/w/app", "git@github.com:a/app.git")];
		await Promise.all([syncFolders(a, await a.list(), f, () => false), syncFolders(b, await b.list(), f, () => false)]);
		const list = await a.list();
		expect(list).toHaveLength(1);
		expect(list[0]?.workspaces).toHaveLength(1);
		expect(server.log.filter((x) => x.startsWith("delete:"))).toEqual([]);
	});

	it("into a chosen project: attached there, or moved there when another project holds it", async () => {
		const server = new FakeAgentProjects();
		const api = server.api();
		const target = server.seed("Target");
		const known = await api.list();
		await placeFolder(api, known, folder(1, "/w/x"), target.id);
		const other = server.seed("Other");
		await placeFolder(api, await api.list(), folder(1, "/w/x"), other.id);
		const list = await api.list();
		expect(list.find((p) => p.id === other.id)?.workspaces.map((w) => w.dir)).toEqual(["/w/x"]);
		expect(list.find((p) => p.id === target.id)?.workspaces).toEqual([]);
	});
});

describe("the sync and the app's own actions", () => {
	it("first connect: the machine's folders become projects and workspaces, asking the machine only for its list", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, [own("/w/app", "git@github.com:a/app.git"), own("/w/notes")]);
		expect(await syncHosts(store, [mac])).toBe(2);
		expect(store.snapshot().projects.map((p) => p.name)).toEqual(["app", "notes"]);
		// Only its list was asked, once per pass.
		expect(mac.sent.map((b) => b.case)).toEqual(["projectList"]);
		expect(await syncHosts(store, [mac])).toBe(0);
	});

	it("a list this device holds from before a folder was removed does not bring the folder back", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		// The machine keeps nothing now; this device never heard (its link was away when the machine told).
		const mac = host(1, []);
		(mac.state as { projects: unknown }).projects = { projects: [own("/w/gone")], suggestions: [] };
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(store.snapshot().projects).toEqual([]);
		expect(server.workspaces).toEqual([]);
	});

	it("a machine that does not answer is left for the next pass, never recorded from the list held", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, [own("/w/app")]);
		const silent = { ...mac, link: { request: () => Promise.reject(new Error("link closed")) } } as SyncHost;
		expect(await syncHosts(store, [silent])).toBe(0);
		expect(store.snapshot().projects).toEqual([]);
		expect(await syncHosts(store, [mac])).toBe(1);
	});

	it("sessions found running outside the app make no project: only folders the machine keeps are synced", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, []);
		// A session in /tmp/scratch exists on the machine, but the machine keeps no folder.
		(mac.state as { threads?: unknown }).threads = [create(ThreadSummarySchema, { id: "t", dir: "/tmp/scratch" })];
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(store.snapshot().projects).toEqual([]);
	});

	it("a session started from the app in a new folder: a project named after its repository", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, []);
		mac.state.projects?.suggestions.push(create(ProjectSuggestionSchema, { dir: "/w/chat", sessions: 1, gitRemote: "git@github.com:a/chat-next.git", branch: "main" }));
		await adoptStarted(store, mac, { dir: "/w/chat", gitRoot: "" });
		expect(store.snapshot().projects.map((p) => [p.name, p.gitRemote, p.workspaces.map((w) => w.dir)])).toEqual([["chat-next", "github.com/a/chat-next", ["/w/chat"]]]);
		// Inside a workspace already: nothing new.
		await adoptStarted(store, mac, { dir: "/w/chat/src", gitRoot: "/w/chat" });
		expect(store.snapshot().projects).toHaveLength(1);
	});

	it("a session started in a folder inside a clone: the clone becomes the workspace, not the folder", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, []);
		await adoptStarted(store, mac, { dir: "/w/panel/backend/src", gitRoot: "/w/panel" });
		expect(store.snapshot().projects.flatMap((p) => p.workspaces.map((w) => w.dir))).toEqual(["/w/panel"]);
		expect(mac.sent.map((b) => (b.case === "projectAdd" ? b.value.dir : b.case))).toEqual(["/w/panel"]);
		// Another folder of the same clone: held by the clone's workspace already.
		await adoptStarted(store, mac, { dir: "/w/panel/client", gitRoot: "/w/panel" });
		expect(store.snapshot().projects.flatMap((p) => p.workspaces)).toHaveLength(1);
	});

	it("a sensitive work tree (a home folder kept in git) gives way to the session's own folder", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, []);
		const remote = mac.link.request;
		mac.link = {
			request: async (body: FrameBody) => {
				if (body.case === "projectAdd" && body.value.dir === "/home/me") throw new RemoteError(ErrorCode.NEEDS_CONSENT, "sensitive");
				return remote(body);
			},
		};
		await adoptStarted(store, mac, { dir: "/home/me/notes", gitRoot: "/home/me" });
		expect(store.snapshot().projects.flatMap((p) => p.workspaces.map((w) => w.dir))).toEqual(["/home/me/notes"]);
	});

	it("attaching a folder of another repository is refused, and the machine forgets a folder it added for it", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		server.seed("App", "git@github.com:a/app.git");
		await store.refresh();
		const target = store.snapshot().projects[0];
		if (target === undefined) throw new Error("no project");
		const mac = host(1, []);
		const remote = mac.link.request;
		mac.link = {
			request: async (body: FrameBody) => {
				const frame = await remote(body);
				if (body.case === "projectAdd") {
					const added = mac.projects.at(-1);
					if (added !== undefined) added.gitRemote = "git@github.com:a/other.git";
				}
				return frame;
			},
		};
		await expect(placeByHand(store, mac, "/w/other", { target })).rejects.toBeInstanceOf(RemoteMismatchError);
		expect(mac.sent.map((b) => b.case)).toEqual(["projectAdd", "projectList", "projectRemove"]);
		expect(store.snapshot().projects[0]?.workspaces).toEqual([]);
	});

	it("a sync pass while a workspace is being detached does not record it again", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, [own("/w/app")]);
		await syncHosts(store, [mac]);
		const workspace = store.snapshot().projects[0]?.workspaces[0];
		if (workspace === undefined) throw new Error("no workspace");
		// The machine answers projectRemove only when let go; meanwhile a sync pass runs.
		let answer = (): void => undefined;
		const request = mac.link.request;
		const slow = { ...mac, link: { ...mac.link, request: (body: FrameBody) => (body.case === "projectRemove" ? new Promise<Frame>((resolve) => (answer = () => resolve(request(body)))) : request(body)) } } as SyncHost;
		const detaching = detachWorkspace(store, workspace, slow);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await syncHosts(store, [mac])).toBe(0);
		answer();
		await detaching;
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(server.workspaces).toEqual([]);
		expect(mac.projects).toEqual([]);
	});

	it("detaching drops the folder from the machine even when this device's copy of its list is empty", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, [own("/w/app")]);
		await syncHosts(store, [mac]);
		const workspace = store.snapshot().projects[0]?.workspaces[0];
		if (workspace === undefined) throw new Error("no workspace");
		const stale = { ...mac, state: { projects: undefined, info: {} } } as unknown as SyncHost;
		await detachWorkspace(store, workspace, stale);
		expect(mac.projects).toEqual([]);
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(server.workspaces).toEqual([]);
	});

	it("a workspace detached while its machine is offline is not added again: the machine drops it when back", async () => {
		const server = new FakeAgentProjects();
		const store = new AgentProjectsStore(server.api());
		await store.refresh();
		const mac = host(1, [own("/w/app")]);
		await syncHosts(store, [mac]);
		const workspace = store.snapshot().projects[0]?.workspaces[0];
		if (workspace === undefined) throw new Error("no workspace");
		await detachWorkspace(store, workspace, null);
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(mac.sent.map((b) => b.case).filter((c) => c !== "projectList")).toEqual(["projectRemove"]);
		expect(store.isDetached({ machineId: 1, dir: "/w/app" })).toBe(false);
		expect(store.snapshot().projects[0]?.workspaces).toEqual([]);
	});
});

/** Projects by name with their folders, sorted, for exact checks. */
function shape(store: AgentProjectsStore): [string, string, string[]][] {
	return store
		.snapshot()
		.projects.map((p): [string, string, string[]] => [p.name, p.gitRemote, p.workspaces.map((w) => `${w.machineId}:${w.dir}`).sort()])
		.sort((a, b) => a[0].localeCompare(b[0]));
}

async function freshStore(server = new FakeAgentProjects()) {
	const store = new AgentProjectsStore(server.api());
	await store.refresh();
	return { server, store };
}

describe("only the same known repository shares a project", () => {
	it("three folders without a known remote on two machines: three projects, each named after its folder", async () => {
		const { store } = await freshStore();
		// A machine too old to report remotes: every remote is empty.
		await syncHosts(store, [host(1, [own("/Users/me/hoandat-app"), own("/Users/me/acme-records-portal")]), host(2, [own("/root")])]);
		expect(shape(store)).toEqual([
			["acme-records-portal", "", ["1:/Users/me/acme-records-portal"]],
			["hoandat-app", "", ["1:/Users/me/hoandat-app"]],
			["root", "", ["2:/root"]],
		]);
		expect(await syncHosts(store, [host(1, [own("/Users/me/hoandat-app"), own("/Users/me/acme-records-portal")]), host(2, [own("/root")])])).toBe(0);
	});

	it("a folder without a remote never joins an existing project linking none", async () => {
		const server = new FakeAgentProjects();
		server.seed("Notes", "", [{ machineId: 1, dir: "/w/notes", branch: "", kind: 3 }]);
		const { store } = await freshStore(server);
		await syncHosts(store, [host(1, [own("/w/notes"), own("/w/other")])]);
		expect(shape(store)).toEqual([
			["Notes", "", ["1:/w/notes"]],
			["other", "", ["1:/w/other"]],
		]);
	});

	it("two folders of different repositories: two projects", async () => {
		const { store } = await freshStore();
		await syncHosts(store, [host(1, [own("/w/hoandat-app", "git@github.com:achoo254/hoandat-app.git"), own("/w/acme-records", "https://gitlab.example.com/scm/team/acme-records.git")])]);
		expect(shape(store)).toEqual([
			["acme-records", "gitlab.example.com/scm/team/acme-records", ["1:/w/acme-records"]],
			["hoandat-app", "github.com/achoo254/hoandat-app", ["1:/w/hoandat-app"]],
		]);
	});

	it("one repository on two machines: one project", async () => {
		const { store } = await freshStore();
		await syncHosts(store, [host(1, [own("/Users/me/app", "git@github.com:a/app.git")]), host(2, [own("/srv/app", "https://github.com/a/app")])]);
		expect(shape(store)).toEqual([["app", "github.com/a/app", ["1:/Users/me/app", "2:/srv/app"]]]);
	});
});

describe("repairing workspaces grouped with another repository", () => {
	it("a workspace in a project linking another repository moves to its own repository's project; one with no known remote stays; nothing else changes", async () => {
		const server = new FakeAgentProjects();
		const wrong = server.seed("acme-records-portal", "https://gitlab.example.com/scm/team/acme-records.git", [
			{ machineId: 1, dir: "/w/acme-records-portal", branch: "", kind: 1 },
			{ machineId: 1, dir: "/w/hoandat-app", branch: "", kind: 1 },
			{ machineId: 2, dir: "/root", branch: "", kind: 3 },
		]);
		const { store } = await freshStore(server);
		const mac = host(1, [own("/w/acme-records-portal", "https://gitlab.example.com/scm/team/acme-records.git"), own("/w/hoandat-app", "git@github.com:achoo254/hoandat-app.git")]);
		const cloud = host(2, [own("/root")]);
		expect(await syncHosts(store, [mac, cloud])).toBe(1);
		expect(shape(store)).toEqual([
			["acme-records-portal", "gitlab.example.com/scm/team/acme-records", ["1:/w/acme-records-portal", "2:/root"]],
			["hoandat-app", "github.com/achoo254/hoandat-app", ["1:/w/hoandat-app"]],
		]);
		// Only moves: no workspace or project removed, nothing asked of the machines but their lists.
		expect(server.log.filter((x) => x.startsWith("detach:") || x.startsWith("delete:"))).toEqual([]);
		expect([...mac.sent, ...cloud.sent].map((b) => b.case)).toEqual(["projectList", "projectList"]);
		expect(store.snapshot().projects.find((p) => p.id === wrong.id)).toBeTruthy();
		// A second pass finds nothing to do.
		expect(await syncHosts(store, [mac, cloud])).toBe(0);
	});

	it("a project linking none, holding folders whose remotes are unknown, is the user's grouping: left alone", async () => {
		const server = new FakeAgentProjects();
		server.seed("Mine", "", [
			{ machineId: 1, dir: "/w/a", branch: "", kind: 3 },
			{ machineId: 2, dir: "/root", branch: "", kind: 3 },
		]);
		const { store } = await freshStore(server);
		expect(await syncHosts(store, [host(1, [own("/w/a")]), host(2, [own("/root")])])).toBe(0);
		expect(shape(store)).toEqual([["Mine", "", ["1:/w/a", "2:/root"]]]);
	});

	it("an offline machine's workspaces are never moved (their remote is not known now)", () => {
		const project = { id: 1, name: "x", gitRemote: "github.com/a/x", order: 0, createdAt: 0, workspaces: [] };
		expect(misplaced([project], [])).toEqual([]);
	});

	it("a project linking none is never repaired, even when another project links a workspace's repository", async () => {
		const server = new FakeAgentProjects();
		server.seed("Mine", "", [{ machineId: 1, dir: "/w/app", branch: "", kind: 1 }]);
		server.seed("App", "git@github.com:a/app.git");
		const { store } = await freshStore(server);
		const mac = host(1, [own("/w/app", "git@github.com:a/app.git")]);
		expect(await syncHosts(store, [mac])).toBe(0);
		expect(shape(store)).toEqual([
			["App", "github.com/a/app", []],
			["Mine", "", ["1:/w/app"]],
		]);
		expect(server.log.filter((x) => x.startsWith("move:"))).toEqual([]);
	});

	it("after linking a project to a repository: new folders of it join, workspaces placed elsewhere stay, another repository's workspace in it moves out", async () => {
		const server = new FakeAgentProjects();
		const plan = server.seed("Kế hoạch", "", [{ machineId: 1, dir: "/w/other", branch: "", kind: 1 }]);
		server.seed("Mine", "", [{ machineId: 1, dir: "/w/app", branch: "", kind: 1 }]);
		const { store } = await freshStore(server);
		const own3 = [own("/w/app", "git@github.com:a/app.git"), own("/w/other", "git@github.com:a/other.git")];
		const mac = host(1, own3);
		expect(await syncHosts(store, [mac])).toBe(0);
		const target = store.snapshot().projects.find((p) => p.id === plan.id);
		if (target === undefined) throw new Error("no project");
		await linkRepository(store, target, "https://user:tok@github.com/A/App.git");
		expect(server.projects.find((p) => p.id === plan.id)?.gitRemote).toBe("github.com/a/app");
		// A clone of the repository the machine adds later joins the linked project.
		own3.push(own("/srv/app-2", "https://github.com/a/app"));
		expect(await syncHosts(store, [mac])).toBe(2);
		expect(shape(store)).toEqual([
			["Kế hoạch", "github.com/a/app", ["1:/srv/app-2"]],
			["Mine", "", ["1:/w/app"]],
			["other", "github.com/a/other", ["1:/w/other"]],
		]);
		// A second pass finds nothing to do.
		expect(await syncHosts(store, [mac])).toBe(0);
		// A repository another project links is refused; "" unlinks.
		const other = store.snapshot().projects.find((p) => p.name === "other");
		if (other === undefined) throw new Error("no project");
		await expect(linkRepository(store, other, "git@github.com:a/app.git")).rejects.toThrow(/project_remote_exists/);
		await linkRepository(store, target, "");
		expect(server.projects.find((p) => p.id === plan.id)?.gitRemote).toBe("");
	});

	it("'Tách thành dự án riêng': a folder without a remote gets a project named after it; one with a remote goes to its repository's project", async () => {
		const server = new FakeAgentProjects();
		const mixed = server.seed("Mixed", "", [
			{ machineId: 2, dir: "/root", branch: "", kind: 3 },
			{ machineId: 1, dir: "/w/site", branch: "", kind: 1 },
			{ machineId: 1, dir: "/w/keep", branch: "", kind: 3 },
		]);
		const { store } = await freshStore(server);
		const ws = (dir: string) => store.snapshot().projects.flatMap((p) => p.workspaces).find((w) => w.dir === dir);
		const root = ws("/root");
		const site = ws("/w/site");
		if (root === undefined || site === undefined) throw new Error("no workspace");
		await splitWorkspace(store, root, "");
		await splitWorkspace(store, site, "git@github.com:a/site.git");
		expect(shape(store)).toEqual([
			["Mixed", "", ["1:/w/keep"]],
			["root", "", ["2:/root"]],
			["site", "github.com/a/site", ["1:/w/site"]],
		]);
		expect(store.snapshot().projects.find((p) => p.id === mixed.id)).toBeTruthy();
		expect(server.log.filter((x) => x.startsWith("detach:") || x.startsWith("delete:"))).toEqual([]);
	});
});
