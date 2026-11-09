// A machine's projects in the AI Agent column (tunelo 2.0.7+): each project
// with its git branch and changed files, "+" that opens a session there at
// once with the project's defaults (and the usual first message), a menu (a
// custom new session, rename, pin, move, settings, remove), its sessions
// below; then "Khác" for sessions in no project, and "Thêm làm dự án?" for
// folders that have sessions but no project. The dialogs load when opened.
import { lazy, Suspense, useState, type ReactNode } from "react";
import { type Project, type ProjectSuggestion } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { navigate, paths } from "../router.tsx";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { hintPrompt } from "./new-session-hints.ts";
import { NewSession } from "./new-session.tsx";
import { gitLine } from "./projects-view.ts";
import { aiName, folderName } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

const dialogs = () => import("./project-dialogs.tsx");
const AddProjectDialog = lazy(() => dialogs().then((m) => ({ default: m.AddProjectDialog })));
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
	children: ReactNode;
}

export function ProjectSection({ machine, machineName, link, state, project, order, online, children }: ProjectProps) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const { open, setOpen, ref } = usePopover();
	const [dialog, setDialog] = useState<Dialog>(null);
	const [starting, setStarting] = useState(false);
	const ai = aiName(state.info, "claude");
	const line = project.missing ? p.missing : gitLine(project, p.changed);
	const at = order.indexOf(project.id);
	const move = (step: number) => {
		const ids = [...order];
		const other = ids[at + step];
		if (other === undefined) return;
		ids[at + step] = project.id;
		ids[at] = other;
		link.request({ case: "projectReorder", value: { ids } }).catch(() => undefined);
	};
	/** "+": a session right away with the project's defaults; anything to ask first goes through the dialog. */
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
					text: hintPrompt(t.newSession, "summary", project.dir),
					consent: { sensitive: false, projectSettings: d?.projectSettings ?? false, trustProject: false },
					permissionMode: d?.permissionMode ?? "",
				},
			})
			.then(
				(frame) => {
					setStarting(false);
					if (frame.body.case === "threadCreated" && frame.body.value.thread !== undefined) navigate(paths.machineSession(machine, frame.body.value.thread.id));
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
		<div className="mx-project" data-missing={project.missing ? "" : undefined}>
			<div className="mx-project-head" ref={ref}>
				<span className="mx-project-name" title={project.dir}>
					<MachineIcon name={project.pinned ? "star" : "folder"} small />
					<b>{project.name}</b>
					{line !== "" && (
						<small>
							{project.git?.git === true && !project.missing && <MachineIcon name="branch" small />}
							{line}
						</small>
					)}
				</span>
				<button type="button" className="icon-btn" aria-label={p.newHere(project.name)} title={p.newHere(project.name)} disabled={!online || project.missing || starting} onClick={quickStart}>
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
			{children}
			{dialog === "custom" && <NewSession machine={machine} name={machineName} link={link} state={state} project={project} onClose={() => setDialog(null)} />}
			<Suspense fallback={null}>
				{dialog === "rename" && <RenameProjectDialog link={link} project={project} ai={ai} onClose={() => setDialog(null)} />}
				{dialog === "settings" && <ProjectSettingsDialog link={link} project={project} state={state} ai={ai} onClose={() => setDialog(null)} />}
				{dialog === "remove" && <RemoveProjectDialog link={link} project={project} ai={ai} onClose={() => setDialog(null)} />}
			</Suspense>
		</div>
	);
}

const HIDDEN_KEY = (machine: string) => `ai:project-suggestions-hidden:${machine}`;

function suggestionsHidden(machine: string): boolean {
	try {
		return window.localStorage.getItem(HIDDEN_KEY(machine)) === "1";
	} catch {
		return false;
	}
}

/** "Thêm làm dự án?": folders with sessions and no project, one tap each; hidden on this device once dismissed. */
export function ProjectSuggestions({ machine, link, suggestions }: { machine: string; link: MachineLink; suggestions: readonly ProjectSuggestion[] }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const [hidden, setHidden] = useState(() => suggestionsHidden(machine));
	const [adding, setAdding] = useState("");
	if (hidden || suggestions.length === 0) return null;
	return (
		<div className="mx-suggest-projects" role="group" aria-label={p.suggestTitle}>
			<div className="head">
				<b>{p.suggestTitle}</b>
				<button
					type="button"
					className="icon-btn"
					aria-label={p.suggestHide}
					title={p.suggestHide}
					onClick={() => {
						setHidden(true);
						try {
							window.localStorage.setItem(HIDDEN_KEY(machine), "1");
						} catch {
							// Storage off: hidden for this page only.
						}
					}}
				>
					<Icon name="x" small />
				</button>
			</div>
			<p className="muted">{p.suggestBody}</p>
			<ul>
				{suggestions.slice(0, 4).map((s) => (
					<li key={s.dir}>
						<span title={s.dir}>
							<MachineIcon name="folder" small />
							{folderName(s.dir)}
							<small>{p.sessions(s.sessions)}</small>
						</span>
						<button
							type="button"
							className="btn btn-sm"
							aria-label={p.suggestAdd(folderName(s.dir))}
							disabled={adding === s.dir}
							onClick={() => {
								setAdding(s.dir);
								link.request({ case: "projectAdd", value: { dir: s.dir, name: "" } }).finally(() => setAdding(""));
							}}
						>
							<Icon name="plus" small />
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

/** "Thêm dự án" for a machine; the dialog loads when opened. */
export function AddProject({ link, state, label }: { link: MachineLink; state: LinkState; label?: string }) {
	const t = useMachinesCopy();
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" className="btn btn-sm mx-add-project-btn" onClick={() => setOpen(true)}>
				<Icon name="plus" small />
				{label ?? t.agent.projects.add}
			</button>
			{open && (
				<Suspense fallback={null}>
					<AddProjectDialog link={link} state={state} ai={aiName(state.info, "claude")} onClose={() => setOpen(false)} />
				</Suspense>
			)}
		</>
	);
}
