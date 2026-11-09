// "Phiên mới" (a dialog on desktop, a bottom sheet on phones): the AI when the
// machine has more than one, any folder (typed with suggestions, recent and
// pinned ones, or browsed with git and "sensitive" labels; it opens in the
// folder of the newest session), the project's own .claude settings (off by
// default), and the first message, filled in with a suggestion that follows
// the folder until the user edits it or picks another one. A sensitive
// folder needs an explicit "I agree", which the machine logs; it is never
// blocked. Project settings in a folder the machine does not trust yet ask
// for "Trust this folder" right here (the machine logs that too); in the
// home folder or a sensitive one they are off and locked, as Claude Code
// never trusts a .claude there either. Warns which
// idle session will be parked when the machine is full. A second tab opens
// a session the machine already keeps (from a terminal, an IDE, Claude
// Desktop); it loads only when picked.
import { lazy, Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorCode, LoginState, ThreadState, type DirListResult } from "@achoo254/chat-proto/remote/remote";
import { navigate, paths } from "../router.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { PROMPT_HINTS, folderName, hintPrompt, inDiskAccessFolder, isHome, pathCrumbs, recentFolders, type PromptHint } from "./new-session-hints.ts";
import { machineErrorText, needsProjectTrust } from "./machine-errors.ts";
import { aiName, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

const ExistingSessions = lazy(() => import("./existing-sessions.tsx"));

interface NewSessionProps {
	machine: string;
	name: string;
	link: MachineLink;
	state: LinkState;
	onClose: () => void;
}

/** Folders that start with what was typed: the suggestions, then the folders shown; at most six. */
function folderMatches(typed: string, suggestions: readonly string[], listing: DirListResult | null): string[] {
	const lower = typed.toLowerCase();
	const shown = listing === null ? [] : listing.entries.map((entry) => joinPath(listing.path, entry.name));
	return [...new Set([...suggestions, ...shown])].filter((dir) => dir.toLowerCase().startsWith(lower) && dir !== typed).slice(0, 6);
}

function joinPath(dir: string, child: string): string {
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return dir.endsWith(sep) ? `${dir}${child}` : `${dir}${sep}${child}`;
}

export function NewSession({ machine, name, link, state, onClose }: NewSessionProps) {
	const t = useMachinesCopy();
	const titleId = useDomId("new-session");
	const tabsId = useDomId("new-session-tab");
	const [tab, setTab] = useState<"new" | "existing">("new");
	const suggestId = useDomId("dir-suggestions");
	const providers = state.info?.providers ?? [];
	const [provider, setProvider] = useState(() => providers.find((p) => p.loginState !== LoginState.NEEDS_LOGIN)?.id ?? providers[0]?.id ?? "claude");
	const [model, setModel] = useState("");
	const [path, setPath] = useState("");
	const [listing, setListing] = useState<DirListResult | null>(null);
	// Why the folder typed or picked could not be listed; empty when it could.
	const [listError, setListError] = useState("");
	// The folder being listed now, for the "Go to" button.
	const [going, setGoing] = useState("");
	// The field is being typed in: show matching folders under it.
	const [typing, setTyping] = useState(false);
	const [projectSettings, setProjectSettings] = useState(false);
	// The first message: a suggestion (it follows the folder) until the user types.
	const [hint, setHint] = useState<PromptHint | null>("summary");
	const [text, setText] = useState("");
	const [askConsent, setAskConsent] = useState(false);
	// The folder whose .claude settings the machine refused to load untrusted.
	const [askTrust, setAskTrust] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const ai = aiName(state.info, provider);
	const models = providerOf(state.info, provider)?.capabilities?.models ?? [];

	const browse = (dir: string) => {
		setTyping(false);
		setListError("");
		setGoing(dir);
		link.request({ case: "dirList", value: { path: dir, showHidden: false } }).then(
			(frame) => {
				setGoing("");
				if (frame.body.case !== "dirListResult") return;
				setListing(frame.body.value);
				setPath(frame.body.value.path);
				setAskConsent(false);
				setAskTrust("");
			},
			(err: unknown) => {
				setGoing("");
				setListError(machineErrorText(t, err, ai));
			},
		);
	};
	const recent = recentFolders(state.threads, state.info?.recentDirs);
	// Start in the newest session's folder (the home folder when there is none,
	// or when that folder cannot be opened any more). Waits for the session list
	// unless a folder is already known.
	const started = useRef(false);
	const startDir = recent[0] ?? "";
	const ready = state.listed || startDir !== "";
	useEffect(() => {
		if (!ready || started.current) return;
		started.current = true;
		const open = (dir: string): Promise<void> =>
			link.request({ case: "dirList", value: { path: dir, showHidden: false } }).then((frame) => {
				if (frame.body.case !== "dirListResult") return;
				const result = frame.body.value;
				setListing(result);
				setPath((typed) => (typed === "" ? result.path : typed));
			});
		open(startDir)
			.catch(() => (startDir === "" ? Promise.reject(new Error("no home")) : open("")))
			.catch(() => setListError(t.newSession.listFailed));
	}, [link, ready, startDir, t]);

	const sensitive = listing !== null && listing.path === path && listing.sensitive;
	// "Go to" only does something for a folder other than the one shown.
	const typed = path.trim();
	const canGo = typed !== "" && typed !== listing?.path;
	const pinned = state.info?.pinnedDirs ?? [];
	const suggestions = [...new Set([...recent, ...pinned])];
	const matches = typing && typed !== "" ? folderMatches(typed, suggestions, listing) : [];
	const diskAccessHint = state.info?.needsFullDiskAccess === true && inDiskAccessFolder(typed, state.info.home);
	const noProject = sensitive || isHome(path, state.info?.home ?? "");
	const loadProject = projectSettings && !noProject;
	const message = hint !== null ? hintPrompt(t.newSession, hint, path) : text;
	const full = state.maxSessions > 0 && state.openSessions >= state.maxSessions;
	const victim = full
		? state.threads
				.filter((x) => x.open && x.state === ThreadState.IDLE && x.pending === 0)
				.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))[0]
		: undefined;

	// `consent`: the user agreed to the sensitive folder; `trust`: to trusting its project settings.
	const start = (consent: boolean, trust = false) => {
		if (path.trim() === "") return setError(t.newSession.needFolder);
		// An emptied message falls back to the default suggestion.
		const first = message.trim() === "" ? hintPrompt(t.newSession, "summary", path) : message.trim();
		if ((sensitive || askConsent) && !consent) {
			setAskConsent(true);
			return;
		}
		setBusy(true);
		setError("");
		const dir = path.trim();
		link
			.request({
				case: "threadCreate",
				value: { provider, model, dir, text: first, consent: { sensitive: consent, projectSettings: loadProject, trustProject: loadProject && trust } },
			})
			.then(
				(frame) => {
					setBusy(false);
					const thread = frame.body.case === "threadCreated" ? frame.body.value.thread : undefined;
					if (thread === undefined) return;
					onClose();
					navigate(paths.machineSession(machine, thread.id));
				},
				(err: unknown) => {
					setBusy(false);
					if (err instanceof RemoteError && err.code === ErrorCode.NEEDS_CONSENT) setAskConsent(true);
					// The machine answers the trust question before it opens a session, so the agreement above still holds.
					else if (needsProjectTrust(err) && !trust) setAskTrust(dir);
					else setError(machineErrorText(t, err, ai));
				},
			);
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		start(false);
	};

	return (
		<Modal labelledBy={titleId} onClose={onClose} className="mx-sheet">
			<DialogHead id={titleId} title={t.newSession.title(name)} onClose={onClose} />
			<div className="tabs mx-new-tabs" role="tablist" aria-label={t.existing.tabs}>
				<button type="button" role="tab" id={`${tabsId}-new`} aria-controls={`${tabsId}-new-panel`} aria-selected={tab === "new"} onClick={() => setTab("new")}>
					{t.existing.newTab}
				</button>
				<button
					type="button"
					role="tab"
					id={`${tabsId}-existing`}
					aria-controls={`${tabsId}-existing-panel`}
					aria-selected={tab === "existing"}
					onClick={() => setTab("existing")}
					data-id="new-session-existing-tab"
				>
					{t.existing.tab}
				</button>
			</div>
			{tab === "existing" ? (
				<div role="tabpanel" id={`${tabsId}-existing-panel`} aria-labelledby={`${tabsId}-existing`}>
					<Suspense
						fallback={
							<p className="dlg-body mx-wait" role="status">
								<span className="spin" aria-hidden="true" />
								{t.existing.loading}
							</p>
						}
					>
						<ExistingSessions machine={machine} name={name} link={link} ai={ai} home={state.info?.home ?? ""} onClose={onClose} />
					</Suspense>
				</div>
			) : (
				<form className="dlg-body mx-new" onSubmit={onSubmit} role="tabpanel" id={`${tabsId}-new-panel`} aria-labelledby={`${tabsId}-new`}>
					{providers.length > 1 && (
						<fieldset className="mx-ai-pick">
							<legend>{t.newSession.ai}</legend>
							{providers.map((p) => {
								const usable = p.loginState !== LoginState.NEEDS_LOGIN;
								return (
									<label key={p.id} className={provider === p.id ? "sel" : undefined}>
										<input
											type="radio"
											name="ai"
											checked={provider === p.id}
											disabled={!usable}
											onChange={() => {
												setProvider(p.id);
												setModel("");
											}}
										/>
										<b>{p.name || p.id}</b>
										<small>{usable ? p.version : t.newSession.needsLogin}</small>
									</label>
								);
							})}
						</fieldset>
					)}
					{suggestions.length > 0 && (
						<div className="mx-quick">
							{recent.length > 0 && <em>{t.newSession.recent}</em>}
							{recent.map((dir) => (
								<button key={`r:${dir}`} type="button" className="chip" aria-pressed={dir === path} onClick={() => browse(dir)} title={dir}>
									{folderName(dir)}
								</button>
							))}
							{pinned.length > 0 && <em>{t.newSession.pinned}</em>}
							{pinned.map((dir) => (
								<button key={`p:${dir}`} type="button" className="chip" aria-pressed={dir === path} onClick={() => browse(dir)} title={dir}>
									<MachineIcon name="star" small />
									{folderName(dir)}
								</button>
							))}
						</div>
					)}
					<div className="mx-dirbox">
						<div className="mx-dir-input">
							<MachineIcon name="folder" small />
							<input
								className="input"
								aria-label={t.newSession.folder}
								placeholder={t.newSession.folderPlaceholder}
								value={path}
								aria-controls={matches.length > 0 ? suggestId : undefined}
								onBlur={() => setTyping(false)}
								spellCheck={false}
								autoComplete="off"
								onChange={(event) => {
									setPath(event.target.value);
									setTyping(true);
									setAskConsent(false);
									setAskTrust("");
								}}
								onKeyDown={(event) => {
									if (event.key === "Escape" && matches.length > 0) {
										event.preventDefault();
										event.stopPropagation();
										setTyping(false);
									}
									if (event.key === "Enter") {
										event.preventDefault();
										if (canGo) browse(typed);
									}
								}}
							/>
							{going !== "" ? (
								<span className="mx-wait" role="status">
									<span className="spin" aria-hidden="true" />
									{t.newSession.going}
								</span>
							) : (
								canGo && (
									<button type="button" className="btn btn-sm" onClick={() => browse(typed)}>
										{t.newSession.go}
									</button>
								)
							)}
						</div>
						{matches.length > 0 && (
							<ul className="mx-suggest" id={suggestId} aria-label={t.newSession.suggestions}>
								{matches.map((dir) => (
									<li key={dir}>
										{/* Keeps the field focused so the click lands. */}
										<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => browse(dir)}>
											<MachineIcon name="folder" small />
											<span className="mono">{dir}</span>
										</button>
									</li>
								))}
							</ul>
						)}
						{listing !== null && (
							<nav className="mx-crumbs" aria-label={t.newSession.crumbs}>
								<ol>
									{pathCrumbs(listing.path, state.info?.home ?? "").map((crumb, i, all) => (
										<li key={crumb.path}>
											{i === all.length - 1 ? (
												<b aria-current="location">{crumb.name}</b>
											) : (
												<button type="button" title={crumb.path} onClick={() => browse(crumb.path)}>
													{crumb.name}
												</button>
											)}
										</li>
									))}
									{listing.path === "/" && (
										<li>
											<b aria-current="location">/</b>
										</li>
									)}
								</ol>
								{listing.sensitive && <small className="mx-tag danger">{t.newSession.sensitive}</small>}
							</nav>
						)}
						{listError !== "" && (
							<p className="mx-error" role="alert">
								{listError}
							</p>
						)}
						{diskAccessHint && (
							<p className="mx-warn" role="note" data-id="new-session-disk-access">
								{t.diskAccess.sessionHint}
							</p>
						)}
						{listing !== null && (
							<ul className="mx-dirs">
								{listing.entries.length === 0 && <li className="muted">{t.newSession.noSubfolders}</li>}
								{listing.entries.map((entry) => (
									<li key={entry.name}>
										<button type="button" onClick={() => browse(joinPath(listing.path, entry.name))}>
											<MachineIcon name="folder" small />
											<span className="nm">{entry.name}</span>
											{entry.git && (
												<small className="mx-tag">
													<MachineIcon name="branch" small />
													{t.newSession.git(entry.branch)}
												</small>
											)}
											{entry.sensitive && <small className="mx-tag danger">{t.newSession.sensitive}</small>}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
					{askConsent && (
						<div className="mx-warn" role="alert">
							<b>{t.newSession.sensitiveTitle(path)}</b>
							<span>{t.newSession.sensitiveBody(ai, name)}</span>
							<div className="acts">
								<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => start(true)}>
									{t.newSession.agree}
								</button>
								<button type="button" className="btn btn-sm" onClick={() => setAskConsent(false)}>
									{t.newSession.other}
								</button>
							</div>
						</div>
					)}
					{askTrust !== "" && askTrust === path.trim() && loadProject && (
						<div className="mx-warn" role="alert">
							<b>{t.newSession.trustTitle(askTrust)}</b>
							<span>{t.newSession.trustBody(ai, name)}</span>
							<div className="acts">
								<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => start(askConsent || sensitive, true)}>
									{t.newSession.trust}
								</button>
								<button
									type="button"
									className="btn btn-sm"
									onClick={() => {
										setProjectSettings(false);
										setAskTrust("");
									}}
								>
									{t.newSession.skipProjectSettings}
								</button>
							</div>
						</div>
					)}
					{models.length > 0 && (
						<label className="mx-field-row mx-model-pick">
							<span>{t.newSession.model}</span>
							<select className="input" value={model} onChange={(event) => setModel(event.target.value)}>
								<option value="">{t.chat.defaultModel}</option>
								{models.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name || m.id}
									</option>
								))}
							</select>
						</label>
					)}
					<label className={noProject ? "mx-check locked" : "mx-check"}>
						<input type="checkbox" checked={loadProject} disabled={noProject} onChange={(event) => setProjectSettings(event.target.checked)} />
						<span>
							{t.newSession.projectSettings}
							{noProject && <small>{t.newSession.noProject}</small>}
						</span>
					</label>
					<div className="mx-quick" role="group" aria-label={t.newSession.hints}>
						<em>{t.newSession.hints}</em>
						{PROMPT_HINTS.map((id) => (
							<button key={id} type="button" className="chip" aria-pressed={hint === id} onClick={() => setHint(id)}>
								{t.newSession.hint[id]}
							</button>
						))}
					</div>
					<textarea
						className="input"
						aria-label={t.newSession.first}
						placeholder={t.newSession.firstPlaceholder(ai)}
						value={message}
						onChange={(event) => {
							setHint(null);
							setText(event.target.value);
						}}
					/>
					{full && <p className="note mx-hint">{victim !== undefined ? t.newSession.park(victim.title) : t.newSession.queue}</p>}
					{error !== "" && (
						<p className="mx-error" role="alert">
							{error}
						</p>
					)}
					<div className="dlg-foot mx-new-foot">
						<button type="button" className="btn" onClick={onClose}>
							{t.newSession.cancel}
						</button>
						<button type="submit" className="btn btn-primary" disabled={busy}>
							{busy ? t.newSession.starting : t.newSession.start}
						</button>
					</div>
				</form>
			)}
		</Modal>
	);
}

export { isHome };
