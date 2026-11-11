// The projects in the AI Agent column: a project row (folded unless it is
// the selected one or something in it needs the user or runs), its
// workspaces (folder name, git branch, a state dot, the machine's name only
// when the project spans two machines or more, "+" for a new session in the
// mode last used, a menu), each with its three newest sessions and "Xem
// thêm". An empty project offers "Thêm workspace". At the bottom, folded,
// "Chưa phân loại (n)": folders whose sessions no workspace holds, each
// offering "Tạo dự án" and "Thêm vào dự án…". The dialogs load when opened.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { create } from "@bufbuild/protobuf";
import { ProjectSchema, type Project, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { navigate } from "../router.tsx";
import type { AgentProject } from "./agent-projects-client.ts";
import type { AgentProjectsStore } from "./agent-projects-store.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { NewSession } from "./new-session.tsx";
import { folderName } from "./new-session-hints.ts";
import { adoptStarted, isNeedsConsent, knownFolder, placeByHand } from "./project-actions.ts";
import { type LooseFolder, type ProjectNode, type SeenMap, type WorkspaceNode, type WorkStatus, unseenDone } from "./project-tree.ts";
import { SessionRow } from "./session-row.tsx";
import { lastMode, modePath, terminalOffered } from "./session-mode.tsx";
import { aiName, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

const dialogs = () => import("./agent-project-dialogs.tsx");
const AddWorkspaceDialog = lazy(() => dialogs().then((m) => ({ default: m.AddWorkspaceDialog })));
const RenameProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.RenameProjectDialog })));
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

/** The state dot of a workspace or folder; "offline" lies over the last state known. */
function StatusDot({ status, offline }: { status: WorkStatus; offline: boolean }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const label = offline ? p.offlineStatus(p.status[status]) : p.status[status];
	return <span className={`mx-wdot ${status}`} data-offline={offline ? "" : undefined} role="img" aria-label={label} title={label} />;
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
				<button type="button" className="mx-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
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

function WorkspaceItem({ node, project, many, ctx }: { node: WorkspaceNode; project: AgentProject; many: boolean; ctx: TreeContext }) {
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
				<StatusDot status={node.status} offline={node.offline} />
				<span className="mx-ws-name">
					<b>{name}</b>
					{missing ? (
						<small className="mx-ws-missing">{p.missing}</small>
					) : (
						node.branch !== "" && (
							<small>
								<MachineIcon name="branch" small />
								{node.branch}
							</small>
						)
					)}
					{many && <span className="mx-host">{machineName}</span>}
				</span>
				<button type="button" className="icon-btn" aria-label={p.newHere(name)} title={p.newHere(name)} disabled={!online || missing || starting} onClick={start}>
					{starting ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" small />}
				</button>
				<RowMenu
					label={p.workspaceMenu(name)}
					items={[
						online && !missing ? { label: p.newCustom, icon: "plus", run: () => setDialog("custom") } : null,
						online && local !== undefined ? { label: p.settings, icon: "settings", run: () => setDialog("settings") } : null,
						ctx.projects.length > 1 ? { label: p.move, icon: "forward", run: () => setDialog("move") } : null,
						{ label: p.detach, icon: "trash", run: () => setDialog("detach"), danger: true },
					]}
				/>
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

type ProjectDialog = "rename" | "delete" | "add" | null;

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
	return (
		<div className="mx-project" data-id="sidebar-project">
			<div className="mx-project-head">
				<button type="button" className="mx-project-toggle" aria-expanded={open} onClick={onToggle}>
					<MachineIcon name={open ? "chevron-down" : "chevron-right"} small />
					<b>{project.name}</b>
					{node.need > 0 ? (
						<span className="badge" aria-label={t.sessions.waiting(node.need)}>
							{node.need}
						</span>
					) : (
						node.status === "running" && <span className="mx-run-dot" role="img" aria-label={t.sessions.state.running} />
					)}
				</button>
				<RowMenu
					label={p.menu(project.name)}
					items={[
						{ label: p.addWorkspace, icon: "plus", run: () => setDialog("add") },
						{ label: p.rename, icon: "edit", run: () => setDialog("rename") },
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
					node.workspaces.map((w) => <WorkspaceItem key={w.workspace.id} node={w} project={project} many={node.manyMachines} ctx={ctx} />)
				))}
			<Suspense fallback={null}>
				{dialog === "add" && <AddWorkspaceDialog store={ctx.store} project={project} machines={ctx.machines} onClose={() => setDialog(null)} />}
				{dialog === "rename" && <RenameProjectDialog store={ctx.store} project={project} onClose={() => setDialog(null)} />}
				{dialog === "delete" && <DeleteProjectDialog store={ctx.store} project={project} hostOf={hostOf} onClose={() => setDialog(null)} />}
			</Suspense>
		</div>
	);
}

/** One folder of "Chưa phân loại": "Tạo dự án" in one tap (a sensitive folder asks first), "Thêm vào dự án…". */
function LooseItem({ folder, ctx }: { folder: LooseFolder; ctx: TreeContext }) {
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
			<div className="mx-ws-head" title={`${machine.entry.name} · ${dir}`}>
				<StatusDot status={folder.status} offline={machine.conn.kind !== "on"} />
				<span className="mx-ws-name">
					<b>{name}</b>
					<small>{p.sessions(folder.threads.length)}</small>
				</span>
				<RowMenu
					label={p.workspaceMenu(name)}
					disabled={!placeable}
					items={[{ label: p.makeProject, icon: "plus", run: () => make(false) }, ctx.projects.length > 0 ? { label: p.addToProject, icon: "forward", run: () => setDialog("pick") } : null]}
				/>
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
export function LooseGroup({ folders, ctx, open, onToggle }: { folders: readonly LooseFolder[]; ctx: TreeContext; open: boolean; onToggle: () => void }): ReactNode {
	const t = useMachinesCopy();
	if (folders.length === 0) return null;
	return (
		<div className="mx-project mx-loose" data-id="sidebar-uncategorized">
			<div className="mx-project-head">
				<button type="button" className="mx-project-toggle" aria-expanded={open} onClick={onToggle}>
					<MachineIcon name={open ? "chevron-down" : "chevron-right"} small />
					<b>{t.agent.projects.uncategorized(folders.length)}</b>
				</button>
			</div>
			{open && folders.map((f) => <LooseItem key={`${f.machine.entry.ref}\n${f.dir}`} folder={f} ctx={ctx} />)}
		</div>
	);
}
