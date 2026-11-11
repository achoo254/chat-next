// A project in the AI Agent column (tunelo 2.0.7+): every session lives in
// one (a folder on one of the user's machines, as in Orca). Its git branch
// and changed files, the machine's name when the user has several, what
// needs the user or runs in it, "+" that opens an empty session there at once
// with the project's defaults in the mode last used on the machine (chat or
// terminal; no dialog), a menu (a custom new session, rename, pin, move,
// settings, remove), its sessions below. Dimmed while its machine is offline. The dialogs load when opened.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { type Project } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { navigate } from "../router.tsx";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { useCollapsed } from "./use-collapsed.ts";
import { NewSession } from "./new-session.tsx";
import type { ProjectHost } from "./project-dialogs.tsx";
import { gitLine } from "./projects-view.ts";
import { sessionPath, terminalOffered } from "./session-mode.tsx";
import { aiName } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

const dialogs = () => import("./project-dialogs.tsx");
const AddProjectOnHost = lazy(() => dialogs().then((m) => ({ default: m.AddProjectOnHost })));
const ProjectSettingsDialog = lazy(() => dialogs().then((m) => ({ default: m.ProjectSettingsDialog })));
const RenameProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.RenameProjectDialog })));
const RemoveProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.RemoveProjectDialog })));

type Dialog = "custom" | "rename" | "settings" | "remove" | null;

interface ProjectProps {
	machine: string;
	machineName: string;
	link: MachineLink;
	state: LinkState;
	project: Project;
	/** Ids in the machine's order, for moving this one. */
	order: readonly string[];
	online: boolean;
	/** The machine's name, shown when the user has more than one. */
	host?: string | undefined;
	/** Why the project cannot be used now (its machine is offline, …); "" when it can. */
	offline?: string;
	/** Sessions waiting for the user, and whether one runs. */
	need?: number;
	running?: boolean;
	children: ReactNode;
}

export function ProjectSection({ machine, machineName, link, state, project, order, online, host, offline = "", need = 0, running = false, children }: ProjectProps) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const { open, setOpen, ref } = usePopover();
	const [dialog, setDialog] = useState<Dialog>(null);
	const [starting, setStarting] = useState(false);
	const [collapsed, toggleCollapsed] = useCollapsed(`project:${machine}:${project.id}`);
	const ai = aiName(state.info, "claude");
	const line = offline !== "" ? offline : project.missing ? p.missing : gitLine(project, p.changed);
	const at = order.indexOf(project.id);
	const move = (step: number) => {
		const ids = [...order];
		const other = ids[at + step];
		if (other === undefined) return;
		ids[at + step] = project.id;
		ids[at] = other;
		link.request({ case: "projectReorder", value: { ids } }).catch(() => undefined);
	};
	/**
	 * "+": an empty session right away with the project's defaults, waiting for
	 * what the user types; anything to ask first goes through the dialog (as
	 * does a machine before tunelo 2.0.9, which refuses a session with no message).
	 */
	const quickStart = () => {
		if (project.sensitive) return setDialog("custom");
		setStarting(true);
		const d = project.defaults;
		link
			.request({
				case: "threadCreate",
				value: {
					provider: "claude",
					model: d?.model ?? "",
					dir: project.dir,
					text: "",
					consent: { sensitive: false, projectSettings: d?.projectSettings ?? false, trustProject: false },
					permissionMode: d?.permissionMode ?? "",
				},
			})
			.then(
				(frame) => {
					setStarting(false);
					const thread = frame.body.case === "threadCreated" ? frame.body.value.thread : undefined;
					if (thread !== undefined) navigate(sessionPath(machine, thread.id, terminalOffered(state.info, thread.provider)));
				},
				() => {
					setStarting(false);
					setDialog("custom");
				},
			);
	};
	const item = (label: string, icon: Parameters<typeof Icon>[0]["name"], onClick: () => void, disabled = false) => (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={() => {
				setOpen(false);
				onClick();
			}}
		>
			<Icon name={icon} small />
			<span>{label}</span>
		</button>
	);
	return (
		<div className="mx-project" data-missing={project.missing ? "" : undefined} data-offline={offline !== "" ? "" : undefined}>
			<div className="mx-project-head" ref={ref}>
				<button
					type="button"
					className="icon-btn mx-fold"
					aria-expanded={!collapsed}
					aria-label={collapsed ? t.agent.expand(project.name) : t.agent.collapse(project.name)}
					onClick={toggleCollapsed}
				>
					<MachineIcon name={collapsed ? "chevron-right" : "chevron-down"} small />
				</button>
				<span className="mx-project-name" title={project.dir}>
					<MachineIcon name={project.pinned ? "star" : "folder"} small />
					<span className="mx-project-title">
						<b>{project.name}</b>
						{host !== undefined && <span className="mx-host">{host}</span>}
						{need > 0 ? (
							<span className="badge" aria-label={t.sessions.waiting(need)}>
								{need}
							</span>
						) : (
							running && <span className="mx-run-dot" role="img" aria-label={t.sessions.state.running} />
						)}
					</span>
					{line !== "" && (
						<small>
							{project.git?.git === true && !project.missing && <MachineIcon name="branch" small />}
							{line}
						</small>
					)}
				</span>
				<button type="button" className="icon-btn" aria-label={t.agent.newSession} title={p.newHere(project.name)} disabled={!online || project.missing || starting} onClick={quickStart}>
					{starting ? <span className="spin" aria-hidden="true" /> : <Icon name="plus" small />}
				</button>
				<button type="button" className="icon-btn" aria-label={p.menu(project.name)} aria-haspopup="menu" aria-expanded={open} disabled={!online} onClick={() => setOpen((v) => !v)}>
					<Icon name="dots" small />
				</button>
				{open && (
					<div className="mx-menu" role="menu" aria-label={p.menu(project.name)}>
						{item(p.newCustom, "plus", () => setDialog("custom"), project.missing)}

						{item(p.rename, "edit", () => setDialog("rename"))}
						{item(project.pinned ? p.unpin : p.pin, "pin", () => {
							link.request({ case: "projectUpdate", value: { id: project.id, pinned: !project.pinned } }).catch(() => undefined);
						})}
						{item(p.moveUp, "arrow-down", () => move(-1), at <= 0)}
						{item(p.moveDown, "arrow-down", () => move(1), at < 0 || at >= order.length - 1)}
						{item(p.settings, "settings", () => setDialog("settings"))}
						<hr />
						{item(p.remove, "trash", () => setDialog("remove"))}
					</div>
				)}
			</div>
			{!collapsed && children}
			{dialog === "custom" && <NewSession machine={machine} name={machineName} link={link} state={state} project={project} onClose={() => setDialog(null)} />}
			<Suspense fallback={null}>
				{dialog === "rename" && <RenameProjectDialog link={link} project={project} ai={ai} onClose={() => setDialog(null)} />}
				{dialog === "settings" && <ProjectSettingsDialog link={link} project={project} state={state} ai={ai} onClose={() => setDialog(null)} />}
				{dialog === "remove" && <RemoveProjectDialog link={link} project={project} ai={ai} onClose={() => setDialog(null)} />}
			</Suspense>
		</div>
	);
}

/**
 * "Thêm dự án" on one of `hosts` (the machines that take projects now); the
 * dialog loads when opened. `compact`: an icon button.
 */
export function AddProject({ hosts, initialRef, initialDir, compact = false }: { hosts: readonly ProjectHost[]; initialRef?: string; initialDir?: string; compact?: boolean }) {
	const t = useMachinesCopy();
	const [open, setOpen] = useState(false);
	const label = t.agent.projects.add;
	return (
		<>
			<button
				type="button"
				className={compact ? "icon-btn" : "btn btn-sm"}
				aria-label={label}
				title={label}
				disabled={hosts.length === 0}
				onClick={() => setOpen(true)}
				data-id="add-project"
			>
				<Icon name="plus" small />
				{!compact && label}
			</button>
			{open && (
				<Suspense fallback={null}>
					<AddProjectOnHost hosts={hosts} {...(initialRef !== undefined ? { initialRef } : {})} {...(initialDir !== undefined ? { initialDir } : {})} onClose={() => setOpen(false)} />
				</Suspense>
			)}
		</>
	);
}
