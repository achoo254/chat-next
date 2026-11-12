// The dialogs of the AI Agent's projects (loaded when first opened): "Thêm
// dự án" (a name and, optionally, the git repository it links; or "Chọn thư
// mục trên máy", which makes the project and its first workspace in one
// step), "Thêm workspace" (a folder on one of the machines; the machine is
// picked only when there are several), renaming, deleting a project or
// detaching a workspace (the record only: no folder, file or session on any
// machine is touched), and picking a project to move a workspace to or to
// add a folder to. A folder of another repository than the project links is
// refused, as Orca does.
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import type { DirListResult } from "@achoo254/chat-proto/remote/remote";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { refusalOf, type AgentProject, type AgentWorkspace } from "./agent-projects-client.ts";
import type { AgentProjectsStore } from "./agent-projects-store.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { canonicalRemote, remoteMismatch, remoteUrlFor } from "./git-remote.ts";
import { OfflineError, RemoteError } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName } from "./new-session-hints.ts";
import { deleteProject, detachWorkspace, InvalidRemoteError, isNeedsConsent, linkRepository, placeByHand, RemoteMismatchError, type Host } from "./project-actions.ts";
import { FolderPicker } from "./project-dialogs.tsx";
import { errorText, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const MAX_NAME = 64;

/** What to tell the user about a failed change. */
function failText(t: MachinesCopy, err: unknown, project?: AgentProject): string {
	const p = t.agent.projects;
	if (err instanceof RemoteMismatchError) return p.mismatch(project?.gitRemote ?? p.otherRepo);
	if (err instanceof InvalidRemoteError) return p.repoInvalid;
	const refusal = refusalOf(err);
	if (refusal === "too_many_projects" || refusal === "too_many_workspaces") return p.tooMany;
	if (refusal === "invalid") return p.repoInvalid;
	if (refusal === "project_remote_exists") return p.remoteExists;
	// The machine's own refusals (a folder that cannot be read, …) come worded by machine-errors.ts.
	if (err instanceof RemoteError || err instanceof OfflineError) return errorText(t, err, "");
	return p.saveFailed;
}

const hostOf = (m: MachineView): Host => ({ id: m.entry.id, link: m.link, state: m.state });

/** Machines a folder can be picked on now: online and known to the server. */
function placeHosts(machines: readonly MachineView[]): MachineView[] {
	return machines.filter((m) => m.conn.kind === "on" && m.entry.id > 0);
}

interface FolderChoice {
	readonly machine: MachineView;
	readonly dir: string;
}

/** Machines up to this many show side by side; more open a list. */
const SEGMENTED_HOSTS = 2;

/**
 * The machine, as compact as an input: two side by side (a radio group), more
 * behind a button that opens a list (a listbox: arrows, Enter, Esc). A dot
 * left of each name says it is online; long names are cut.
 */
function HostPicker({ hosts, value, onPick }: { hosts: readonly MachineView[]; value: MachineView; onPick: (machine: MachineView) => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const labelId = useDomId("host-pick");
	const listId = useDomId("host-list");
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const name = (m: MachineView) => (
		<>
			<span className={`dot ${m.conn.kind === "on" ? "on" : "off"}`} aria-hidden="true" />
			<span className="nm">{m.entry.name}</span>
		</>
	);
	if (hosts.length <= SEGMENTED_HOSTS) {
		const move = (event: KeyboardEvent<HTMLButtonElement>, at: number) => {
			const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
			if (step === 0) return;
			event.preventDefault();
			const next = hosts[(at + step + hosts.length) % hosts.length];
			if (next !== undefined) onPick(next);
		};
		return (
			<div className="mx-field-row">
				<span id={labelId}>{p.host}</span>
				<div className="mx-host-seg" role="radiogroup" aria-labelledby={labelId} data-id="add-workspace-host">
					{hosts.map((h, i) => {
						const on = h.entry.ref === value.entry.ref;
						return (
							<button key={h.entry.ref} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} title={h.entry.name} onClick={() => onPick(h)} onKeyDown={(event) => move(event, i)}>
								{name(h)}
							</button>
						);
					})}
				</div>
			</div>
		);
	}
	const pick = (at: number) => {
		const m = hosts[at];
		if (m !== undefined) onPick(m);
		setOpen(false);
	};
	const current = Math.max(0, hosts.findIndex((h) => h.entry.ref === value.entry.ref));
	const keys = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			// Closed: the first arrow opens the list on the machine picked now.
			if (!open) {
				setActive(current);
				setOpen(true);
				return;
			}
			setActive((a) => (a + (event.key === "ArrowDown" ? 1 : -1) + hosts.length) % hosts.length);
		} else if (event.key === "Enter" && open) {
			event.preventDefault();
			pick(active);
		} else if (event.key === "Escape" && open) {
			event.preventDefault();
			event.stopPropagation();
			setOpen(false);
		}
	};
	return (
		<div className="mx-field-row">
			<span id={labelId}>{p.host}</span>
			<div className="mx-host-select" data-id="add-workspace-host">
				<button
					type="button"
					role="combobox"
					className="input"
					aria-haspopup="listbox"
					aria-expanded={open}
					aria-labelledby={labelId}
					aria-controls={listId}
					aria-activedescendant={open ? `${listId}-${active}` : undefined}
					title={value.entry.name}
					onClick={() => {
						setActive(current);
						setOpen((v) => !v);
					}}
					onKeyDown={keys}
				>
					{name(value)}
					<MachineIcon name="chevron-down" small />
				</button>
				{open && (
					<ul className="mx-host-list" role="listbox" id={listId} aria-labelledby={labelId}>
						{hosts.map((h, i) => (
							<li
								key={h.entry.ref}
								id={`${listId}-${i}`}
								role="option"
								aria-selected={h.entry.ref === value.entry.ref}
								data-active={i === active ? "" : undefined}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => pick(i)}
								onKeyDown={keys}
							>
								{name(h)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

/**
 * A machine (picked only when there are several) and a folder on it: typed,
 * browsed, or one of the folders with sessions in one tap (`onQuick`).
 * Switching machines keeps everything in place: the folder list and the
 * recent folders keep their size, the last folder shown on each machine comes
 * back at once, and nothing typed elsewhere in the dialog is lost.
 */
function FolderChooser({ hosts, value, onChange, onQuick, busy }: { hosts: readonly MachineView[]; value: FolderChoice | null; onChange: (choice: FolderChoice) => void; onQuick: (choice: FolderChoice) => void; busy: boolean }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const [listings] = useState(() => new Map<string, DirListResult>());
	const machine = value?.machine ?? hosts[0];
	if (machine === undefined) return <p className="muted">{p.noHost}</p>;
	const recent = machine.state.projects?.suggestions ?? [];
	// With several machines the recent list keeps its place even when one machine has none.
	const showRecent = recent.length > 0 || hosts.length > 1;
	return (
		<>
			{hosts.length > 1 && <HostPicker hosts={hosts} value={machine} onPick={(m) => onChange({ machine: m, dir: "" })} />}
			<FolderPicker link={machine.link} host={machine.entry.ref} cache={listings} value="" onChange={(dir) => onChange({ machine, dir })} label={p.folder} />
			{showRecent && (
				<section className="mx-recent-folders" aria-label={p.recent}>
					<h4>{p.recent}</h4>
					{recent.length === 0 && <p className="muted">{p.noRecent}</p>}
					<ul>
						{recent.map((r) => (
							<li key={r.dir}>
								<MachineIcon name="folder" small />
								<span className="tx" title={r.dir}>
									<b>{folderName(r.dir)}</b>
									<small>{p.sessions(r.sessions)}</small>
								</span>
								<button type="button" className="btn btn-sm" aria-label={`${p.addRecent} ${folderName(r.dir)}`} disabled={busy} onClick={() => onQuick({ machine, dir: r.dir })}>
									{p.addRecent}
								</button>
							</li>
						))}
					</ul>
				</section>
			)}
		</>
	);
}

/** The footer and error line every dialog here shares. */
function Foot({ error, busy, submit, onClose, extra }: { error: string; busy: boolean; submit: string | null; onClose: () => void; extra?: ReactNode }) {
	const t = useMachinesCopy();
	return (
		<>
			{extra}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{t.newSession.cancel}
				</button>
				{submit !== null && (
					<button type="submit" className="btn btn-primary" disabled={busy}>
						{submit}
					</button>
				)}
			</div>
		</>
	);
}

/** Placing a folder by hand, with the sensitive-folder question when the machine asks it. */
function usePlace(store: AgentProjectsStore, onDone: () => void, project?: AgentProject) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [ask, setAsk] = useState<FolderChoice | null>(null);
	const place = (choice: FolderChoice, options: { name?: string; sensitive?: boolean }) => {
		setBusy(true);
		setError("");
		setAsk(null);
		placeByHand(store, hostOf(choice.machine), choice.dir, { ...options, ...(project !== undefined ? { target: project } : {}) }).then(onDone, (err: unknown) => {
			setBusy(false);
			if (isNeedsConsent(err)) setAsk(choice);
			else setError(failText(t, err, project));
		});
	};
	return { busy, error, ask, place };
}

/** "Thêm dự án": a name and an optional repository, or a folder on a machine (the project and its first workspace at once). */
export function AddAgentProjectDialog({ store, machines, onClose }: { store: AgentProjectsStore; machines: readonly MachineView[]; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("add-agent-project");
	const hosts = placeHosts(machines);
	const [name, setName] = useState("");
	const [repo, setRepo] = useState("");
	const [folderMode, setFolderMode] = useState(false);
	const [choice, setChoice] = useState<FolderChoice | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const placing = usePlace(store, onClose);
	const trimmed = name.trim();
	const repoKey = repo.trim() === "" ? "" : canonicalRemote(repo);
	const nameOk = trimmed !== "" && [...trimmed].length <= MAX_NAME;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (folderMode) {
			const picked = choice ?? (hosts[0] === undefined ? null : { machine: hosts[0], dir: "" });
			if (picked === null || picked.dir === "") return;
			return placing.place(picked, { name: trimmed });
		}
		if (!nameOk) return;
		if (repoKey === null) return setError(p.repoInvalid);
		setBusy(true);
		setError("");
		// Only the repository's key leaves the device: never a user or token typed into the URL.
		store.change((api) => api.create(trimmed, repoKey === "" ? "" : remoteUrlFor(repoKey, repo))).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(failText(t, err));
		});
	};
	const sensitive = placing.ask;
	return (
		<Modal labelledBy={id} onClose={onClose} className="mx-sheet">
			<DialogHead id={id} title={p.addTitle} onClose={onClose} />
			<form className="dlg-body stack mx-add-project" onSubmit={submit}>
				<label className="mx-field-row">
					<span>{p.name}</span>
					<input className="input" value={name} maxLength={MAX_NAME} placeholder={folderMode ? p.namePlaceholder : undefined} required={!folderMode} onChange={(event) => setName(event.target.value)} />
				</label>
				{folderMode ? (
					<FolderChooser hosts={hosts} value={choice} onChange={setChoice} onQuick={(c) => placing.place(c, { name: trimmed })} busy={placing.busy} />
				) : (
					<>
						<label className="mx-field-row">
							<span>{p.repo}</span>
							<input
								className="input mono"
								value={repo}
								spellCheck={false}
								autoComplete="off"
								placeholder="https://github.com/user/repo"
								aria-invalid={repoKey === null}
								onChange={(event) => setRepo(event.target.value)}
							/>
						</label>
						<p className="mx-or" aria-hidden="true">
							{p.or}
						</p>
						<button type="button" className="mx-pick-folder" disabled={hosts.length === 0} onClick={() => setFolderMode(true)} data-id="add-project-pick">
							<MachineIcon name="folder" />
							{p.pickFolder}
						</button>
					</>
				)}
				<Foot
					error={error || placing.error}
					busy={busy || placing.busy || (folderMode ? (choice?.dir ?? "") === "" : !nameOk)}
					submit={folderMode ? p.addFolder : p.create}
					onClose={onClose}
					extra={
						sensitive !== null && (
							<div className="mx-warn" role="alert">
								<p>{p.sensitiveAsk(sensitive.dir)}</p>
								<button type="button" className="btn btn-sm" onClick={() => placing.place(sensitive, { name: trimmed, sensitive: true })}>
									{p.addAnyway}
								</button>
							</div>
						)
					}
				/>
			</form>
		</Modal>
	);
}

/** "Thêm workspace": a folder on one of the machines, into `project`. */
export function AddWorkspaceDialog({ store, project, machines, onClose }: { store: AgentProjectsStore; project: AgentProject; machines: readonly MachineView[]; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("add-workspace");
	const hosts = placeHosts(machines);
	const [choice, setChoice] = useState<FolderChoice | null>(null);
	const placing = usePlace(store, onClose, project);
	const sensitive = placing.ask;
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (choice !== null && choice.dir !== "") placing.place(choice, {});
	};
	return (
		<Modal labelledBy={id} onClose={onClose} className="mx-sheet">
			<DialogHead id={id} title={p.addWorkspaceTitle(project.name)} onClose={onClose} />
			<form className="dlg-body stack mx-add-project" onSubmit={submit}>
				<FolderChooser hosts={hosts} value={choice} onChange={setChoice} onQuick={(c) => placing.place(c, {})} busy={placing.busy} />
				<Foot
					error={placing.error}
					busy={placing.busy || choice === null || choice.dir === ""}
					submit={hosts.length === 0 ? null : p.addFolder}
					onClose={onClose}
					extra={
						sensitive !== null && (
							<div className="mx-warn" role="alert">
								<p>{p.sensitiveAsk(sensitive.dir)}</p>
								<button type="button" className="btn btn-sm" onClick={() => placing.place(sensitive, { sensitive: true })}>
									{p.addAnyway}
								</button>
							</div>
						)
					}
				/>
			</form>
		</Modal>
	);
}

/** "Liên kết kho git": the repository the project links, set, changed or cleared (checked with the shared rule first). */
export function LinkRepositoryDialog({ store, project, onClose }: { store: AgentProjectsStore; project: AgentProject; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("link-agent-project");
	const [url, setUrl] = useState(project.gitRemote === "" ? "" : `https://${project.gitRemote}`);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const key = url.trim() === "" ? "" : canonicalRemote(url);
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (key === null) return setError(p.repoInvalid);
		setBusy(true);
		setError("");
		linkRepository(store, project, url).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(failText(t, err));
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={p.linkTitle(project.name)} onClose={onClose} />
			<form className="dlg-body stack" onSubmit={save}>
				<label className="mx-field-row">
					<span>{p.repo}</span>
					<input
						className="input mono"
						value={url}
						spellCheck={false}
						autoComplete="off"
						placeholder="https://github.com/user/repo"
						aria-invalid={key === null}
						onChange={(event) => setUrl(event.target.value)}
					/>
				</label>
				<p className="muted">{p.linkHint}</p>
				<Foot error={error} busy={busy || key === null || key === project.gitRemote} submit={p.linkSave} onClose={onClose} />
			</form>
		</Modal>
	);
}

export function RenameProjectDialog({ store, project, onClose }: { store: AgentProjectsStore; project: AgentProject; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("rename-agent-project");
	const [name, setName] = useState(project.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const trimmed = name.trim();
	const valid = trimmed !== "" && [...trimmed].length <= MAX_NAME;
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setBusy(true);
		store.change((api) => api.rename(project.id, trimmed)).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(failText(t, err));
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={p.renameTitle} onClose={onClose} />
			<form className="dlg-body stack" onSubmit={save}>
				<label className="mx-field-row">
					<span>{p.name}</span>
					<input className="input" value={name} maxLength={MAX_NAME} aria-invalid={!valid} onChange={(event) => setName(event.target.value)} />
				</label>
				<Foot error={error} busy={busy || !valid} submit={p.save} onClose={onClose} />
			</form>
		</Modal>
	);
}

/** A confirmation with one danger button. */
function Confirm({ title, body, action, run, onClose }: { title: string; body: string; action: string; run: () => Promise<void>; onClose: () => void }) {
	const t = useMachinesCopy();
	const id = useDomId("confirm-agent-project");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={title} onClose={onClose} />
			<div className="dlg-body stack">
				<p>{body}</p>
				{error !== "" && (
					<p className="mx-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{t.newSession.cancel}
				</button>
				<button
					type="button"
					className="btn btn-danger"
					disabled={busy}
					onClick={() => {
						setBusy(true);
						run().then(onClose, (err: unknown) => {
							setBusy(false);
							setError(failText(t, err));
						});
					}}
				>
					{action}
				</button>
			</div>
		</Modal>
	);
}

export function DeleteProjectDialog({ store, project, hostOf: host, onClose }: { store: AgentProjectsStore; project: AgentProject; hostOf: (machineId: number) => Host | null; onClose: () => void }) {
	const p = useMachinesCopy().agent.projects;
	return <Confirm title={p.removeTitle} body={p.removeBody(project.name)} action={p.remove} run={() => deleteProject(store, project, host)} onClose={onClose} />;
}

export function DetachWorkspaceDialog({ store, workspace, machineName, host, onClose }: { store: AgentProjectsStore; workspace: AgentWorkspace; machineName: string; host: Host | null; onClose: () => void }) {
	const p = useMachinesCopy().agent.projects;
	return <Confirm title={p.detachTitle} body={p.detachBody(workspace.dir, machineName)} action={p.detach} run={() => detachWorkspace(store, workspace, host)} onClose={onClose} />;
}

/**
 * Picks one of `projects`; those linking another repository than the
 * folder's (`remote`, as the machine reported it; "" when unknown) are
 * shown but cannot be picked.
 */
export function PickProjectDialog({ title, projects, remote, onPick, onClose }: { title: string; projects: readonly AgentProject[]; remote: string; onPick: (project: AgentProject) => Promise<void>; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("pick-agent-project");
	const [picked, setPicked] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const target = projects.find((x) => x.id === picked);
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (target === undefined) return;
		setBusy(true);
		setError("");
		onPick(target).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(failText(t, err, target));
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={title} onClose={onClose} />
			<form className="dlg-body stack" onSubmit={submit}>
				<fieldset className="mx-ai-pick mx-project-pick">
					<legend>{p.pick}</legend>
					{projects.map((x) => {
						const other = remoteMismatch(x.gitRemote, remote);
						return (
							<label key={x.id} className={x.id === picked ? "sel" : undefined} title={other ? p.mismatch(x.gitRemote) : x.gitRemote || undefined}>
								<input type="radio" name="project" checked={x.id === picked} disabled={other} onChange={() => setPicked(x.id)} />
								<b>{x.name}</b>
								{other && <small>{p.otherRepo}</small>}
							</label>
						);
					})}
				</fieldset>
				<Foot error={error} busy={busy || target === undefined} submit={p.save} onClose={onClose} />
			</form>
		</Modal>
	);
}
