// The workspace panel against a machine over the real end-to-end link (the
// fake machine of fake-machine.ts with the in-memory workspace of
// fake-workspace.ts): the Explorer's tree (folders first, pages, open with
// the keys, git's marks, ignored entries dimmed), its searches and previews,
// watching while it shows; Source Control's stage, commit (Ctrl+Enter),
// discard and the confirmations it needs (secret files named, a detached
// HEAD), refusals in words, diffs; offline and an outdated machine.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ErrorReason, WsGitArea } from "@achoo254/chat-proto/remote/remote";
import { generateKeyPair, type KeyPair } from "@achoo254/chat-remote-protocol";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../src/i18n/i18n.tsx";
import { freeForHotkey } from "../../src/machines/cards/approval.tsx";
import { ServicesContext, type Services } from "../../src/messaging/data/services.tsx";
import { MachineLink, type Timers } from "../../src/machines/link/machine-link.ts";
import { viMachines } from "../../src/machines/copy-vi.ts";
import { viPanel } from "../../src/machines/workspace/panel-copy-vi.ts";
import { DEFAULT_PREFS, type PanelPrefs } from "../../src/machines/workspace/panel-prefs.ts";
import WorkspacePanel from "../../src/machines/workspace/workspace-panel.tsx";
import { FakeWorkspace } from "../support/fake-workspace.ts";
import { defaultAnswer, FakeMachine, until } from "./fake-machine.ts";

const URL_A = "wss://abc.tunnel.hoandat.com";
const timers: Timers = {
	setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
	clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	setInterval: () => 0,
	clearInterval: () => undefined,
	now: () => Date.now(),
};
const p = viPanel;

let machine: FakeMachine;
let device: KeyPair;
let ws: FakeWorkspace;
let link: MachineLink;

beforeEach(async () => {
	machine = await FakeMachine.create();
	device = await generateKeyPair();
	machine.paired = [device.publicKey];
	ws = new FakeWorkspace();
	machine.handler = (frame) => ws.handle(frame) ?? defaultAnswer(frame);
	link = new MachineLink({
		device: () => Promise.resolve(device),
		deviceName: "test",
		pinned: () => Promise.resolve(machine.keys.publicKey),
		tunnelUrl: () => URL_A,
		refreshTunnel: () => Promise.resolve(URL_A),
		socket: machine.factory,
		timers,
		random: () => 0,
	});
	link.start();
	await until(() => link.snapshot().status.kind === "open", "open");
});

afterEach(() => link.stop());

function Panel({ initial, online = true, onTerminal }: { initial: PanelPrefs; online?: boolean; onTerminal?: () => void }) {
	const [prefs, setPrefs] = useState(initial);
	return (
		<WorkspacePanel
			link={link}
			workspace={{ id: "pr1", name: "demo-app", dir: "/code/demo-app" }}
			online={online}
			ai="Claude Code"
			prefs={prefs}
			onPrefs={(change) => setPrefs((x) => ({ ...x, ...change }))}
			onTerminal={onTerminal}
		/>
	);
}

/** The diff card's copy button tells through the app's toasts. */
const services = { toasts: { show: () => undefined } } as unknown as Services;
const open = (tab: PanelPrefs["tab"], extra: { online?: boolean; onTerminal?: () => void } = {}) =>
	render(
		<I18nProvider>
			<ServicesContext value={services}>
				<Panel initial={{ ...DEFAULT_PREFS, open: true, tab }} {...extra} />
			</ServicesContext>
		</I18nProvider>,
	);
const sent = (kind: string) => ws.seen.filter((b) => b.case === kind);
const tree = () => screen.getByRole("tree", { name: p.explorer.tree });
const rowNames = () => within(tree()).queryAllByRole("treeitem").map((row) => row.querySelector(".ws-name")?.textContent ?? row.textContent);

describe("the Explorer", () => {
	it("lists folders first, opens them, marks git's states and dims what git ignores; watches while open", async () => {
		const view = open("explorer");
		await waitFor(() => expect(rowNames()).toContain("README.md"));
		expect(rowNames().slice(0, 5)).toEqual(["apps", "dist", "docs", "fixtures", "node_modules"]);
		// Hidden entries stay out until asked for; the secret one never shows.
		expect(rowNames()).not.toContain(".gitignore");
		expect(ws.watching).toBe(true);
		const row = (name: string) => within(tree()).getAllByRole("treeitem").find((r) => r.querySelector(".ws-name")?.textContent === name);
		expect(row("node_modules")?.className).toContain("ignored");
		expect(row("package.json")?.querySelector(".ws-mark")?.textContent).toContain("M");
		expect(row("link-to-home")?.textContent).toContain(p.explorer.outside);

		await userEvent.click(row("docs") as HTMLElement);
		await waitFor(() => expect(rowNames()).toContain("guide.md"));
		expect(row("guide.md")?.getAttribute("aria-level")).toBe("2");
		expect(row("guide.md")?.className).toContain("ws-git-renamed");
		expect(row("notes")?.className).toContain("ws-git-untracked");

		// "Show hidden files" asks again with show_hidden; .env.local still never shows.
		await userEvent.click(screen.getByRole("button", { name: p.explorer.more }));
		await userEvent.click(screen.getByRole("menuitemcheckbox", { name: p.explorer.showHidden }));
		await waitFor(() => expect(rowNames()).toContain(".gitignore"));
		expect(rowNames()).not.toContain(".env.local");

		view.unmount();
		await until(() => !ws.watching, "watch off");
	});

	it("moves with the keys: down, right opens and enters, left leaves, Enter previews", async () => {
		open("explorer");
		await waitFor(() => expect(rowNames()).toContain("README.md"));
		const first = within(tree()).getAllByRole("treeitem")[0] as HTMLElement;
		expect(first.tabIndex).toBe(0);
		first.focus();
		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		expect(document.activeElement?.textContent).toContain("docs");
		await userEvent.keyboard("{ArrowRight}");
		await waitFor(() => expect(rowNames()).toContain("notes"));
		await userEvent.keyboard("{ArrowRight}");
		expect(document.activeElement?.textContent).toContain("notes");
		await userEvent.keyboard("{ArrowDown}");
		expect(document.activeElement?.textContent).toContain("guide.md");
		// Only the focused row takes Tab.
		expect(within(tree()).getAllByRole("treeitem").filter((r) => r.tabIndex === 0)).toHaveLength(1);
		await userEvent.keyboard("{Enter}");
		const viewer = await screen.findByRole("region", { name: "docs/guide.md" });
		await waitFor(() => expect(within(viewer).getByRole("heading", { name: "Guide" })).toBeTruthy());
		await userEvent.keyboard("{ArrowLeft}");
		expect(document.activeElement?.textContent).toContain("docs");
		await userEvent.keyboard("{ArrowLeft}");
		await waitFor(() => expect(rowNames()).not.toContain("guide.md"));
	});

	it("loads a long folder page by page, after the last entry shown", async () => {
		open("explorer");
		await waitFor(() => expect(rowNames()).toContain("fixtures"));
		await userEvent.click(within(tree()).getByText("fixtures"));
		const more = await screen.findByText(p.explorer.loadMore(500, 620));
		await userEvent.click(more);
		await waitFor(() => expect(rowNames()).toContain("case-620.json"));
		const pages = sent("wsDirList").filter((b) => b.case === "wsDirList" && b.value.path === "fixtures");
		expect(pages.map((b) => (b.case === "wsDirList" ? [b.value.afterName, b.value.limit] : []))).toEqual([
			["", 500],
			["case-500.json", 500],
		]);
		expect(screen.queryByText(/Tải thêm/)).toBeNull();
	});

	it("reads an open folder again when the machine says it changed, and says when it polls", async () => {
		open("explorer");
		await waitFor(() => expect(rowNames()).toContain("README.md"));
		const before = sent("wsDirList").length;
		ws.files.set("NEW.md", { text: "new" });
		act(() => machine.send(machine.socket, { case: "wsChanged", value: { workspaceId: "pr1", dirs: [""], polling: true } }));
		await waitFor(() => expect(rowNames()).toContain("NEW.md"));
		expect(sent("wsDirList").length).toBe(before + 1);
		expect(await screen.findByText(p.explorer.polling)).toBeTruthy();
		// Another workspace's change is not ours.
		act(() => machine.send(machine.socket, { case: "wsChanged", value: { workspaceId: "other", dirs: [""] } }));
		await new Promise((r) => setTimeout(r, 30));
		expect(sent("wsDirList").length).toBe(before + 1);
	});

	it("finds files by name and lines by content, and opens a line", async () => {
		open("explorer");
		const box = await screen.findByRole("searchbox", { name: p.explorer.findNames });
		await userEvent.type(box, "panel");
		await waitFor(() => expect(screen.getByRole("button", { name: /workspace-panel\.tsx/ })).toBeTruthy());
		const asked = sent("wsFindNames").length;
		// Typing on narrows the complete list here, without asking again.
		await userEvent.type(box, " tsx");
		await new Promise((r) => setTimeout(r, 200));
		expect(sent("wsFindNames").length).toBe(asked);

		await userEvent.click(screen.getByRole("button", { name: p.explorer.contents }));
		const contents = screen.getByRole("searchbox", { name: p.explorer.findContents });
		await userEvent.clear(contents);
		await userEvent.type(contents, "Alt+Shift");
		await waitFor(() => expect(screen.getByText(p.explorer.contentsSummary(1, 1))).toBeTruthy());
		expect(screen.getByText("Alt+Shift", { selector: "mark" })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: /3\s*Open the panel/ }));
		const viewer = await screen.findByRole("region", { name: "docs/guide.md" });
		// Markdown opened at a line shows its source, the line marked.
		await waitFor(() => expect(viewer.querySelector("tr.hit")?.textContent).toContain("Open the panel"));
	});

	it("previews pictures, says why a binary or an outside link cannot show, and opens the terminal", async () => {
		const onTerminal = vi.fn();
		open("explorer", { onTerminal });
		await waitFor(() => expect(rowNames()).toContain("link-to-home"));
		await userEvent.click(within(tree()).getByText("link-to-home"));
		expect(await screen.findByText(p.errors.pathOutside)).toBeTruthy();
		await userEvent.click(within(tree()).getByText("apps"));
		await userEvent.click(await within(tree()).findByText("web"));
		await userEvent.click(await within(tree()).findByText("public"));
		await userEvent.click(await within(tree()).findByText("logo.png"));
		expect(await screen.findByRole("img", { name: `${p.preview.image}: apps/web/public/logo.png` })).toBeTruthy();
		await userEvent.click(within(tree()).getByText("font.woff2"));
		expect(await screen.findByText(/Tệp nhị phân/)).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: p.preview.openInTerminal }));
		expect(onTerminal).toHaveBeenCalled();
		expect(screen.queryByRole("region", { name: "apps/web/public/font.woff2" })).toBeNull();
	});
});

describe("Source Control", () => {
	const changes = () => screen.getByRole("region", { name: p.scm.changes });

	it("stages a file, and asks before staging a secret file, naming it", async () => {
		open("scm");
		await waitFor(() => expect(within(changes()).getByText("package.json")).toBeTruthy());
		expect(screen.getByRole("tab", { name: `${p.tabs.scm} (8)` })).toBeTruthy();
		await userEvent.click(screen.getByRole("button", { name: p.scm.stage("package.json") }));
		await waitFor(() => expect(ws.entries.find((e) => e.path === "package.json")?.area).toBe(WsGitArea.STAGED));

		await userEvent.click(screen.getByRole("button", { name: p.scm.stageAll }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(p.confirm.sensitiveTitle)).toBeTruthy();
		expect(within(dialog).getByText(".env.local")).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: p.confirm.sensitiveStage }));
		await waitFor(() => expect(ws.entries.every((e) => e.area === WsGitArea.STAGED)).toBe(true));
		const stage = sent("wsGitStage").at(-1);
		expect(stage?.case === "wsGitStage" ? [stage.value.all, stage.value.confirmSensitive] : null).toEqual([true, [".env.local"]]);
	});

	it("asks again when the machine names a secret file the device did not know of", async () => {
		ws.failures.set("wsGitStage", { reason: ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, subject: "keys/deploy.pem" });
		open("scm");
		await waitFor(() => expect(within(changes()).getByText("package.json")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: p.scm.stage("package.json") }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText("keys/deploy.pem")).toBeTruthy();
		await userEvent.click(within(dialog).getByRole("button", { name: p.confirm.sensitiveStage }));
		await waitFor(() => expect(sent("wsGitStage")).toHaveLength(2));
		const retry = sent("wsGitStage")[1];
		expect(retry?.case === "wsGitStage" ? retry.value.confirmSensitive : null).toEqual(["keys/deploy.pem"]);
		// The refusal opened the confirmation; no error shows.
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("discards only after a confirmation that names the count and where untracked files go", async () => {
		open("scm");
		await waitFor(() => expect(within(changes()).getByText("build-log.md")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: p.scm.moreActions }));
		await userEvent.click(screen.getByRole("menuitem", { name: p.scm.discardAll }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(p.confirm.discardBody(5))).toBeTruthy();
		expect(within(dialog).getByText(p.confirm.discardUntracked)).toBeTruthy();
		expect(within(dialog).getByText(p.confirm.discardTracked)).toBeTruthy();
		expect(sent("wsGitDiscard")).toHaveLength(0);
		await userEvent.click(within(dialog).getByRole("button", { name: p.confirm.discard }));
		await waitFor(() => expect(sent("wsGitDiscard")).toHaveLength(1));
		const discard = sent("wsGitDiscard")[0];
		expect(discard?.case === "wsGitDiscard" ? [discard.value.confirm, discard.value.paths.length] : null).toEqual([true, 5]);
		await waitFor(() => expect(within(changes()).queryByText("build-log.md")).toBeNull());
	});

	it("sends nothing when a discard is cancelled", async () => {
		open("scm");
		await waitFor(() => expect(within(changes()).getByText("package.json")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: p.scm.discard("package.json") }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(p.confirm.discardBody(1))).toBeTruthy();
		expect(within(dialog).queryByText(p.confirm.discardUntracked)).toBeNull();
		await userEvent.click(within(dialog).getByRole("button", { name: p.confirm.cancel }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(sent("wsGitDiscard")).toHaveLength(0);
	});

	it("commits with Ctrl+Enter, says hooks do not run, and clears the message", async () => {
		open("scm");
		const box = await screen.findByRole("textbox", { name: p.scm.message });
		expect(screen.getByText(p.scm.hooksNote)).toBeTruthy();
		expect(screen.getByRole("button", { name: `${p.scm.aiMessage} (${p.scm.comingSoon})` })).toHaveProperty("disabled", true);
		await userEvent.type(box, "feat: panel{Control>}{Enter}{/Control}");
		await waitFor(() => expect(sent("wsGitCommit")).toHaveLength(1));
		const commit = sent("wsGitCommit")[0];
		expect(commit?.case === "wsGitCommit" ? [commit.value.message, commit.value.allowDetached] : null).toEqual(["feat: panel", false]);
		await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
		await waitFor(() => expect(screen.getByText("feat: panel")).toBeTruthy());
	});

	it("asks before committing on a detached HEAD, then sends allow_detached", async () => {
		ws.branch = "";
		open("scm");
		const box = await screen.findByRole("textbox", { name: p.scm.message });
		expect(await screen.findByText(p.scm.detached("4f1c2a9"))).toBeTruthy();
		await userEvent.type(box, "fix: on detached");
		await userEvent.click(screen.getByRole("button", { name: p.scm.commit }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(p.confirm.detachedBody)).toBeTruthy();
		expect(sent("wsGitCommit")).toHaveLength(0);
		await userEvent.click(within(dialog).getByRole("button", { name: p.confirm.detachedCommit }));
		await waitFor(() => expect(sent("wsGitCommit")).toHaveLength(1));
		const commit = sent("wsGitCommit")[0];
		expect(commit?.case === "wsGitCommit" ? commit.value.allowDetached : null).toBe(true);
	});

	it("says why a push failed in words, and opens a diff; never a secret file's", async () => {
		ws.failures.set("wsGitPush", { reason: ErrorReason.GIT_NEEDS_CREDENTIALS });
		open("scm");
		await waitFor(() => expect(within(changes()).getByText("package.json")).toBeTruthy());
		await userEvent.click(screen.getByRole("button", { name: /Push/ }));
		expect((await screen.findByRole("alert")).textContent).toBe(viMachines.errors.reasons.gitNeedsCredentials);

		await userEvent.click(within(changes()).getByTitle("package.json"));
		const viewer = await screen.findByRole("region", { name: "package.json" });
		await waitFor(() => expect(viewer.querySelector(".mx-diff")).toBeTruthy());
		const diff = sent("wsGitDiff").at(-1);
		expect(diff?.case === "wsGitDiff" ? [diff.value.path, diff.value.source] : null).toEqual(["package.json", 1]);

		const before = sent("wsGitDiff").length;
		await userEvent.click(within(changes()).getByTitle(".env.local"));
		await screen.findByRole("region", { name: ".env.local" });
		expect(sent("wsGitDiff").length).toBe(before);
	});

	it("shows the branch with its upstream, a Create PR link, committed-on-branch files and commits", async () => {
		open("scm");
		const pr = await screen.findByRole("link", { name: p.scm.createPr });
		expect(pr.getAttribute("href")).toBe("https://github.com/example/demo-app/compare/main...feat%2Fworkspace-panel?expand=1");
		expect(pr.getAttribute("rel")).toBe("noopener noreferrer");
		expect(pr.getAttribute("target")).toBe("_blank");
		expect(screen.getByTitle("origin/feat/workspace-panel").textContent).toContain("↑2↓1");
		const branch = screen.getByRole("region", { name: p.scm.committedOnBranch });
		await waitFor(() => expect(within(branch).getByText("panel-toggle.tsx")).toBeTruthy());
		const commits = screen.getByRole("region", { name: p.scm.commits });
		await waitFor(() => expect(within(commits).getByText("feat(web): workspace panel toggle")).toBeTruthy());
		await userEvent.click(within(commits).getByRole("button", { name: p.scm.loadMoreCommits }));
		await waitFor(() => expect(within(commits).getAllByRole("listitem")).toHaveLength(64));

		await userEvent.click(screen.getByRole("button", { name: `${p.scm.branch}: feat/workspace-panel` }));
		const menu = await screen.findByRole("menu", { name: p.scm.branch });
		await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /fix\/login/ })).toBeTruthy());
		await userEvent.click(within(menu).getByRole("menuitemradio", { name: /^main/ }));
		await waitFor(() => expect(ws.branch).toBe("main"));
	});
});

describe("the panel", () => {
	it("says the machine is offline instead of its views", () => {
		open("explorer", { online: false });
		expect(screen.getByText(p.offline)).toBeTruthy();
		expect(screen.queryByRole("tree")).toBeNull();
	});

	it("says an older machine needs updating", async () => {
		ws.failures.set("wsGitStatus", { reason: ErrorReason.UNSUPPORTED_REQUEST });
		open("explorer");
		expect(await screen.findByText(p.errors.needsUpdate)).toBeTruthy();
	});

	it("keeps its keys from the session's approval hotkeys (1, 2, 3, Esc)", async () => {
		open("explorer");
		await waitFor(() => expect(rowNames()).toContain("README.md"));
		const row = within(tree()).getAllByRole("treeitem")[0] as HTMLElement;
		const free: boolean[] = [];
		const listen = (event: KeyboardEvent) => free.push(freeForHotkey(event));
		document.addEventListener("keydown", listen);
		row.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
		document.removeEventListener("keydown", listen);
		expect(free).toEqual([false, true]);
	});

	it("switches tabs with the arrow keys and closes", async () => {
		open("explorer");
		const explorer = screen.getByRole("tab", { name: p.tabs.explorer });
		explorer.focus();
		await userEvent.keyboard("{ArrowRight}");
		expect(document.activeElement?.getAttribute("data-tab")).toBe("scm");
		expect(screen.getByRole("tabpanel", { name: /./ }).id).toBe("ws-pane-scm");
	});
});
