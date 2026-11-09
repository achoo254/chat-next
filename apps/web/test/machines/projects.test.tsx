// Projects in the AI Agent column: sessions grouped by project (the rest
// under "Khác"), what a project row says and does ("+" with its defaults,
// pin, remove), "Thêm dự án" from a folder (asking for a sensitive one) or
// a clone (only https/ssh, with progress and cancel), and machines older than
// tunelo 2.0.7 keeping the old column.
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, ProjectSchema, type Frame, type Project, type ProjectCloneProgress, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { RemoteError, type LinkState, type MachineLink } from "../../src/machines/link/machine-link.ts";
import { AddProjectDialog, cloneUrlOk } from "../../src/machines/project-dialogs.tsx";
import { ProjectSection } from "../../src/machines/project-section.tsx";
import { byProject, gitLine, inFolder, projectsSupported } from "../../src/machines/projects-view.ts";

const wrap = (node: ReactNode) => render(<I18nProvider>{node}</I18nProvider>);

type ProjectInit = Exclude<MessageInitShape<typeof ProjectSchema>, Project>;
const project = (over: ProjectInit = {}): Project =>
	create(ProjectSchema, { id: "p1", name: "chat-next", dir: "/w/chat-next", git: { git: true, branch: "main", changed: 3 }, defaults: { model: "", permissionMode: "", projectSettings: false }, ...over });
const thread = (id: string, dir: string) => ({ id, dir, title: id, state: 1, updatedAt: 1n, archived: false }) as unknown as ThreadSummary;

type Req = Parameters<MachineLink["request"]>[0];
const ACK = { body: { case: "ack", value: {} } } as unknown as Frame;
function fakeLink(answer: (req: Req) => Promise<Frame> = () => Promise.resolve(ACK)) {
	const sent: Req[] = [];
	return { sent, link: { request: (req: Req) => (sent.push(req), answer(req)) } as unknown as MachineLink };
}
const baseState = (over: Partial<LinkState> = {}) =>
	({ info: { agentVersion: "2.0.7", providers: [], home: "/w" }, threads: [], journals: new Map(), threadInfo: new Map(), clones: new Map(), projects: null, ...over }) as unknown as LinkState;

describe("grouping by project", () => {
	it("puts each session in the deepest project holding its folder, the rest under Khác", () => {
		const outer = project({ id: "a", dir: "/w" });
		const inner = project({ id: "b", dir: "/w/app" });
		const { groups, other } = byProject([thread("t1", "/w/app/src"), thread("t2", "/w/docs"), thread("t3", "/elsewhere"), thread("t4", "/w/application")], [outer, inner]);
		expect(groups.map((g) => [g.project.id, g.threads.map((t) => t.id)])).toEqual([
			["a", ["t2", "t4"]],
			["b", ["t1"]],
		]);
		expect(other.map((t) => t.id)).toEqual(["t3"]);
	});

	it("compares Windows folders without case", () => {
		expect(inFolder("D:\\Work\\App\\src", "d:\\work\\app")).toBe(true);
		expect(inFolder("D:\\Work\\Apples", "D:\\Work\\App")).toBe(false);
	});

	it("says branch, changes and ahead/behind; nothing outside git", () => {
		expect(gitLine(project({ git: { git: true, branch: "main", changed: 2, ahead: 1, behind: 0 } }), (n) => `${n} thay đổi`)).toBe("main · 2 thay đổi · ↑1 ↓0");
		expect(gitLine(project({ git: { git: false } }), String)).toBe("");
	});

	it("is offered by tunelo 2.0.7 and later only", () => {
		expect(projectsSupported("2.0.6")).toBe(false);
		expect(projectsSupported("2.0.7")).toBe(true);
		expect(projectsSupported(undefined)).toBe(false);
	});
});

describe("clone URLs on the device", () => {
	it("takes https and ssh, refuses the rest before asking the machine", () => {
		for (const ok of ["https://github.com/a/b.git", "git@github.com:a/b.git", "ssh://git@host:22/a/b"]) expect(cloneUrlOk(ok), ok).toBe(true);
		for (const bad of ["http://github.com/a/b", "file:///etc", "/etc", "ext::sh -c x", "--upload-pack=x", "https://u:p@github.com/a/b", "https://tok@github.com/a/b", "https://github.com", ""]) {
			expect(cloneUrlOk(bad), bad).toBe(false);
		}
	});
});

describe("a project row", () => {
	it("starts a session at once with the project's defaults", async () => {
		const { link, sent } = fakeLink();
		const p = project({ defaults: { model: "sonnet", permissionMode: "plan", projectSettings: true } });
		wrap(
			<ProjectSection machine="m1" machineName="Mac" link={link} state={baseState()} project={p} order={["p1"]} online>
				<span />
			</ProjectSection>,
		);
		expect(screen.getByText("main · 3 thay đổi")).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Phiên mới trong chat-next" }));
		const req = sent[0];
		expect(req?.case).toBe("threadCreate");
		if (req?.case === "threadCreate") {
			expect(req.value.dir).toBe("/w/chat-next");
			expect(req.value.model).toBe("sonnet");
			expect(req.value.permissionMode).toBe("plan");
			expect(req.value.consent?.projectSettings).toBe(true);
			expect(req.value.text).not.toBe("");
		}
	});

	it("pins and removes from the list, saying the folder stays", async () => {
		const { link, sent } = fakeLink();
		wrap(
			<ProjectSection machine="m1" machineName="Mac" link={link} state={baseState()} project={project()} order={["p1"]} online>
				<span />
			</ProjectSection>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho dự án chat-next" }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Ghim lên đầu" }));
		expect(sent.at(-1)).toMatchObject({ case: "projectUpdate", value: { id: "p1", pinned: true } });
		await userEvent.click(screen.getByRole("button", { name: "Tuỳ chọn cho dự án chat-next" }));
		await userEvent.click(screen.getByRole("menuitem", { name: "Gỡ khỏi danh sách" }));
		expect(await screen.findByText(/Thư mục \/w\/chat-next và các phiên trong đó vẫn giữ nguyên/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: "Gỡ khỏi danh sách" }));
		await waitFor(() => expect(sent.at(-1)).toEqual({ case: "projectRemove", value: { id: "p1" } }));
	});

	it("says when its folder is gone and offers no new session there", () => {
		const { link } = fakeLink();
		wrap(
			<ProjectSection machine="m1" machineName="Mac" link={link} state={baseState()} project={project({ missing: true })} order={["p1"]} online>
				<span />
			</ProjectSection>,
		);
		expect(screen.getByText("Thư mục không còn trên máy")).toBeTruthy();
		expect((screen.getByRole("button", { name: "Phiên mới trong chat-next" }) as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("Thêm dự án", () => {
	const listing = (path: string): Frame => ({ body: { case: "dirListResult", value: { path, parent: "/", entries: [{ name: "app", git: true, branch: "main" }] } } }) as unknown as Frame;

	it("adds the folder shown, asking first for a sensitive one", async () => {
		let asked = 0;
		const { link, sent } = fakeLink(async (req) => {
			if (req.case === "dirList") return listing(req.value.path || "/w");
			if (req.case === "projectAdd" && asked++ === 0) throw new RemoteError(ErrorCode.NEEDS_CONSENT, "", ErrorReason.SENSITIVE_FOLDER);
			return ACK;
		});
		let closed = false;
		wrap(<AddProjectDialog link={link} state={baseState()} ai="Claude Code" initialDir="/w/.ssh" onClose={() => (closed = true)} />);
		await screen.findByText("app");
		await userEvent.click(screen.getByRole("button", { name: "Thêm dự án" }));
		await userEvent.click(await screen.findByRole("button", { name: "Vẫn thêm" }));
		await waitFor(() => expect(closed).toBe(true));
		const adds = sent.filter((r) => r.case === "projectAdd");
		expect(adds.map((r) => (r.case === "projectAdd" ? r.value.consent?.sensitive : undefined))).toEqual([false, true]);
	});

	it("refuses an odd clone URL on the device, and shows a clone's progress with cancel", async () => {
		const { link, sent } = fakeLink(async (req) => (req.case === "dirList" ? listing("/w") : ACK));
		const progress = new Map<string, ProjectCloneProgress>();
		const { rerender } = wrap(<AddProjectDialog link={link} state={baseState({ clones: progress })} ai="Claude Code" onClose={() => undefined} />);
		await userEvent.click(screen.getByRole("tab", { name: "Clone từ git" }));
		await screen.findByText("app");
		await userEvent.type(screen.getByRole("textbox", { name: "Địa chỉ repo (https hoặc ssh)" }), "file:///etc");
		await userEvent.click(screen.getByRole("button", { name: "Clone" }));
		expect((await screen.findByRole("alert")).textContent).toContain("Chỉ nhận địa chỉ https://");
		expect(sent.some((r) => r.case === "projectClone")).toBe(false);
		await userEvent.clear(screen.getByRole("textbox", { name: "Địa chỉ repo (https hoặc ssh)" }));
		await userEvent.type(screen.getByRole("textbox", { name: "Địa chỉ repo (https hoặc ssh)" }), "https://github.com/a/b.git");
		await userEvent.click(screen.getByRole("button", { name: "Clone" }));
		const req = sent.find((r) => r.case === "projectClone");
		const cloneId = (req?.case === "projectClone" ? req.value.cloneId : undefined) ?? "";
		expect(req?.case === "projectClone" && req.value.parent).toBe("/w");
		const next = new Map<string, ProjectCloneProgress>([[cloneId, { cloneId, phase: "Receiving objects", percent: 45, done: false, projectId: "", reason: 0, message: "" } as unknown as ProjectCloneProgress]]);
		rerender(
			<I18nProvider>
				<AddProjectDialog link={link} state={baseState({ clones: next })} ai="Claude Code" onClose={() => undefined} />
			</I18nProvider>,
		);
		expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("45");
		await userEvent.click(screen.getByRole("button", { name: "Huỷ clone" }));
		expect(sent.at(-1)).toEqual({ case: "projectCloneCancel", value: { cloneId } });
	});
});
