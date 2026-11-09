// "Phiên mới" (a dialog on desktop, a bottom sheet on phones): the AI when the
// machine has more than one, any folder (typed with suggestions, recent and
// pinned ones, or browsed with git and "sensitive" labels; it opens in the
// folder of the newest session), the project's own .claude settings (off by
// default), and the first message, filled in with a suggestion that follows
// the folder until the user edits it or picks another one. A sensitive
// folder needs an explicit "I agree", which the machine logs; it is never
// blocked. Project settings in a folder the machine does not trust yet ask
// for "Trust this folder" right here (the machine logs that too). Warns which
// idle session will be parked when the machine is full.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorCode, LoginState, ThreadState, type DirListResult } from "@achoo254/chat-proto/remote/remote";
import { navigate, paths } from "../router.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { PROMPT_HINTS, folderName, hintPrompt, recentFolders, type PromptHint } from "./new-session-hints.ts";
import { machineErrorText, needsProjectTrust } from "./machine-errors.ts";
import { aiName, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

interface NewSessionProps {
	machine: string;
	name: string;
	link: MachineLink;
	state: LinkState;
	onClose: () => void;
}

function joinPath(dir: string, child: string): string {
	const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
	return dir.endsWith(sep) ? `${dir}${child}` : `${dir}${sep}${child}`;
}

export function NewSession({ machine, name, link, state, onClose }: NewSessionProps) {
	const t = useMachinesCopy();
	const titleId = useDomId("new-session");
	const listId = useDomId("dirs");
	const providers = state.info?.providers ?? [];
	const [provider, setProvider] = useState(() => providers.find((p) => p.loginState !== LoginState.NEEDS_LOGIN)?.id ?? providers[0]?.id ?? "claude");
	const [model, setModel] = useState("");
	const [path, setPath] = useState("");
	const [listing, setListing] = useState<DirListResult | null>(null);
	const [listFailed, setListFailed] = useState(false);
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
		setListFailed(false);
		link.request({ case: "dirList", value: { path: dir, showHidden: false } }).then(
			(frame) => {
				if (frame.body.case !== "dirListResult") return;
				setListing(frame.body.value);
				setPath(frame.body.value.path);
				setAskConsent(false);
				setAskTrust("");
			},
			() => setListFailed(true),
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
			.catch(() => setListFailed(true));
	}, [link, ready, startDir]);

	const sensitive = listing !== null && listing.path === path && listing.sensitive;
	const pinned = state.info?.pinnedDirs ?? [];
	const suggestions = [...new Set([...recent, ...pinned])];
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
				value: { provider, model, dir, text: first, consent: { sensitive: consent, projectSettings, trustProject: projectSettings && trust } },
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
			<form className="dlg-body mx-new" onSubmit={onSubmit}>
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
							list={listId}
							value={path}
							spellCheck={false}
							autoComplete="off"
							onChange={(event) => {
								setPath(event.target.value);
								setAskConsent(false);
								setAskTrust("");
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") {
									event.preventDefault();
									browse(path.trim());
								}
							}}
						/>
						<button type="button" className="btn btn-sm" onClick={() => browse(path.trim())}>
							{t.newSession.go}
						</button>
						<datalist id={listId}>
							{suggestions.map((dir) => (
								<option key={dir} value={dir} />
							))}
							{listing?.entries.map((entry) => (
								<option key={`e:${entry.name}`} value={joinPath(listing.path, entry.name)} />
							))}
						</datalist>
					</div>
					{listing !== null && (
						<div className="mx-crumbs">
							{listing.parent !== "" && (
								<button type="button" className="icon-btn" aria-label={t.newSession.up} onClick={() => browse(listing.parent)}>
									<MachineIcon name="arrow-up" small />
								</button>
							)}
							<b className="mono">{listing.path}</b>
							{listing.sensitive && <small className="mx-tag danger">{t.newSession.sensitive}</small>}
						</div>
					)}
					{listFailed && <p className="mx-error">{t.newSession.listFailed}</p>}
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
				{askTrust !== "" && askTrust === path.trim() && projectSettings && (
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
				<label className="mx-check">
					<input type="checkbox" checked={projectSettings} onChange={(event) => setProjectSettings(event.target.checked)} />
					<span>{t.newSession.projectSettings}</span>
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
		</Modal>
	);
}
