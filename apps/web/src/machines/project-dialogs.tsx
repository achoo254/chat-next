// The project dialogs (loaded when first opened): "Thêm dự án" with three
// ways (a folder on the machine, a git clone with its progress and cancel, a
// new folder with git init), the machine picked first when there are several
// (like Orca's host picker), and the folders that already have sessions on it
// one tap away; the project's settings (what its new sessions
// start with), renaming and removing (the folder always stays).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ErrorCode, type DirListResult, type MachineInfo, type Project } from "@achoo254/chat-proto/remote/remote";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName } from "./new-session-hints.ts";
import { errorText, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type ProjectLink = Pick<MachineLink, "request">;

/** The permission modes Claude offers a device, when no session told them yet. */
const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto"];

/** An https or ssh URL without a password, as the machine takes it (it checks again). */
export function cloneUrlOk(url: string): boolean {
	const u = url.trim();
	if (u === "" || u.startsWith("-") || /\s/.test(u)) return false;
	if (/^https:\/\//i.test(u)) {
		try {
			const parsed = new URL(u);
			return parsed.username === "" && parsed.password === "" && parsed.hostname !== "" && parsed.pathname.split("/").filter(Boolean).length > 0;
		} catch {
			return false;
		}
	}
	if (/^ssh:\/\//i.test(u)) {
		try {
			const parsed = new URL(u);
			return parsed.password === "" && parsed.hostname !== "";
		} catch {
			return false;
		}
	}
	return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]{2,}:(?!\/\/)\S+$/.test(u);
}

/** A folder on the machine: typed, or picked from the list of the one shown. */
function FolderPicker({ link, value, onChange, label }: { link: ProjectLink; value: string; onChange: (dir: string) => void; label: string }) {
	const t = useMachinesCopy();
	const [listing, setListing] = useState<DirListResult | null>(null);
	const [typed, setTyped] = useState(value);
	const [error, setError] = useState("");
	const list = (dir: string) =>
		link.request({ case: "dirList", value: { path: dir, showHidden: false } }).then((frame) => (frame.body.case === "dirListResult" ? frame.body.value : null));
	const shown = (result: DirListResult | null) => {
		if (result === null) return;
		setListing(result);
		setTyped(result.path);
		onChange(result.path);
	};
	const open = (dir: string) => {
		setError("");
		list(dir).then(shown, (err: unknown) => setError(errorText(t, err, "")));
	};
	// The folder given first (or home) opens once.
	useEffect(() => {
		let live = true;
		list(value).then(
			(result) => live && shown(result),
			(err: unknown) => live && setError(errorText(t, err, "")),
		);
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- opens the starting folder once; later changes come from this picker
	}, []);
	return (
		<div className="mx-field-row">
			<span>{label}</span>
			<div className="mx-dirbox">
			<div className="mx-dir-input">
				<MachineIcon name="folder" small />
				<input
					className="input"
					aria-label={label}
					value={typed}
					spellCheck={false}
					autoComplete="off"
					onChange={(event) => setTyped(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							open(typed.trim());
						}
					}}
				/>
				{typed.trim() !== (listing?.path ?? "") && typed.trim() !== "" && (
					<button type="button" className="btn btn-sm" onClick={() => open(typed.trim())}>
						{t.newSession.go}
					</button>
				)}
			</div>
			{error !== "" && <p className="mx-error">{error}</p>}
			{listing !== null && (
				<ul className="mx-dirs mx-pick-dirs">
					{listing.parent !== "" && (
						<li>
							<button type="button" onClick={() => open(listing.parent)}>
								<MachineIcon name="folder" small />
								<span>..</span>
							</button>
						</li>
					)}
					{listing.entries.map((entry) => {
						const sep = listing.path.includes("\\") && !listing.path.includes("/") ? "\\" : "/";
						const dir = listing.path.endsWith(sep) ? `${listing.path}${entry.name}` : `${listing.path}${sep}${entry.name}`;
						return (
							<li key={entry.name}>
								<button type="button" onClick={() => open(dir)}>
									<MachineIcon name={entry.git ? "branch" : "folder"} small />
									<span>{entry.name}</span>
									{entry.branch !== "" && <small>{entry.branch}</small>}
								</button>
							</li>
						);
					})}
				</ul>
			)}
			</div>
		</div>
	);
}

type Tab = "local" | "clone" | "create";

/** A machine projects can be added on. */
export interface ProjectHost {
	readonly ref: string;
	readonly name: string;
	readonly link: ProjectLink;
	readonly state: LinkState;
}

/** "Thêm dự án" on one of `hosts` (the picker shows only with more than one). */
export function AddProjectOnHost({ hosts, initialRef, initialDir = "", onClose }: { hosts: readonly ProjectHost[]; initialRef?: string; initialDir?: string; onClose: () => void }) {
	const t = useMachinesCopy();
	const [ref, setRef] = useState(initialRef ?? hosts[0]?.ref ?? "");
	const host = hosts.find((h) => h.ref === ref) ?? hosts[0];
	if (host === undefined) return null;
	const picker =
		hosts.length > 1 ? (
			<fieldset className="mx-ai-pick mx-host-pick" data-id="add-project-host">
				<legend>{t.agent.projects.host}</legend>
				{hosts.map((h) => (
					<label key={h.ref} className={h.ref === host.ref ? "sel" : undefined}>
						<input type="radio" name="host" checked={h.ref === host.ref} onChange={() => setRef(h.ref)} />
						<span className={`dot ${h.state.status.kind === "open" ? "on" : "off"}`} aria-hidden="true" />
						<b>{h.name}</b>
					</label>
				))}
			</fieldset>
		) : null;
	return <AddProjectDialog key={host.ref} link={host.link} state={host.state} ai={providerOf(host.state.info, "claude")?.name || "AI"} initialDir={initialDir} host={picker} onClose={onClose} />;
}

export function AddProjectDialog({
	link,
	state,
	ai,
	initialDir = "",
	host,
	onClose,
}: {
	link: ProjectLink;
	state: LinkState;
	ai: string;
	initialDir?: string;
	/** The machine picker, above everything else. */
	host?: ReactNode;
	onClose: () => void;
}) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("add-project");
	const tabsId = useDomId("add-project-tab");
	const [tab, setTab] = useState<Tab>("local");
	const [dir, setDir] = useState(initialDir);
	const recent = state.projects?.suggestions ?? [];
	// Choosing a folder by hand; the recent ones come first when there are any.
	const [browsing, setBrowsing] = useState(initialDir !== "" || recent.length === 0);
	/** A recent folder in one tap (a sensitive one asks first, like the form). */
	const addRecent = (folderDir: string, sensitive = false) => {
		setDir(folderDir);
		setBusy(true);
		setError("");
		link.request({ case: "projectAdd", value: { dir: folderDir, name: "", consent: { sensitive, projectSettings: false } } }).then(onClose, fail);
	};
	const [parent, setParent] = useState("");
	const [name, setName] = useState("");
	const [folder, setFolder] = useState("");
	const [url, setUrl] = useState("");
	const [gitInit, setGitInit] = useState(true);
	const [askSensitive, setAskSensitive] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [cloneId, setCloneId] = useState("");
	const clone = cloneId === "" ? undefined : state.clones.get(cloneId);
	const cloneOk = clone?.done === true && clone.projectId !== "";
	// A clone that ended without a project: cancelled, or why it failed.
	const cloneError =
		clone?.done === true && !cloneOk ? (clone.reason === 0 ? p.cloneCancelled : errorText(t, new RemoteError(ErrorCode.INVALID, clone.message, clone.reason, clone.message), ai)) : "";

	// A clone that finished well closes the dialog.
	useEffect(() => {
		if (cloneOk) onClose();
	}, [cloneOk, onClose]);

	const fail = (err: unknown) => {
		setBusy(false);
		if (err instanceof RemoteError && err.code === ErrorCode.NEEDS_CONSENT) return setAskSensitive(true);
		setError(errorText(t, err, ai));
	};
	const submit = (event: FormEvent, sensitive = false) => {
		event.preventDefault();
		setError("");
		if (tab === "clone" && !cloneUrlOk(url)) return setError(p.urlInvalid);
		setBusy(true);
		if (tab === "local") {
			link.request({ case: "projectAdd", value: { dir, name: name.trim(), consent: { sensitive, projectSettings: false } } }).then(onClose, fail);
		} else if (tab === "create") {
			link.request({ case: "projectCreate", value: { parent, name: folder.trim(), gitInit } }).then(onClose, fail);
		} else {
			const next = crypto.randomUUID();
			setCloneId(next);
			link.request({ case: "projectClone", value: { url: url.trim(), parent, name: folder.trim(), cloneId: next } }).then(
				() => setBusy(false),
				(err: unknown) => {
					setCloneId("");
					fail(err);
				},
			);
		}
	};
	const cancelClone = () => {
		if (cloneId !== "") link.request({ case: "projectCloneCancel", value: { cloneId } }).catch(() => undefined);
	};
	const tabs: readonly Tab[] = ["local", "clone", "create"];
	const cloning = cloneId !== "" && clone?.done !== true;
	return (
		<Modal labelledBy={id} onClose={cloning ? () => undefined : onClose} className="mx-sheet">
			<DialogHead id={id} title={p.addTitle} onClose={cloning ? cancelClone : onClose} />
			<div className="tabs mx-new-tabs" role="tablist" aria-label={p.tabs}>
				{tabs.map((x) => (
					<button key={x} type="button" role="tab" id={`${tabsId}-${x}`} aria-selected={tab === x} disabled={cloning} onClick={() => setTab(x)}>
						{p[x]}
					</button>
				))}
			</div>
			<form className="dlg-body stack mx-add-project" role="tabpanel" aria-labelledby={`${tabsId}-${tab}`} onSubmit={(event) => submit(event)}>
				{host}
				{tab === "local" && (
					<>
						{browsing ? (
							<>
								<FolderPicker link={link} value={initialDir} onChange={setDir} label={p.folder} />
								<label className="mx-field-row">
									<span>{p.name}</span>
									<input className="input" value={name} maxLength={64} placeholder={p.namePlaceholder} onChange={(event) => setName(event.target.value)} />
								</label>
							</>
						) : (
							<button type="button" className="mx-pick-folder" onClick={() => setBrowsing(true)} data-id="add-project-pick">
								<MachineIcon name="folder" />
								{p.pickFolder}
							</button>
						)}
						{recent.length > 0 && (
							<section className="mx-recent-folders" aria-label={p.recent}>
								<h4>{p.recent}</h4>
								<ul>
									{recent.map((r) => (
										<li key={r.dir}>
											<MachineIcon name="folder" small />
											<span className="tx" title={r.dir}>
												<b>{folderName(r.dir)}</b>
												<small>{p.sessions(r.sessions)}</small>
											</span>
											<button type="button" className="btn btn-sm" aria-label={`${p.addRecent} ${folderName(r.dir)}`} disabled={busy} onClick={() => addRecent(r.dir)}>
												{p.addRecent}
											</button>
										</li>
									))}
								</ul>
							</section>
						)}
					</>
				)}
				{tab === "clone" && (
					<>
						<label className="mx-field-row">
							<span>{p.url}</span>
							<input
								className="input mono"
								value={url}
								spellCheck={false}
								autoComplete="off"
								placeholder="https://github.com/user/repo.git"
								disabled={cloning}
								onChange={(event) => setUrl(event.target.value)}
							/>
						</label>
						<FolderPicker link={link} value="" onChange={setParent} label={p.parent} />
						<label className="mx-field-row">
							<span>{p.folderName}</span>
							<input className="input" value={folder} placeholder={p.repoPlaceholder} disabled={cloning} onChange={(event) => setFolder(event.target.value)} />
						</label>
						{cloning && (
							<div className="mx-clone" role="status">
								<span>{p.cloning(clone?.phase ?? "", clone?.percent ?? 0)}</span>
								<span className="mx-tray-bar" role="progressbar" aria-label={p.cloning(clone?.phase ?? "", clone?.percent ?? 0)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={clone?.percent ?? 0}>
									<i style={{ width: `${clone?.percent ?? 0}%` }} />
								</span>
							</div>
						)}
					</>
				)}
				{tab === "create" && (
					<>
						<FolderPicker link={link} value="" onChange={setParent} label={p.parent} />
						<label className="mx-field-row">
							<span>{p.folderName}</span>
							<input className="input" value={folder} required onChange={(event) => setFolder(event.target.value)} />
						</label>
						<label className="mx-check">
							<input type="checkbox" checked={gitInit} onChange={(event) => setGitInit(event.target.checked)} />
							<span>{p.gitInit}</span>
						</label>
					</>
				)}
				{askSensitive && (
					<div className="mx-warn" role="alert">
						<p>{p.sensitiveAsk(dir)}</p>
						<button type="button" className="btn btn-sm" onClick={(event) => (tab === "local" && !browsing ? addRecent(dir, true) : submit(event, true))}>
							{p.addAnyway}
						</button>
					</div>
				)}
				{(error !== "" || cloneError !== "") && (
					<p className="mx-error" role="alert">
						{error || cloneError}
					</p>
				)}
				<div className="dlg-foot">
					{cloning ? (
						<button type="button" className="btn" onClick={cancelClone}>
							{p.cancelClone}
						</button>
					) : (
						<button type="button" className="btn" onClick={onClose}>
							{t.newSession.cancel}
						</button>
					)}
					{(tab !== "local" || browsing) && (
						<button type="submit" className="btn btn-primary" disabled={busy || cloning || (tab === "local" ? dir === "" : tab === "create" ? folder.trim() === "" || parent === "" : url.trim() === "" || parent === "")}>
							{tab === "local" ? p.addButton : tab === "clone" ? p.cloneButton : p.createButton}
						</button>
					)}
				</div>
			</form>
		</Modal>
	);
}

export function ProjectSettingsDialog({ link, project, state, ai, onClose }: { link: ProjectLink; project: Project; state: LinkState; ai: string; onClose: () => void }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const id = useDomId("project-settings");
	const info: MachineInfo | null = state.info;
	const models = providerOf(info, "claude")?.capabilities?.models ?? [];
	const modes = [...state.threadInfo.values()].find((x) => x.permissionModes.length > 0)?.permissionModes ?? CLAUDE_MODES;
	const [model, setModel] = useState(project.defaults?.model ?? "");
	const [mode, setMode] = useState(project.defaults?.permissionMode ?? "");
	const [settings, setSettings] = useState(project.defaults?.projectSettings ?? false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const save = (event: FormEvent) => {
		event.preventDefault();
		setBusy(true);
		link.request({ case: "projectUpdate", value: { id: project.id, defaults: { model, permissionMode: mode, projectSettings: settings } } }).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(errorText(t, err, ai));
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={p.settingsTitle(project.name)} onClose={onClose} />
			<form onSubmit={save}>
				<div className="dlg-body stack">
					<p className="muted">{p.settingsHint}</p>
					<label className="mx-field-row">
						<span>{p.model}</span>
						<select className="input" value={model} onChange={(event) => setModel(event.target.value)}>
							<option value="">{p.modelDefault(ai)}</option>
							{models.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name}
								</option>
							))}
						</select>
					</label>
					<label className="mx-field-row">
						<span>{p.mode}</span>
						<select className="input" value={mode} onChange={(event) => setMode(event.target.value)}>
							<option value="">{p.modeMachine}</option>
							{modes.map((m) => (
								<option key={m} value={m}>
									{t.statusBar.modes[m as keyof typeof t.statusBar.modes] ?? m}
								</option>
							))}
						</select>
					</label>
					<label className="mx-check">
						<input type="checkbox" checked={settings} disabled={project.sensitive} onChange={(event) => setSettings(event.target.checked)} />
						<span>{p.projectSettings}</span>
					</label>
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
					<button type="submit" className="btn btn-primary" disabled={busy}>
						{p.save}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function RenameProjectDialog({ link, project, ai, onClose }: { link: ProjectLink; project: Project; ai: string; onClose: () => void }) {
	const t = useMachinesCopy();
	const id = useDomId("rename-project");
	const [name, setName] = useState(project.name);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const trimmed = name.trim();
	const valid = trimmed !== "" && [...trimmed].length <= 64;
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (!valid) return;
		setBusy(true);
		link.request({ case: "projectUpdate", value: { id: project.id, name: trimmed } }).then(onClose, (err: unknown) => {
			setBusy(false);
			setError(errorText(t, err, ai));
		});
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.agent.projects.renameTitle} onClose={onClose} />
			<form onSubmit={save}>
				<div className="dlg-body stack">
					<label className="mx-field-row">
						<span>{t.agent.projects.name}</span>
						<input className="input" value={name} maxLength={64} aria-invalid={!valid} onChange={(event) => setName(event.target.value)} />
					</label>
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
					<button type="submit" className="btn btn-primary" disabled={busy || !valid}>
						{t.agent.projects.save}
					</button>
				</div>
			</form>
		</Modal>
	);
}

export function RemoveProjectDialog({ link, project, ai, onClose }: { link: ProjectLink; project: Project; ai: string; onClose: () => void }) {
	const t = useMachinesCopy();
	const id = useDomId("remove-project");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.agent.projects.removeTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p>{t.agent.projects.removeBody(project.name, project.dir || folderName(project.dir))}</p>
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
						link.request({ case: "projectRemove", value: { id: project.id } }).then(onClose, (err: unknown) => {
							setBusy(false);
							setError(errorText(t, err, ai));
						});
					}}
				>
					{t.agent.projects.remove}
				</button>
			</div>
		</Modal>
	);
}
