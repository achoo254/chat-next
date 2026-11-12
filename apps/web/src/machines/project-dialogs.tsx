// What a machine knows about one of its folders (loaded when first opened):
// a folder picker (typed, or browsed with git branches) and the settings a
// new session in a workspace starts with (model, permission mode, the
// project's own .claude settings), which the machine keeps for the folder.
import { useEffect, useState, type FormEvent } from "react";
import type { DirListResult, MachineInfo, Project } from "@achoo254/chat-proto/remote/remote";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import type { LinkState, MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { errorText, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type ProjectLink = Pick<MachineLink, "request">;

/** The permission modes Claude offers a device, when no session told them yet. */
const CLAUDE_MODES = ["default", "acceptEdits", "plan", "auto"];

/**
 * A folder on the machine: typed, or picked from the list of the one shown.
 * `host` names the machine when the picker can move to another one: the last
 * folder shown on each is kept in `cache`, so going back is instant, and
 * until the new machine answers the old list stays, dimmed, at the same size.
 */
export function FolderPicker({
	link,
	value,
	onChange,
	label,
	host,
	cache,
}: {
	link: ProjectLink;
	value: string;
	onChange: (dir: string) => void;
	label: string;
	host?: string;
	cache?: Map<string, DirListResult>;
}) {
	const t = useMachinesCopy();
	const [listing, setListing] = useState<DirListResult | null>(null);
	const [typed, setTyped] = useState(value);
	const [error, setError] = useState("");
	const [stale, setStale] = useState(false);
	// Another machine: its last folder at once when seen before, else the old list dimmed until it answers.
	const [shownHost, setShownHost] = useState(host);
	const cached = host === undefined ? undefined : cache?.get(host);
	if (host !== shownHost) {
		setShownHost(host);
		setError("");
		if (cached !== undefined) {
			setListing(cached);
			setTyped(cached.path);
			setStale(false);
		} else {
			setStale(true);
		}
	}
	const list = (dir: string) =>
		link.request({ case: "dirList", value: { path: dir, showHidden: false } }).then((frame) => (frame.body.case === "dirListResult" ? frame.body.value : null));
	const shown = (result: DirListResult | null) => {
		if (result === null) return;
		if (host !== undefined) cache?.set(host, result);
		setStale(false);
		setListing(result);
		setTyped(result.path);
		onChange(result.path);
	};
	const open = (dir: string) => {
		setError("");
		list(dir).then(shown, (err: unknown) => setError(errorText(t, err, "")));
	};
	// The folder given first (or home) opens once per machine; a machine seen before shows its last folder at once.
	useEffect(() => {
		if (cached !== undefined) {
			onChange(cached.path);
			return;
		}
		let live = true;
		list(value).then(
			(result) => live && shown(result),
			(err: unknown) => {
				if (!live) return;
				setStale(false);
				setError(errorText(t, err, ""));
			},
		);
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- opens the starting folder once per machine; later changes come from this picker
	}, [host]);
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
			{(listing !== null || host !== undefined) && (
				<ul className="mx-dirs mx-pick-dirs" data-stale={stale ? "" : undefined} aria-busy={stale}>
					{listing !== null && listing.parent !== "" && (
						<li>
							<button type="button" onClick={() => open(listing.parent)}>
								<MachineIcon name="folder" small />
								<span>..</span>
							</button>
						</li>
					)}
					{(listing?.entries ?? []).map((entry) => {
						if (listing === null) return null;
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
