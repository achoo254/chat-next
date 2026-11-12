// The projects in the AI Agent column, as Orca lays them out but calmer: a
// project row (folder icon, bold name, the state of the most urgent of its
// workspaces, "⋮" on hover), folded unless it is the selected one or
// something in it needs the user or runs; its workspaces, each titled by its
// git branch with the folder under it ("primary" on the main checkout, the
// machine's short name always on the right), "+" for a new session in the
// mode last used and a menu; under each its three newest sessions and "Xem
// thêm". An empty project offers "Thêm workspace". At the bottom, folded,
// "Chưa phân loại (n)": folders whose sessions no workspace holds, each
// offering "Tạo dự án", "Thêm vào dự án…" and "Lưu trữ tất cả phiên" (the
// group's menu archives every folder's at once); archiving only hides the
// sessions (no file is touched), so it asks nothing and offers "Hoàn tác". Rows carry data-row for the
// column's arrow keys. The dialogs load when opened.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, type Project, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { navigate } from "../router.tsx";
import type { AgentProject } from "./agent-projects-client.ts";
import type { AgentProjectsStore } from "./agent-projects-store.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { NewSession } from "./new-session.tsx";
import { folderName } from "./new-session-hints.ts";
import { adoptStarted, isNeedsConsent, knownFolder, placeByHand, splitWorkspace, workspaceRemote } from "./project-actions.ts";
import { type LooseFolder, type ProjectNode, type SeenMap, type WorkspaceLabel, type WorkspaceNode, shortHost, unseenDone, workspaceLabels } from "./project-tree.ts";
import { SessionRow, StatusGlyph } from "./session-row.tsx";
import { lastMode, modePath, terminalOffered } from "./session-mode.tsx";
import { aiName, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

const dialogs = () => import("./agent-project-dialogs.tsx");
const AddWorkspaceDialog = lazy(() => dialogs().then((m) => ({ default: m.AddWorkspaceDialog })));
const RenameProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.RenameProjectDialog })));
const LinkRepositoryDialog = lazy(() => dialogs().then((m) => ({ default: m.LinkRepositoryDialog })));
const DeleteProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.DeleteProjectDialog })));
const DetachWorkspaceDialog = lazy(() => dialogs().then((m) => ({ default: m.DetachWorkspaceDialog })));
const PickProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.PickProjectDialog })));
const ProjectSettingsDialog = lazy(() => import("./project-dialogs.tsx").then((m) => ({ default: m.ProjectSettingsDialog })));

/** Sessions a workspace shows before "Xem thêm". */
export const SHOWN_SESSIONS = 3;

/** What every row needs from the column. */
export interface TreeContext {
	readonly store: AgentProjectsStore;
	readonly projects: readonly AgentProject[];
	readonly machines: readonly MachineView[];
	readonly now: number;
	readonly seen: SeenMap;
	/** The open session: its machine ref and thread id. */
	readonly current: { readonly machine: string; readonly thread: string } | null;
}

type MenuItem = { label: string; icon: Parameters<typeof Icon>[0]["name"]; run: () => void; danger?: boolean } | null;

/** A ⋮ button with its menu. */
function RowMenu({ label, items, disabled = false }: { label: string; items: readonly MenuItem[]; disabled?: boolean }) {
	const { open, setOpen, ref } = usePopover();
	const shown = items.filter((x): x is NonNullable<MenuItem> => x !== null);
	return (
		<span className="mx-row-menu" ref={ref}>
			<button type="button" className="icon-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled || shown.length === 0} onClick={() => setOpen((v) => !v)}>
				<Icon name="dots" small />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={label}>
					{shown.map((item) => (
						<button
							key={item.label}
							type="button"
							role="menuitem"
							className={item.danger === true ? "danger" : undefined}
							onClick={() => {
								setOpen(false);
								item.run();
							}}
						>
							<Icon name={item.icon} small />
							<span>{item.label}</span>
						</button>
					))}
				</div>
			)}
		</span>
	);
}

/** The machine of a workspace or folder, always shown: its short name, the whole one on hover; dimmed while offline. */
function HostChip({ name, offline }: { name: string; offline: boolean }) {
	const t = useMachinesCopy();
	return (
		<span className="mx-host mx-ws-host" data-offline={offline ? "" : undefined} title={offline ? `${name} · ${t.agent.projects.machineOffline}` : name}>
			{shortHost(name)}
		</span>
	);
}

/** Sessions of a workspace or folder: the three newest, then "Xem thêm". */
function Sessions({ machine, threads, ctx }: { machine: MachineView; threads: readonly ThreadSummary[]; ctx: TreeContext }) {
	const t = useMachinesCopy();
	const [all, setAll] = useState(false);
	if (threads.length === 0) return null;
	const current = ctx.current?.machine === machine.entry.ref ? ctx.current.thread : null;
	// The open session always shows, even beyond the first three.
	const shown = all ? threads : threads.filter((x, i) => i < SHOWN_SESSIONS || x.id === current);
	return (
		<>
			<ul className="mx-rows">
				{shown.map((thread) => (
					<li key={thread.id}>
						<SessionRow machine={machine} thread={thread} now={ctx.now} current={thread.id === current} done={unseenDone(thread, ctx.seen)} />
					</li>
				))}
			</ul>
			{threads.length > SHOWN_SESSIONS && (
				<button type="button" className="mx-more" data-row="" aria-expanded={all} onClick={() => setAll((v) => !v)}>
					{all ? t.agent.projects.less : t.agent.projects.more(threads.length - shown.length)}
				</button>
			)}
		</>
	);
}

/** Opens a session at once in `dir` with the machine's project defaults there, in the mode last used on the machine. */
function useQuickStart(machine: MachineView | null, dir: string, local: Project | undefined, store: AgentProjectsStore, onAsk: () => void): [boolean, () => void] {
	const [starting, setStarting] = useState(false);
	const start = () => {
		if (machine === null) return;
		if (local?.sensitive === true) return onAsk();
		setStarting(true);
		const d = local?.defaults;
		const ref = machine.entry.ref;
		machine.link
			.request({
				case: "threadCreate",
				value: { provider: "claude", model: d?.model ?? "", dir, text: "", consent: { sensitive: false, projectSettings: d?.projectSettings ?? false, trustProject: false }, permissionMode: d?.permissionMode ?? "" },
			})
			.then(
				(frame) => {
					setStarting(false);
					const thread = frame.body.case === "threadCreated" ? frame.body.value.thread : undefined;
					if (thread === undefined) return;
					adoptStarted(store, { id: machine.entry.id, link: machine.link, state: machine.state }, thread.dir).catch(() => undefined);
					navigate(modePath(ref, thread.id, terminalOffered(machine.state.info, thread.provider) ? lastMode(ref) : "chat"));
				},
				() => {
					// Anything to ask first (a sensitive folder, a machine before tunelo 2.0.9): the dialog.
					setStarting(false);
					onAsk();
				},
			);
	};
	return [starting, start];
}

type WorkspaceDialog = "custom" | "settings" | "move" | "detach" | null;

function WorkspaceItem({ node, label, project, ctx }: { node: WorkspaceNode; label: WorkspaceLabel; project: AgentProject; ctx: TreeContext }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const { workspace, machine, local } = node;
	const [dialog, setDialog] = useState<WorkspaceDialog>(null);
	const name = folderName(workspace.dir);
	const machineName = machine?.entry.name ?? p.removedMachine;
	const online = !node.offline && machine !== null;
	const [starting, start] = useQuickStart(machine, workspace.dir, local, ctx.store, () => setDialog("custom"));
	const missing = local?.missing === true;
	return (
		<div className="mx-ws" data-offline={node.offline ? "" : undefined}>
			<div className="mx-ws-head" title={`${machineName} · ${workspace.dir}`}>
				<StatusGlyph status={node.status} offline={node.offline} />
				<span className="mx-ws-name">
					<span className="mx-ws-title">
						{label.byBranch && <MachineIcon name="branch" small />}
						<b>{label.title}</b>
						{label.primary && <span className="mx-ws-primary">{p.primary}</span>}
						<HostChip name={machineName} offline={!online} />
					</span>
					{(missing || label.sub !== "") && <small className={missing ? "mx-ws-sub mx-ws-missing" : "mx-ws-sub"}>{missing ? p.missing : label.sub}</small>}
				</span>
				<span className="mx-ws-acts">
				<button type="button" className="icon-btn" aria-label={p.newHere(name)} title={p.newHere(name)} disabled={!online || missing || starting} onClick={start}>
					{starting ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" small />}
				</button>
				<RowMenu
					label={p.workspaceMenu(name)}
					items={[
						online && !missing ? { label: p.newCustom, icon: "plus", run: () => setDialog("custom") } : null,
						online && local !== undefined ? { label: p.settings, icon: "settings", run: () => setDialog("settings") } : null,
						ctx.projects.length > 1 ? { label: p.move, icon: "forward", run: () => setDialog("move") } : null,
						project.workspaces.length > 1
							? {
									label: p.split,
									icon: "external",
									run: () =>
										splitWorkspace(ctx.store, workspace, workspaceRemote(machine === null ? null : { id: machine.entry.id, link: machine.link, state: machine.state }, workspace.dir)).catch((err: unknown) => console.warn("ai: could not split the workspace", err)),
								}
							: null,
						{ label: p.detach, icon: "trash", run: () => setDialog("detach"), danger: true },
					]}
				/>
				</span>
			</div>
			{machine !== null && <Sessions machine={machine} threads={node.threads} ctx={ctx} />}
			{dialog === "custom" && machine !== null && (
				<NewSession
					machine={machine.entry.ref}
					name={machine.entry.name}
					link={machine.link}
					state={machine.state}
					project={local ?? create(ProjectSchema, { name, dir: workspace.dir })}
					onStarted={(dir) => adoptStarted(ctx.store, { id: machine.entry.id, link: machine.link, state: machine.state }, dir).catch(() => undefined)}
					onClose={() => setDialog(null)}
				/>
			)}
			<Suspense fallback={null}>
				{dialog === "settings" && machine !== null && local !== undefined && (
					<ProjectSettingsDialog link={machine.link} project={local} state={machine.state} ai={aiName(machine.state.info, "claude")} onClose={() => setDialog(null)} />
				)}
				{dialog === "move" && (
					<PickProjectDialog
						title={p.moveTitle(name)}
						projects={ctx.projects.filter((x) => x.id !== project.id)}
						remote={local?.gitRemote ?? ""}
						onPick={(target) => ctx.store.change((api) => api.move(workspace.id, target.id)).then(() => undefined)}
						onClose={() => setDialog(null)}
					/>
				)}
				{dialog === "detach" && (
					<DetachWorkspaceDialog
						store={ctx.store}
						workspace={workspace}
						machineName={machineName}
						host={online ? { id: machine.entry.id, link: machine.link, state: machine.state } : null}
						onClose={() => setDialog(null)}
					/>
				)}
			</Suspense>
		</div>
	);
}

type ProjectDialog = "rename" | "link" | "delete" | "add" | null;

export function ProjectItem({ node, open, onToggle, ctx }: { node: ProjectNode; open: boolean; onToggle: () => void; ctx: TreeContext }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const { project } = node;
	const [dialog, setDialog] = useState<ProjectDialog>(null);
	const hostOf = (machineId: number) => {
		const m = ctx.machines.find((x) => x.entry.id === machineId && x.conn.kind === "on");
		return m === undefined ? null : { id: m.entry.id, link: m.link, state: m.state };
	};
	const empty = project.workspaces.length === 0;
	const labels = workspaceLabels(project.name, node.workspaces);
	const offline = node.workspaces.length > 0 && node.workspaces.every((w) => w.offline);
	return (
		<div className="mx-project" data-id="sidebar-project">
			<div className="mx-project-head">
				<button type="button" className="mx-project-toggle" data-row="" aria-expanded={open} onClick={onToggle}>
					<MachineIcon name="folder" small />
					<b>{project.name}</b>
					{node.need > 0 ? (
						<span className="badge" aria-label={t.sessions.waiting(node.need)}>
							{node.need}
						</span>
					) : (
						// The most urgent state of its workspaces; a calm project shows none.
						node.status !== "idle" && <StatusGlyph status={node.status} offline={offline} />
					)}
				</button>
				<RowMenu
					label={p.menu(project.name)}
					items={[
						{ label: p.addWorkspace, icon: "plus", run: () => setDialog("add") },
						{ label: p.rename, icon: "edit", run: () => setDialog("rename") },
						{ label: p.link, icon: "link", run: () => setDialog("link") },
						{ label: p.remove, icon: "trash", run: () => setDialog("delete"), danger: true },
					]}
				/>
			</div>
			{open &&
				(empty ? (
					<div className="mx-ws-empty">
						<p>{p.emptyProject}</p>
						<button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog("add")} data-id="project-add-workspace">
							<Icon name="plus" small />
							{p.addWorkspace}
						</button>
					</div>
				) : (
					node.workspaces.map((w) => <WorkspaceItem key={w.workspace.id} node={w} label={labels.get(w.workspace.id) ?? { title: folderName(w.workspace.dir), byBranch: false, sub: "", primary: false }} project={project} ctx={ctx} />)
				))}
			<Suspense fallback={null}>
				{dialog === "add" && <AddWorkspaceDialog store={ctx.store} project={project} machines={ctx.machines} onClose={() => setDialog(null)} />}
				{dialog === "rename" && <RenameProjectDialog store={ctx.store} project={project} onClose={() => setDialog(null)} />}
				{dialog === "link" && <LinkRepositoryDialog store={ctx.store} project={project} onClose={() => setDialog(null)} />}
				{dialog === "delete" && <DeleteProjectDialog store={ctx.store} project={project} hostOf={hostOf} onClose={() => setDialog(null)} />}
			</Suspense>
		</div>
	);
}

/** One folder of "Chưa phân loại": "Tạo dự án" in one tap (a sensitive folder asks first), "Thêm vào dự án…". */
function LooseItem({ folder, ctx, onArchive }: { folder: LooseFolder; ctx: TreeContext; onArchive: (folders: readonly LooseFolder[]) => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const { machine, dir } = folder;
	const [dialog, setDialog] = useState<"pick" | "sensitive" | null>(null);
	const [error, setError] = useState("");
	const name = folderName(dir);
	const host = { id: machine.entry.id, link: machine.link, state: machine.state };
	// The development machine has no record on the server.
	const placeable = machine.entry.id > 0 && machine.conn.kind === "on";
	const make = (sensitive: boolean) => {
		setError("");
		placeByHand(ctx.store, host, dir, { sensitive }).then(
			() => setDialog(null),
			(err: unknown) => (isNeedsConsent(err) ? setDialog("sensitive") : setError(p.saveFailed)),
		);
	};
	return (
		<div className="mx-ws">
			<div className="mx-ws-head">
				<StatusGlyph status={folder.status} offline={machine.conn.kind !== "on"} />
				<span className="mx-ws-name" title={`${machine.entry.name} · ${dir}`}>
					<span className="mx-ws-title">
						<b>{name}</b>
						<HostChip name={machine.entry.name} offline={machine.conn.kind !== "on"} />
					</span>
					<small className="mx-ws-sub">{p.sessions(folder.threads.length)}</small>
				</span>
				<span className="mx-ws-acts">
				<RowMenu
					label={p.workspaceMenu(name)}
					disabled={machine.conn.kind !== "on"}
					items={[
						placeable ? { label: p.makeProject, icon: "plus", run: () => make(false) } : null,
						placeable && ctx.projects.length > 0 ? { label: p.addToProject, icon: "forward", run: () => setDialog("pick") } : null,
						machine.conn.kind === "on" && folder.threads.length > 0 ? { label: p.archiveFolder, icon: "inbox", run: () => onArchive([folder]) } : null,
					]}
				/>
				</span>
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{dialog === "sensitive" && (
				<div className="mx-warn" role="alert">
					<p>{p.sensitiveAsk(dir)}</p>
					<button type="button" className="btn btn-sm" onClick={() => make(true)}>
						{p.addAnyway}
					</button>
				</div>
			)}
			<Sessions machine={machine} threads={folder.threads} ctx={ctx} />
			<Suspense fallback={null}>
				{dialog === "pick" && (
					<PickProjectDialog
						title={p.addToTitle(name)}
						projects={ctx.projects}
						remote={knownFolder(host, dir).remote}
						onPick={(target) => placeByHand(ctx.store, host, dir, { target }).then(() => undefined)}
						onClose={() => setDialog(null)}
					/>
				)}
			</Suspense>
		</div>
	);
}

/** "Chưa phân loại (n)", folded until opened. */
/** Archives (or brings back) every session of `folders`, each on its machine; the ids that changed. */
export async function setFoldersArchived(folders: readonly Pick<LooseFolder, "machine" | "threads">[], archived: boolean, only?: ReadonlySet<string>): Promise<string[]> {
	const done: string[] = [];
	await Promise.all(
		folders.flatMap((f) =>
			f.threads
				.filter((thread) => thread.archived !== archived && (only === undefined || only.has(thread.id)))
				.map((thread) =>
					f.machine.link.request({ case: "threadSetArchived", value: { threadId: thread.id, archived } }).then(
						() => void done.push(thread.id),
						() => undefined,
					),
				),
		),
	);
	return done;
}

/** How long "Hoàn tác" stays offered. */
export const UNDO_MS = 8_000;

export function LooseGroup({ folders, ctx, open, onToggle }: { folders: readonly LooseFolder[]; ctx: TreeContext; open: boolean; onToggle: () => void }): ReactNode {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const [undo, setUndo] = useState<{ text: string; folders: readonly LooseFolder[]; ids: ReadonlySet<string> } | null>(null);
	useEffect(() => {
		if (undo === null) return;
		const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
		return () => window.clearTimeout(timer);
	}, [undo]);
	const archive = (picked: readonly LooseFolder[]) => {
		void setFoldersArchived(picked, true).then((ids) => {
			if (ids.length > 0) setUndo({ text: p.archivedCount(ids.length), folders: picked, ids: new Set(ids) });
		});
	};
	const restore = () => {
		if (undo === null) return;
		const { folders: picked, ids } = undo;
		setUndo(null);
		// The sessions as they were before: archived now, so the filter needs no state of theirs.
		void setFoldersArchived(
			picked.map((f) => ({ machine: f.machine, threads: f.threads.map((x) => ({ ...x, archived: true })) })),
			false,
			ids,
		);
	};
	const sessions = folders.reduce((n, f) => n + f.threads.length, 0);
	const live = folders.filter((f) => f.machine.conn.kind === "on" && f.threads.length > 0);
	if (folders.length === 0 && undo === null) return null;
	return (
		<div className="mx-project mx-loose" data-id="sidebar-uncategorized">
			{folders.length > 0 && (
				<div className="mx-project-head">
					<button type="button" className="mx-project-toggle" data-row="" aria-expanded={open} onClick={onToggle}>
						<MachineIcon name={open ? "chevron-down" : "chevron-right"} small />
						<b>{p.uncategorized(folders.length)}</b>
					</button>
					<RowMenu label={p.looseMenu} items={[live.length > 0 ? { label: p.archiveAll(sessions), icon: "inbox", run: () => archive(live) } : null]} />
				</div>
			)}
			{open && folders.length > 0 && <p className="mx-loose-hint">{p.looseHint}</p>}
			{open && folders.map((f) => <LooseItem key={`${f.machine.entry.ref}\n${f.dir}`} folder={f} ctx={ctx} onArchive={archive} />)}
			{undo !== null && (
				<div className="mx-undo" role="status" data-id="sidebar-undo">
					<span className="grow">{undo.text}</span>
					<button type="button" className="btn btn-sm" onClick={restore}>
						{p.undo}
					</button>
				</div>
			)}
		</div>
	);
}
