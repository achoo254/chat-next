// "Phiên mới" (a dialog on desktop, a bottom sheet on phones): the AI when the
// machine has more than one, any folder (typed with suggestions, recent and
// pinned ones, or browsed with git and "sensitive" labels), the project's
// own .claude settings (off by default), and the first message. A sensitive
// folder needs an explicit "I agree", which the machine logs; it is never
// blocked. Warns which idle session will be parked when the machine is full.
import { useEffect, useState, type FormEvent } from "react";
import { ErrorCode, LoginState, ThreadState, type DirListResult } from "@achoo254/chat-proto/remote/remote";
import { navigate, paths } from "../router.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { RemoteError, type LinkState, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { aiName, errorText, providerOf } from "./use-machines.ts";
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
	const [text, setText] = useState("");
	const [askConsent, setAskConsent] = useState(false);
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
			},
			() => setListFailed(true),
		);
	};
	// Start in the home folder.
	useEffect(() => {
		link.request({ case: "dirList", value: { path: "", showHidden: false } }).then(
			(frame) => {
				if (frame.body.case === "dirListResult") {
					setListing(frame.body.value);
					setPath(frame.body.value.path);
				}
			},
			() => setListFailed(true),
		);
	}, [link]);

	const sensitive = listing !== null && listing.path === path && listing.sensitive;
	const suggestions = [...new Set([...(state.info?.recentDirs ?? []), ...(state.info?.pinnedDirs ?? [])])];
	const full = state.maxSessions > 0 && state.openSessions >= state.maxSessions;
	const victim = full
		? state.threads
				.filter((x) => x.open && x.state === ThreadState.IDLE && x.pending === 0)
				.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0))[0]
		: undefined;

	const start = (consent: boolean) => {
		if (path.trim() === "") return setError(t.newSession.needFolder);
		if (text.trim() === "") return setError(t.newSession.needText);
		if ((sensitive || askConsent) && !consent) {
			setAskConsent(true);
			return;
		}
		setBusy(true);
		setError("");
		link
			.request({
				case: "threadCreate",
				value: { provider, model, dir: path.trim(), text: text.trim(), consent: { sensitive: consent, projectSettings } },
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
					else setError(errorText(t, err, ai));
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
						{(state.info?.recentDirs.length ?? 0) > 0 && <em>{t.newSession.recent}</em>}
						{state.info?.recentDirs.map((dir) => (
							<button key={`r:${dir}`} type="button" className="chip" onClick={() => browse(dir)} title={dir}>
								{dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir}
							</button>
						))}
						{(state.info?.pinnedDirs.length ?? 0) > 0 && <em>{t.newSession.pinned}</em>}
						{state.info?.pinnedDirs.map((dir) => (
							<button key={`p:${dir}`} type="button" className="chip" onClick={() => browse(dir)} title={dir}>
								<MachineIcon name="star" small />
								{dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir}
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
				<textarea
					className="input"
					aria-label={t.newSession.first}
					placeholder={t.newSession.firstPlaceholder(ai)}
					value={text}
					onChange={(event) => setText(event.target.value)}
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
