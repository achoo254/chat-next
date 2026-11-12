// A machine's workspace in memory for the right panel (Ws* requests): a
// small tree of folders and files, git's status with staged, unstaged,
// untracked and secret entries, branches and commits. It answers as tunelo
// 2.7.0 does (folders first, pages after a name, consent for discarding and
// for secret files, a detached HEAD refused without consent) and changes its
// state on writes. Shared by the unit tests, the visual harness and the e2e.
import { ErrorCode, ErrorReason, GitFileState, WsFileKind, WsGitArea, type Frame } from "@achoo254/chat-proto/remote/remote";
import type { Body } from "../machines/fake-machine.ts";

export interface FakeFile {
	readonly text?: string;
	readonly image?: Uint8Array;
	readonly binary?: boolean;
	readonly size?: number;
	readonly ignored?: boolean;
	readonly symlink?: boolean;
	readonly outside?: boolean;
	readonly secret?: boolean;
}

export interface FakeEntry {
	path: string;
	oldPath?: string;
	area: WsGitArea;
	state: GitFileState;
	added: number;
	removed: number;
	sensitive?: boolean;
}

/** A 1x1 transparent PNG. */
export const TINY_PNG = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0, 5, 0, 1, 13, 10, 45, 180, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

const PANEL_TS = `// The workspace's right panel, loaded on first open.\nimport { useState } from "react";\n\nexport default function WorkspacePanel() {\n\tconst [open, setOpen] = useState(false);\n\treturn open ? "panel" : null;\n}\n`;

/** The demo workspace: a slice of a web app's repository. */
export function demoFiles(): Map<string, FakeFile> {
	const files = new Map<string, FakeFile>([
		["README.md", { text: "# Demo app\n\nA web app with **workspaces**.\n\n- Explorer\n- Source Control\n" }],
		["package.json", { text: '{\n  "name": "demo-app",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n' }],
		["pnpm-lock.yaml", { text: "lockfileVersion: '9.0'\n", size: 412_000 }],
		["apps/web/src/machines/workspace/workspace-panel.tsx", { text: PANEL_TS }],
		["apps/web/src/machines/session-chat.tsx", { text: 'import { PanelToggle } from "./workspace/panel-toggle.tsx";\n\nexport function SessionChat() {\n\treturn <PanelToggle />;\n}\n' }],
		["apps/web/src/machines/machines.css", { text: ".mx-chat { display: flex; }\n" }],
		["apps/web/public/logo.png", { image: TINY_PNG }],
		["apps/web/public/font.woff2", { binary: true, size: 48_120 }],
		["docs/guide.md", { text: "# Guide\n\nOpen the panel with Alt+Shift+E.\n" }],
		["docs/notes/build-log.md", { text: "# Build\n\npnpm --filter @app/web build\nOK, 0 warnings\n" }],
		["node_modules/react/index.js", { text: "module.exports = {};\n", ignored: true }],
		["dist/index.html", { text: "<!doctype html>\n", ignored: true }],
		["link-to-home", { symlink: true, outside: true }],
		[".gitignore", { text: "node_modules\ndist\n" }],
		[".env.local", { text: "TOKEN=x\n", secret: true }],
	]);
	for (let i = 1; i <= 620; i++) files.set(`fixtures/case-${i}.json`, { text: `{ "case": ${i} }\n` });
	return files;
}

export function demoStatus(): FakeEntry[] {
	return [
		{ path: "apps/web/src/machines/workspace/workspace-panel.tsx", area: WsGitArea.STAGED, state: GitFileState.ADDED, added: 7, removed: 0 },
		{ path: "apps/web/src/machines/session-chat.tsx", area: WsGitArea.STAGED, state: GitFileState.MODIFIED, added: 24, removed: 2 },
		{ path: "docs/guide.md", oldPath: "docs/right-panel.md", area: WsGitArea.STAGED, state: GitFileState.RENAMED, added: 1, removed: 1 },
		{ path: "apps/web/src/machines/session-chat.tsx", area: WsGitArea.UNSTAGED, state: GitFileState.MODIFIED, added: 3, removed: 1 },
		{ path: "package.json", area: WsGitArea.UNSTAGED, state: GitFileState.MODIFIED, added: 1, removed: 1 },
		{ path: "apps/web/src/legacy-styles.css", area: WsGitArea.UNSTAGED, state: GitFileState.DELETED, added: 0, removed: 38 },
		{ path: "docs/notes/build-log.md", area: WsGitArea.UNTRACKED, state: GitFileState.UNTRACKED, added: 0, removed: 0 },
		{ path: ".env.local", area: WsGitArea.UNTRACKED, state: GitFileState.UNTRACKED, added: 0, removed: 0, sensitive: true },
	];
}

type Value<K> = Extract<Frame["body"], { case: K }> extends { value: infer V } ? V : never;

const fail = (reason: ErrorReason, subject = "", code = ErrorCode.INVALID): Body[] => [{ case: "error", value: { code, message: `refused (${reason})`, reason, subject } }];

/** Natural order ("case-9" before "case-10"). */
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export class FakeWorkspace {
	files = demoFiles();
	entries = demoStatus();
	branch = "feat/workspace-panel";
	head = "4f1c2a9e8d7b6c5a4f3e2d1c0b9a8f7e6d5c4b3a";
	upstream: { name: string; ahead: number; behind: number } | undefined = { name: "origin/feat/workspace-panel", ahead: 2, behind: 1 };
	locals = ["feat/workspace-panel", "main"];
	commits = Array.from({ length: 64 }, (_, i) => ({
		oid: (i + 1).toString(16).padStart(40, "a"),
		subject: i === 0 ? "feat(web): workspace panel toggle" : `chore: step ${64 - i}`,
		author: "Demo Dev",
		at: BigInt(Date.UTC(2026, 10, 12, 9) - i * 3_600_000),
		refs: i === 0 ? ["HEAD -> feat/workspace-panel", "origin/feat/workspace-panel"] : i === 5 ? ["origin/main", "main"] : [],
	}));
	/** Requests that fail with this reason (by request case), once each. */
	readonly failures = new Map<string, { reason: ErrorReason; subject?: string }>();
	/** Requests received, by case. */
	readonly seen: Frame["body"][] = [];
	watching = false;

	constructor(readonly id = "pr1") {}

	private status(): Body[] {
		const entries = this.entries.map((e) => ({ path: e.path, oldPath: e.oldPath ?? "", area: e.area, state: e.state, added: e.added, removed: e.removed, binary: false, sensitive: e.sensitive ?? false }));
		return [{ case: "wsGitStatusResult", value: { workspaceId: this.id, git: true, branch: this.branch, head: this.head, ...(this.upstream === undefined ? {} : { upstream: this.upstream }), entries, truncated: false } }];
	}

	/** The git mark of a path: its own entry, or a folder's from the entries below it. */
	private gitOf(path: string, dir: boolean): GitFileState {
		if (!dir) return this.entries.find((e) => e.path === path)?.state ?? GitFileState.UNSPECIFIED;
		const below = this.entries.filter((e) => e.path.startsWith(`${path}/`));
		if (below.length === 0) return GitFileState.UNSPECIFIED;
		return below.every((e) => e.area === WsGitArea.UNTRACKED) ? GitFileState.UNTRACKED : GitFileState.MODIFIED;
	}

	private list(v: Value<"wsDirList">): Body[] {
		const prefix = v.path === "" ? "" : `${v.path}/`;
		const children = new Map<string, boolean>();
		for (const [path, file] of this.files) {
			if (!path.startsWith(prefix) || file.secret === true) continue;
			const rest = path.slice(prefix.length);
			const name = rest.split("/")[0] ?? rest;
			if (!v.showHidden && name.startsWith(".")) continue;
			if (v.hideIgnored && file.ignored === true) continue;
			children.set(name, (children.get(name) ?? false) || rest.includes("/"));
		}
		const sorted = [...children.entries()].sort(([a, ad], [b, bd]) => (ad === bd ? natural.compare(a, b) : ad ? -1 : 1));
		let start = 0;
		if (v.afterName !== "") start = sorted.findIndex(([name, dir]) => name === v.afterName && dir === v.afterDir) + 1;
		const limit = v.limit === 0 ? 500 : Math.min(2000, v.limit);
		const page = sorted.slice(start, start + limit);
		const entries = page.map(([name, dir]) => {
			const path = `${prefix}${name}`;
			const file = this.files.get(path);
			const ignored = dir ? [...this.files.entries()].some(([p, f]) => p.startsWith(`${path}/`) && f.ignored === true) : file?.ignored === true;
			return { name, dir, symlink: file?.symlink ?? false, outside: file?.outside ?? false, size: BigInt(file?.size ?? file?.text?.length ?? 0), mtime: 0n, ignored, git: this.gitOf(path, dir) };
		});
		return [{ case: "wsDirListResult", value: { workspaceId: this.id, path: v.path, entries, hasMore: start + limit < sorted.length, total: sorted.length } }];
	}

	private read(v: Value<"wsFileRead">): Body[] {
		const file = this.files.get(v.path);
		if (file === undefined) return fail(ErrorReason.UNSPECIFIED, "", ErrorCode.NOT_FOUND);
		if (file.secret === true) return fail(ErrorReason.SECRET_FILE);
		if (file.outside === true) return fail(ErrorReason.PATH_OUTSIDE_FOLDER);
		const base = { workspaceId: this.id, path: v.path, mtime: 0n };
		if (file.image !== undefined) return [{ case: "wsFileReadResult", value: { ...base, kind: WsFileKind.IMAGE, size: BigInt(file.image.length), mime: "image/png", data: file.image } }];
		if (file.binary === true) return [{ case: "wsFileReadResult", value: { ...base, kind: WsFileKind.BINARY, size: BigInt(file.size ?? 0) } }];
		if ((file.size ?? 0) > 1024 * 1024) return [{ case: "wsFileReadResult", value: { ...base, kind: WsFileKind.TOO_LARGE, size: BigInt(file.size ?? 0) } }];
		return [{ case: "wsFileReadResult", value: { ...base, kind: WsFileKind.TEXT, size: BigInt(file.text?.length ?? 0), text: file.text ?? "" } }];
	}

	private filePaths(): string[] {
		return [...this.files.entries()].filter(([, f]) => f.secret !== true && f.ignored !== true && f.symlink !== true).map(([p]) => p);
	}

	private diff(v: Value<"wsGitDiff">): Body[] {
		const entry = this.entries.find((e) => e.path === v.path);
		if (entry?.sensitive === true) return [{ case: "wsGitDiffResult", value: { workspaceId: this.id, file: { path: v.path, state: entry.state, sensitive: true } } }];
		const lines = Array.from({ length: 6 }, (_, i) => (i % 2 === 0 ? `+added line ${i + 1}` : ` context ${i + 1}`));
		const unified = `--- a/${v.path}\n+++ b/${v.path}\n@@ -1,3 +1,6 @@\n${lines.join("\n")}\n-removed line\n`;
		return [{ case: "wsGitDiffResult", value: { workspaceId: this.id, file: { path: v.path, state: entry?.state ?? GitFileState.MODIFIED, added: 3, removed: 1, unified } } }];
	}

	private stage(v: Value<"wsGitStage">): Body[] {
		const targets = this.entries.filter((e) => e.area !== WsGitArea.STAGED && (v.all || v.paths.includes(e.path)));
		const secret = targets.filter((e) => e.sensitive === true && !v.confirmSensitive.includes(e.path)).map((e) => e.path);
		if (secret.length > 0) return fail(ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, secret.join("\n"), ErrorCode.NEEDS_CONSENT);
		for (const e of targets) {
			const staged = this.entries.find((x) => x.path === e.path && x.area === WsGitArea.STAGED);
			if (staged !== undefined) {
				staged.added += e.added;
				staged.removed += e.removed;
				this.entries = this.entries.filter((x) => x !== e);
			} else {
				if (e.area === WsGitArea.UNTRACKED) e.state = GitFileState.ADDED;
				e.area = WsGitArea.STAGED;
			}
		}
		return this.status();
	}

	private unstage(v: Value<"wsGitUnstage">): Body[] {
		for (const e of this.entries.filter((x) => x.area === WsGitArea.STAGED && (v.all || v.paths.includes(x.path)))) {
			const added = e.state === GitFileState.ADDED;
			e.area = added ? WsGitArea.UNTRACKED : WsGitArea.UNSTAGED;
			if (added) e.state = GitFileState.UNTRACKED;
		}
		return this.status();
	}

	private commit(v: Value<"wsGitCommit">): Body[] {
		if (v.message.trim() === "") return fail(ErrorReason.EMPTY_MESSAGE);
		if (this.branch === "" && !v.allowDetached) return fail(ErrorReason.GIT_DETACHED_HEAD);
		const staged = this.entries.filter((e) => e.area === WsGitArea.STAGED);
		const secret = staged.filter((e) => e.sensitive === true && !v.confirmSensitive.includes(e.path)).map((e) => e.path);
		if (secret.length > 0) return fail(ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED, secret.join("\n"), ErrorCode.NEEDS_CONSENT);
		this.entries = this.entries.filter((e) => e.area !== WsGitArea.STAGED);
		const oid = `${this.commits.length + 1}`.padStart(40, "c");
		const entry = { oid, subject: v.message.split("\n")[0] ?? "", author: "Demo Dev", at: BigInt(Date.now()), refs: [] };
		this.commits = [entry, ...this.commits];
		this.head = oid;
		if (this.upstream !== undefined) this.upstream = { ...this.upstream, ahead: this.upstream.ahead + 1 };
		return [{ case: "wsGitCommitResult", value: { workspaceId: this.id, commit: entry } }];
	}

	/** The answer to a workspace request; undefined for any other request. */
	handle(frame: Frame): Body[] | undefined {
		const b = frame.body;
		if (b.case === undefined || !b.case.startsWith("ws")) return undefined;
		this.seen.push(b);
		const failure = this.failures.get(b.case);
		if (failure !== undefined) {
			this.failures.delete(b.case);
			return fail(failure.reason, failure.subject ?? "", failure.reason === ErrorReason.DISCARD_NOT_CONFIRMED ? ErrorCode.NEEDS_CONSENT : ErrorCode.INVALID);
		}
		const ws = this.id;
		switch (b.case) {
			case "wsDirList":
				return this.list(b.value);
			case "wsFileRead":
				return this.read(b.value);
			case "wsFindNames": {
				const words = b.value.query.toLowerCase().split(/\s+/).filter(Boolean);
				const paths = words.length === 0 ? [] : this.filePaths().filter((p) => words.every((w) => p.toLowerCase().includes(w)));
				paths.sort((a, c) => a.length - c.length);
				const limit = b.value.limit === 0 ? 100 : Math.min(500, b.value.limit);
				return [{ case: "wsFindNamesResult", value: { workspaceId: ws, paths: paths.slice(0, limit), truncated: paths.length > limit } }];
			}
			case "wsFindContents": {
				const q = b.value.caseSensitive ? b.value.query : b.value.query.toLowerCase();
				const files = this.filePaths().flatMap((path) => {
					const lines = (this.files.get(path)?.text ?? "").split("\n");
					const matches = lines.flatMap((line, i) => {
						const at = (b.value.caseSensitive ? line : line.toLowerCase()).indexOf(q);
						return at < 0 ? [] : [{ line: i + 1, column: at + 1, text: line }];
					});
					return matches.length === 0 ? [] : [{ path, matches }];
				});
				return [{ case: "wsFindContentsResult", value: { workspaceId: ws, files, totalMatches: files.reduce((n, f) => n + f.matches.length, 0), truncated: false, timedOut: false } }];
			}
			case "wsWatch":
				this.watching = b.value.on;
				return [{ case: "ack", value: {} }];
			case "wsGitStatus":
				return this.status();
			case "wsGitDiff":
				return this.diff(b.value);
			case "wsGitStage":
				return this.stage(b.value);
			case "wsGitUnstage":
				return this.unstage(b.value);
			case "wsGitDiscard":
				if (!b.value.confirm) return fail(ErrorReason.DISCARD_NOT_CONFIRMED, "", ErrorCode.NEEDS_CONSENT);
				this.entries = this.entries.filter((e) => !(b.value.paths.includes(e.path) && (e.area === WsGitArea.UNSTAGED || e.area === WsGitArea.UNTRACKED)));
				return this.status();
			case "wsGitCommit":
				return this.commit(b.value);
			case "wsGitBranches":
				return [{ case: "wsGitBranchesResult", value: { workspaceId: ws, current: this.branch, local: this.locals.map((name) => ({ name, upstream: `origin/${name}`, ahead: name === this.branch ? (this.upstream?.ahead ?? 0) : 0, behind: 0 })), remote: ["origin/main", "origin/feat/workspace-panel", "origin/fix/login"] } }];
			case "wsGitCheckout":
				this.branch = b.value.branch;
				if (!this.locals.includes(b.value.branch)) this.locals.push(b.value.branch);
				return this.status();
			case "wsGitBranchCreate":
				if (/\s/.test(b.value.name) || b.value.name === "") return fail(ErrorReason.NAME_INVALID);
				this.branch = b.value.name;
				this.locals.push(b.value.name);
				this.upstream = undefined;
				return this.status();
			case "wsGitFetch":
				return this.status();
			case "wsGitPull":
				if (this.upstream !== undefined) this.upstream = { ...this.upstream, behind: 0 };
				return this.status();
			case "wsGitPush":
				this.upstream = { name: `origin/${this.branch}`, ahead: 0, behind: this.upstream?.behind ?? 0 };
				return this.status();
			case "wsGitLog": {
				const limit = b.value.limit === 0 ? 50 : Math.min(50, b.value.limit);
				const page = this.commits.slice(b.value.skip, b.value.skip + limit);
				return [{ case: "wsGitLogResult", value: { workspaceId: ws, commits: page, hasMore: b.value.skip + limit < this.commits.length } }];
			}
			case "wsGitBranchCompare":
				return [
					{
						case: "wsGitBranchCompareResult",
						value: {
							workspaceId: ws,
							base: "origin/main",
							mergeBase: "b".repeat(40),
							ahead: 5,
							behind: 1,
							files: [
								{ path: "apps/web/src/machines/workspace/panel-toggle.tsx", area: WsGitArea.STAGED, state: GitFileState.ADDED, added: 120, removed: 0 },
								{ path: "apps/web/src/machines/machines.css", area: WsGitArea.STAGED, state: GitFileState.MODIFIED, added: 2, removed: 0 },
							],
							truncated: false,
						},
					},
				];
			case "wsGitPrUrl":
				return [{ case: "wsGitPrUrlResult", value: { workspaceId: ws, url: `https://github.com/example/demo-app/compare/main...${encodeURIComponent(this.branch)}?expand=1`, provider: "github" } }];
			default:
				return [{ case: "ack", value: {} }];
		}
	}
}
