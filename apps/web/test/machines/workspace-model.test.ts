// The workspace panel's plain logic: the Explorer's tree (pages, open
// folders, rows, the keys as in Orca and VS Code), Source Control's grouping
// of git's status, the wording of refusals, the remembered place of the
// panel and its shortcuts, name search narrowing, long diffs, safe PR pages.
import { create } from "@bufbuild/protobuf";
import { ErrorCode, ErrorReason, GitFileState, WsEntrySchema, WsGitArea, WsGitEntrySchema } from "@achoo254/chat-proto/remote/remote";
import { describe, expect, it } from "vitest";
import { enMachines } from "../../src/machines/copy-en.ts";
import { OfflineError, RemoteError } from "../../src/machines/link/machine-link.ts";
import { applyPage, failLoading, loadedOpenDirs, nextCursor, startLoading, treeKey, visibleRows, type Dirs } from "../../src/machines/workspace/explorer/tree-model.ts";
import { filterNames, narrows } from "../../src/machines/workspace/explorer/use-find.ts";
import { fileFamily } from "../../src/machines/workspace/explorer/file-icon.tsx";
import { gitMark } from "../../src/machines/workspace/git-marks.ts";
import { enPanel } from "../../src/machines/workspace/panel-copy-en.ts";
import { viPanel } from "../../src/machines/workspace/panel-copy-vi.ts";
import { zhCNPanel } from "../../src/machines/workspace/panel-copy-zh-CN.ts";
import { clampWidth, parsePrefs, PANEL_WIDTH } from "../../src/machines/workspace/panel-prefs.ts";
import { panelShortcut, workspaceOf } from "../../src/machines/workspace/panel-toggle.tsx";
import { widthForKey } from "../../src/machines/workspace/resize-handle.tsx";
import { remoteChoices } from "../../src/machines/workspace/scm/branch-bar.tsx";
import { isCommitKey } from "../../src/machines/workspace/scm/commit-box.tsx";
import { discardKinds, groupStatus, limitGroups, sensitivePaths, stagedEntries, unstagedEntries } from "../../src/machines/workspace/scm/status-model.ts";
import { prPage } from "../../src/machines/workspace/scm/use-history.ts";
import { clipDiff } from "../../src/machines/workspace/viewer/diff-view.tsx";
import { formatSize } from "../../src/machines/workspace/viewer/format.ts";
import { isDetachedRefusal, needsAgentUpdate, unconfirmedSensitive, wsErrorText } from "../../src/machines/workspace/ws-errors.ts";

const entry = (name: string, dir = false) => create(WsEntrySchema, { name, dir });
const page = (path: string, names: string[], hasMore = false, total = names.length) => ({ path, entries: names.map((n) => entry(n.replace(/\/$/, ""), n.endsWith("/"))), hasMore, total });

describe("the Explorer's tree", () => {
	it("keeps a folder's entries while it reads it again, and adds later pages after the first", () => {
		let dirs: Dirs = new Map();
		dirs = startLoading(dirs, "");
		expect(visibleRows(dirs, new Set()).map((r) => r.kind)).toEqual(["loading"]);
		dirs = applyPage(dirs, page("", ["apps/", "docs/", "a.ts", "b.ts"], true, 6), false);
		expect(nextCursor(dirs.get(""))).toEqual({ afterName: "b.ts", afterDir: false });
		dirs = applyPage(dirs, page("", ["b.ts", "c.ts", "d.ts"]), true);
		expect(dirs.get("")?.entries.map((e) => e.name)).toEqual(["apps", "docs", "a.ts", "b.ts", "c.ts", "d.ts"]);
		// A refresh keeps what shows until the answer arrives.
		dirs = startLoading(dirs, "");
		expect(visibleRows(dirs, new Set()).filter((r) => r.kind === "entry")).toHaveLength(6);
		// A first page replaces the folder.
		dirs = applyPage(dirs, page("", ["apps/"]), false);
		expect(dirs.get("")?.entries.map((e) => e.name)).toEqual(["apps"]);
	});

	it("shows open folders beneath their row, a load-more row and the state of a folder", () => {
		let dirs: Dirs = new Map();
		dirs = applyPage(dirs, page("", ["apps/", "docs/", "README.md"]), false);
		dirs = applyPage(dirs, page("apps", ["web/", "x.ts"], true, 9), false);
		dirs = startLoading(dirs, "apps/web");
		dirs = failLoading(dirs, "docs", new OfflineError());
		const rows = visibleRows(dirs, new Set(["apps", "apps/web", "docs"]));
		expect(rows.map((r) => `${r.depth}:${r.kind}:${r.kind === "entry" ? r.path : r.parent}`)).toEqual([
			"0:entry:apps",
			"1:entry:apps/web",
			"2:loading:apps/web",
			"1:entry:apps/x.ts",
			"1:more:apps",
			"0:entry:docs",
			"1:error:docs",
			"0:entry:README.md",
		]);
		const more = rows[4];
		expect(more?.kind === "more" ? [more.shown, more.total] : null).toEqual([2, 9]);
		// Only folders that are open (and whose parents are) are read again after a change.
		expect(loadedOpenDirs(dirs, new Set(["apps", "docs"])).sort()).toEqual(["", "apps", "docs"]);
		expect(loadedOpenDirs(dirs, new Set(["apps/web"]))).toEqual([""]);
	});

	it("moves and opens with the keys as Orca does", () => {
		let dirs: Dirs = new Map();
		dirs = applyPage(dirs, page("", ["src/", "README.md"]), false);
		dirs = applyPage(dirs, page("src", ["main.ts"], true, 3), false);
		const closed = visibleRows(dirs, new Set());
		const open = new Set(["src"]);
		const rows = visibleRows(dirs, open);
		// Right opens a closed folder, then steps into it; left steps out, then closes.
		expect(treeKey(closed, 0, "ArrowRight", new Set())).toEqual({ kind: "expand", path: "src" });
		expect(treeKey(rows, 0, "ArrowRight", open)).toEqual({ kind: "focus", index: 1 });
		expect(treeKey(rows, 1, "ArrowLeft", open)).toEqual({ kind: "focus", index: 0 });
		expect(treeKey(rows, 0, "ArrowLeft", open)).toEqual({ kind: "collapse", path: "src" });
		expect(treeKey(closed, 1, "ArrowLeft", new Set())).toBeNull();
		// Up, down, Home, End stay within the rows.
		expect(treeKey(rows, 0, "ArrowUp", open)).toEqual({ kind: "focus", index: 0 });
		expect(treeKey(rows, 3, "ArrowDown", open)).toEqual({ kind: "focus", index: 3 });
		expect(treeKey(rows, 2, "Home", open)).toEqual({ kind: "focus", index: 0 });
		expect(treeKey(rows, 0, "End", open)).toEqual({ kind: "focus", index: rows.length - 1 });
		// Enter opens a file, toggles a folder, loads the next page on "load more".
		expect(treeKey(rows, 1, "Enter", open)).toEqual({ kind: "open", path: "src/main.ts" });
		expect(treeKey(rows, 0, "Enter", open)).toEqual({ kind: "collapse", path: "src" });
		expect(treeKey(rows, 2, "Enter", open)).toEqual({ kind: "more", dir: "src" });
		expect(treeKey(rows, 1, "x", open)).toBeNull();
	});

	it("tells file families apart for icons", () => {
		expect(["a.tsx", "b.md", "c.json", "d.png", "Makefile", "e.bin", ".env"].map(fileFamily)).toEqual(["code", "text", "data", "image", "code", "file", "file"]);
	});
});

describe("Source Control's grouping", () => {
	const g = (path: string, area: WsGitArea, state: GitFileState, sensitive = false) => create(WsGitEntrySchema, { path, area, state, sensitive });
	const entries = [
		g("src/b.ts", WsGitArea.UNSTAGED, GitFileState.MODIFIED),
		g("README.md", WsGitArea.STAGED, GitFileState.MODIFIED),
		g("src/a.ts", WsGitArea.STAGED, GitFileState.ADDED),
		g("src/b.ts", WsGitArea.STAGED, GitFileState.MODIFIED),
		g("notes/new.md", WsGitArea.UNTRACKED, GitFileState.UNTRACKED),
		g(".env", WsGitArea.UNTRACKED, GitFileState.UNTRACKED, true),
		g("merge.txt", WsGitArea.CONFLICTED, GitFileState.CONFLICTED),
	];

	it("puts conflicts, then staged, then the rest, by folder with the top folder first", () => {
		const groups = groupStatus(entries);
		expect(groups.map((x) => [x.area, x.count, x.folders.map((f) => [f.folder, f.entries.map((e) => e.path)])])).toEqual([
			["conflicted", 1, [["", ["merge.txt"]]]],
			["staged", 3, [["", ["README.md"]], ["src", ["src/a.ts", "src/b.ts"]]]],
			["unstaged", 3, [["", [".env"]], ["notes", ["notes/new.md"]], ["src", ["src/b.ts"]]]],
		]);
		// "View all": the first files in display order only.
		expect(limitGroups(groups, 3).map((x) => x.folders.flatMap((f) => f.entries.map((e) => e.path)))).toEqual([["merge.txt"], ["README.md", "src/a.ts"]]);
	});

	it("knows what a stage, a commit and a discard take in, and the secret files among them", () => {
		expect(unstagedEntries(entries).map((e) => e.path)).toEqual(["src/b.ts", "notes/new.md", ".env", "merge.txt"]);
		expect(stagedEntries(entries).map((e) => e.path)).toEqual(["README.md", "src/a.ts", "src/b.ts"]);
		expect(sensitivePaths(unstagedEntries(entries))).toEqual([".env"]);
		expect(sensitivePaths(stagedEntries(entries))).toEqual([]);
		expect(discardKinds(entries, ["src/b.ts", "notes/new.md", ".env", "README.md"])).toEqual({ untracked: 2, tracked: 1 });
	});

	it("marks each state with Orca's letter", () => {
		const labels = viPanel.explorer.git;
		const letters = [GitFileState.UNTRACKED, GitFileState.ADDED, GitFileState.MODIFIED, GitFileState.DELETED, GitFileState.RENAMED, GitFileState.CONFLICTED, GitFileState.TYPE_CHANGED].map((s) => gitMark(s, labels)?.letter);
		expect(letters).toEqual(["U", "A", "M", "D", "R", "C", "T"]);
		expect(gitMark(GitFileState.UNSPECIFIED, labels)).toBeNull();
	});
});

describe("refusals in the user's words", () => {
	const refused = (reason: ErrorReason, subject = "") => new RemoteError(ErrorCode.INVALID, "git said no", reason, subject);
	const say = (err: unknown) => wsErrorText(enPanel, enMachines, err, "Claude Code");

	it("words every reason of the panel", () => {
		const r = enMachines.errors.reasons;
		expect(say(refused(ErrorReason.SECRET_FILE))).toBe(r.secretFile);
		expect(say(refused(ErrorReason.PATH_OUTSIDE_FOLDER))).toBe(enPanel.errors.pathOutside);
		expect(say(refused(ErrorReason.FOLDER_TOO_LARGE))).toBe(r.folderTooLarge);
		expect(say(refused(ErrorReason.UNSUPPORTED_REQUEST))).toContain("Update tunelo to 2.7.0");
		expect(say(refused(ErrorReason.GIT_UNSAFE_CONFIG, "credential.helper"))).toContain("(credential.helper)");
		expect(say(refused(ErrorReason.GIT_NEEDS_CREDENTIALS))).toContain("Push from a terminal once");
		expect(say(refused(ErrorReason.GIT_FAILED, "fatal: bad object"))).toBe("git failed: fatal: bad object");
		expect(say(refused(ErrorReason.GIT_FAILED))).toBe("git failed.");
		expect(say(refused(ErrorReason.GIT_LFS_MISSING))).toContain("git-lfs");
		expect(say(refused(ErrorReason.GIT_OPERATION_IN_PROGRESS, "rebase"))).toBe("A rebase is in progress. Finish or abort it in a terminal first.");
		expect(say(refused(ErrorReason.GIT_COMMIT_SIGNING))).toContain("signs commits");
		expect(say(refused(ErrorReason.WORKSPACE_NOT_REPOSITORY_ROOT))).toBe(r.workspaceNotRepositoryRoot);
		expect(say(refused(ErrorReason.NOT_A_GIT_REPOSITORY))).toBe(r.notGitRepository);
		expect(say(refused(ErrorReason.GIT_BUSY))).toBe(r.gitBusy);
		expect(say(refused(ErrorReason.GIT_DETACHED_HEAD))).toBe(r.gitDetachedHead);
		expect(say(refused(ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED))).toBe(r.sensitiveFileNotConfirmed);
		expect(say(refused(ErrorReason.DISCARD_NOT_CONFIRMED))).toBe(r.discardNotConfirmed);
		// Others as the AI Agent screens word them; offline too.
		expect(say(refused(ErrorReason.NAME_INVALID))).toBe(r.nameInvalid);
		expect(say(new OfflineError())).toBe(enMachines.errors.offline);
	});

	it("reads the consent refusals", () => {
		expect(unconfirmedSensitive(refused(ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, ".env\nkeys/id_rsa\n"))).toEqual([".env", "keys/id_rsa"]);
		expect(unconfirmedSensitive(refused(ErrorReason.GIT_FAILED))).toBeNull();
		expect(isDetachedRefusal(refused(ErrorReason.GIT_DETACHED_HEAD))).toBe(true);
		expect(needsAgentUpdate(refused(ErrorReason.UNSUPPORTED_REQUEST))).toBe(true);
		expect(needsAgentUpdate(new OfflineError())).toBe(false);
	});

	it("has the same keys in the three languages", () => {
		const shape = (value: unknown): unknown =>
			typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v)])) : typeof value;
		expect(shape(enPanel)).toEqual(shape(viPanel));
		expect(shape(zhCNPanel)).toEqual(shape(viPanel));
	});
});

describe("the panel's place and keys", () => {
	it("reads what storage holds, and the defaults for anything else", () => {
		expect(parsePrefs(null)).toEqual({ open: false, width: PANEL_WIDTH.initial, tab: "explorer" });
		expect(parsePrefs("{bad")).toEqual({ open: false, width: PANEL_WIDTH.initial, tab: "explorer" });
		expect(parsePrefs(JSON.stringify({ open: true, width: 9999, tab: "scm" }))).toEqual({ open: true, width: PANEL_WIDTH.max, tab: "scm" });
		expect(parsePrefs(JSON.stringify({ open: "yes", width: "wide", tab: "checks" }))).toEqual({ open: false, width: PANEL_WIDTH.initial, tab: "explorer" });
		expect(clampWidth(10)).toBe(PANEL_WIDTH.min);
		expect(clampWidth(Number.NaN)).toBe(PANEL_WIDTH.initial);
	});

	it("takes Alt+Shift+E and Alt+Shift+G by physical key only", () => {
		const key = (code: string, extra: Partial<KeyboardEvent> = {}) => ({ altKey: true, shiftKey: true, ctrlKey: false, metaKey: false, code, ...extra });
		expect(panelShortcut(key("KeyE"))).toBe("explorer");
		expect(panelShortcut(key("KeyG"))).toBe("scm");
		expect(panelShortcut(key("KeyE", { ctrlKey: true }))).toBeNull();
		expect(panelShortcut(key("KeyE", { shiftKey: false }))).toBeNull();
		expect(panelShortcut(key("KeyT"))).toBeNull();
	});

	it("resizes from the keyboard: left widens (the panel is on the right)", () => {
		expect(widthForKey(340, "ArrowLeft")).toBe(356);
		expect(widthForKey(340, "ArrowRight")).toBe(324);
		expect(widthForKey(340, "Home")).toBe(PANEL_WIDTH.min);
		expect(widthForKey(340, "End")).toBe(PANEL_WIDTH.max);
		expect(widthForKey(340, "a")).toBeNull();
	});

	it("finds the deepest project holding the session's folder", () => {
		const projects = { projects: [{ id: "a", dir: "/code" }, { id: "b", dir: "/code/app" }, { id: "c", dir: "/code/app", missing: true }] } as never;
		expect(workspaceOf({ projects }, "/code/app/src")?.id).toBe("b");
		expect(workspaceOf({ projects }, "/elsewhere")).toBeUndefined();
		expect(workspaceOf({ projects: null }, "/code")).toBeUndefined();
	});

	it("commits with Cmd+Enter on Apple systems and Ctrl+Enter elsewhere", () => {
		const k = (extra: Partial<KeyboardEvent>) => ({ key: "Enter", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
		expect(isCommitKey(k({ metaKey: true }), true)).toBe(true);
		expect(isCommitKey(k({ ctrlKey: true }), true)).toBe(false);
		expect(isCommitKey(k({ ctrlKey: true }), false)).toBe(true);
		expect(isCommitKey(k({}), false)).toBe(false);
		expect(isCommitKey(k({ ctrlKey: true, shiftKey: true }), false)).toBe(false);
	});
});

describe("search, diffs and links", () => {
	it("narrows a complete name list while the user types on", () => {
		const prev = { kind: "names", query: "pan", paths: ["src/panel.tsx", "src/pane.ts", "docs/panel.md"], truncated: false } as const;
		expect(narrows(prev, "panel ts")).toBe(true);
		expect(filterNames(prev.paths, "panel ts")).toEqual(["src/panel.tsx"]);
		expect(narrows(prev, "pa")).toBe(false);
		expect(narrows({ ...prev, truncated: true }, "panel")).toBe(false);
		expect(narrows(null, "panel")).toBe(false);
	});

	it("clips a very long diff to its first lines", () => {
		const long = Array.from({ length: 5 }, (_, i) => `+${i}`).join("\n");
		expect(clipDiff(long, 3)).toEqual({ text: "+0\n+1\n+2", total: 5, clipped: true });
		expect(clipDiff(`${long}\n`, 10).clipped).toBe(false);
	});

	it("opens only https pull request pages without credentials", () => {
		expect(prPage("https://github.com/o/r/compare/main...x?expand=1")).toBe("https://github.com/o/r/compare/main...x?expand=1");
		expect(prPage("http://github.com/o/r")).toBeNull();
		expect(prPage("javascript:alert(1)")).toBeNull();
		expect(prPage("https://user:pw@gitlab.com/o/r")).toBeNull();
		expect(prPage("not a url")).toBeNull();
	});

	it("offers remote branches a local one does not have, by short name", () => {
		expect(remoteChoices({ current: "main", local: [{ name: "main" }], remote: ["origin/main", "origin/fix/a", "upstream/fix/a"] } as never)).toEqual(["fix/a"]);
	});

	it("writes sizes", () => {
		expect([formatSize(12, enPanel.units), formatSize(2048, enPanel.units), formatSize(3 * 1024 * 1024, enPanel.units)]).toEqual(["12 B", "2.0 KB", "3.0 MB"]);
	});
});
