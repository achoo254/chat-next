// "Phiên có sẵn trên máy" in the "Phiên mới" dialog: the Claude Code sessions
// the machine keeps, whatever started them (a terminal, an IDE, Claude
// Desktop, Chat itself), grouped by folder, newest first, searchable, a page
// at a time. Opening one makes it a thread with its history shown at once;
// the next message resumes the same session on the machine. A session that
// seems open elsewhere on the machine asks first; a sensitive folder and
// project settings ask as for a new session. Loaded only when the tab opens.
import { useEffect, useState } from "react";
import { ErrorCode, type LocalSession, type SessionDir } from "@achoo254/chat-proto/remote/remote";
import { brand } from "../brand.ts";
import { navigate, paths } from "../router.tsx";
import { RemoteError, type MachineLink } from "./link/machine-link.ts";
import { machineErrorText, needsProjectTrust, openElsewhere } from "./machine-errors.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName, isHome } from "./new-session-hints.ts";
import { timeAgo, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import type { MachinesCopy } from "./copy-vi.ts";

export interface ExistingSessionsProps {
	machine: string;
	name: string;
	link: MachineLink;
	/** The AI's name, as the machine reports it. */
	ai: string;
	/** The machine's home folder ("" when unknown). */
	home: string;
	onClose: () => void;
}

const PAGE = 30;
const SEARCH_DELAY_MS = 250;

/** What the user agreed to for one session so far. */
interface Agreed {
	readonly sensitive: boolean;
	readonly anyway: boolean;
	readonly trust: boolean;
}

interface Ask {
	readonly kind: "elsewhere" | "sensitive" | "trust";
	readonly session: LocalSession;
	readonly agreed: Agreed;
}

const NOTHING_AGREED: Agreed = { sensitive: false, anyway: false, trust: false };

/** The sessions shown, and which search, folder and page they answer (`key`). */
interface Listed {
	readonly key: string | null;
	readonly sessions: readonly LocalSession[];
	readonly dirs: readonly SessionDir[];
	readonly total: number;
	readonly error: string;
}

const EMPTY_LIST: Listed = { key: null, sessions: [], dirs: [], total: 0, error: "" };

/** "app": a session of this app already (shown with the app's name); the rest by what started it. */
type Source = keyof MachinesCopy["existing"]["source"] | "app";

/** Where the session came from, for its label; null when the machine does not say. */
function sourceOf(session: LocalSession): Source | null {
	if (session.threadId !== "") return "app";
	if (session.entrypoint === "cli") return "terminal";
	if (session.entrypoint.includes("desktop")) return "desktop";
	return session.entrypoint === "" ? null : "other";
}

/** Sessions in the order shown, under their folder (folders in the order their newest session comes). */
function byFolder(sessions: readonly LocalSession[]): [string, LocalSession[]][] {
	const groups = new Map<string, LocalSession[]>();
	for (const session of sessions) {
		const group = groups.get(session.dir);
		if (group === undefined) groups.set(session.dir, [session]);
		else group.push(session);
	}
	return [...groups.entries()];
}

/** The folder with the home folder written as "~". */
function shortDir(dir: string, home: string): string {
	if (home !== "" && (dir === home || dir.startsWith(`${home}/`) || dir.startsWith(`${home}\\`))) return `~${dir.slice(home.length)}`;
	return dir;
}

/** `value`, once it stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setSettled(value), ms);
		return () => window.clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

export default function ExistingSessions({ machine, name, link, ai, home, onClose }: ExistingSessionsProps) {
	const t = useMachinesCopy();
	const c = t.existing;
	const now = useNow();
	const [query, setQuery] = useState("");
	const search = useSettled(query.trim(), SEARCH_DELAY_MS);
	const [dir, setDir] = useState("");
	// Pages asked for, for this search and folder; another search or folder starts again at one.
	const [more, setMore] = useState({ key: "", pages: 1 });
	const filterKey = `${search}\n${dir}`;
	const pages = more.key === filterKey ? more.pages : 1;
	const requestKey = `${filterKey}\n${pages}`;
	const [result, setResult] = useState<Listed>(EMPTY_LIST);
	const [projectSettings, setProjectSettings] = useState(false);
	const [ask, setAsk] = useState<Ask | null>(null);
	const [opening, setOpening] = useState("");
	const [openError, setOpenError] = useState("");

	useEffect(() => {
		// An answer to an older search or page is dropped.
		let current = true;
		const offset = (pages - 1) * PAGE;
		link.request({ case: "sessionList", value: { query: search, dir, offset, limit: PAGE } }).then(
			(frame) => {
				if (!current || frame.body.case !== "sessionListResult") return;
				const page = frame.body.value;
				setResult((shown) => ({
					key: requestKey,
					sessions: offset === 0 ? page.sessions : [...shown.sessions, ...page.sessions],
					dirs: page.dirs,
					total: page.total,
					error: "",
				}));
			},
			(err: unknown) => {
				if (current) setResult((shown) => ({ ...shown, key: requestKey, error: machineErrorText(t, err, ai) }));
			},
		);
		return () => {
			current = false;
		};
	}, [link, search, dir, pages, requestKey, t, ai]);
	const loading = result.key !== requestKey;
	const { sessions, dirs, total, error: listError } = result;

	const open = (session: LocalSession, agreed: Agreed) => {
		setOpenError("");
		if (session.threadId !== "") {
			onClose();
			navigate(paths.machineSession(machine, session.threadId));
			return;
		}
		if (session.busyElsewhere && !agreed.anyway) return setAsk({ kind: "elsewhere", session, agreed });
		if (session.sensitive && !agreed.sensitive) return setAsk({ kind: "sensitive", session, agreed });
		// As for a new session: never the project's .claude in the home folder or a sensitive one.
		const loadProject = projectSettings && !session.sensitive && !isHome(session.dir, home);
		setAsk(null);
		setOpening(session.sessionId);
		link
			.request({
				case: "sessionOpen",
				value: {
					sessionId: session.sessionId,
					consent: { sensitive: agreed.sensitive, projectSettings: loadProject, trustProject: loadProject && agreed.trust },
					openAnyway: agreed.anyway,
				},
			})
			.then(
				(frame) => {
					setOpening("");
					const thread = frame.body.case === "threadCreated" ? frame.body.value.thread : undefined;
					if (thread === undefined) return;
					onClose();
					navigate(paths.machineSession(machine, thread.id));
				},
				(err: unknown) => {
					setOpening("");
					// The machine knows better than the list: ask what it asks for.
					if (err instanceof RemoteError && err.code === ErrorCode.NEEDS_CONSENT) setAsk({ kind: "sensitive", session, agreed });
					else if (openElsewhere(err) && !agreed.anyway) setAsk({ kind: "elsewhere", session, agreed });
					else if (needsProjectTrust(err) && !agreed.trust) setAsk({ kind: "trust", session, agreed });
					else setOpenError(machineErrorText(t, err, ai));
				},
			);
	};

	const groups = byFolder(sessions);
	const filtered = search !== "" || dir !== "";

	return (
		<div className="dlg-body mx-local" data-id="existing-sessions">
			<p className="note">{c.intro(ai, name, brand.appName)}</p>
			<div className="mx-local-tools">
				<input
					className="input"
					type="search"
					aria-label={c.search}
					placeholder={c.search}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					data-id="existing-sessions-search"
				/>
				{dirs.length > 1 && (
					<select className="input" aria-label={c.folder} value={dir} onChange={(event) => setDir(event.target.value)} data-id="existing-sessions-folder">
						<option value="">{c.allFolders}</option>
						{dirs.map((d) => (
							<option key={d.dir} value={d.dir}>
								{`${shortDir(d.dir, home)} (${d.sessions})`}
							</option>
						))}
					</select>
				)}
			</div>
			{ask !== null && <AskBox ask={ask} copy={t} ai={ai} name={name} busy={opening !== ""} open={open} onCancel={() => setAsk(null)} />}
			{openError !== "" && (
				<p className="mx-error" role="alert">
					{openError}
				</p>
			)}
			<div className="mx-local-list" aria-busy={loading}>
				{listError !== "" ? (
					<p className="mx-error" role="alert">
						{listError}
					</p>
				) : sessions.length === 0 ? (
					loading ? (
						<p className="mx-local-empty" role="status">
							<span className="spin" aria-hidden="true" />
							{c.loading}
						</p>
					) : (
						<p className="mx-local-empty">{filtered ? c.noMatch : c.empty(ai)}</p>
					)
				) : (
					groups.map(([folder, list]) => (
						<section key={folder} className="mx-local-group" aria-label={folder}>
							<h3 title={folder}>
								<MachineIcon name="folder" small />
								<span className="nm">{folderName(folder)}</span>
								<small className="mono">{shortDir(folder, home)}</small>
							</h3>
							<ul>
								{list.map((session) => {
									const source = sourceOf(session);
									return (
										<li key={session.sessionId} className="mx-local-row" data-id={`existing-session-${session.sessionId}`}>
											<div className="tx">
												<b title={session.title}>{session.title}</b>
												<small>
													<span>{timeAgo(t, Number(session.updatedAt), now)}</span>
													{session.messages > 0 && <span>{c.messages(session.messages)}</span>}
													{source !== null && <span className="mx-tag">{source === "app" ? brand.appName : c.source[source]}</span>}
													{session.busyElsewhere && <span className="mx-tag warn">{c.busy}</span>}
													{session.sensitive && <span className="mx-tag danger">{t.newSession.sensitive}</span>}
												</small>
											</div>
											<button
												type="button"
												className={session.threadId === "" ? "btn btn-sm btn-primary" : "btn btn-sm"}
												disabled={opening !== ""}
												onClick={() => open(session, NOTHING_AGREED)}
												aria-label={`${session.threadId === "" ? c.open : c.view}: ${session.title}`}
											>
												{opening === session.sessionId ? c.opening : session.threadId === "" ? c.open : c.view}
											</button>
										</li>
									);
								})}
							</ul>
						</section>
					))
				)}
			</div>
			<div className="mx-local-foot">
				<label className="mx-check">
					<input type="checkbox" checked={projectSettings} onChange={(event) => setProjectSettings(event.target.checked)} />
					<span>{t.newSession.projectSettings}</span>
				</label>
				{sessions.length > 0 && (
					<span className="mx-local-count">
						{c.shown(sessions.length, total)}
						{sessions.length < total && (
							<button type="button" className="btn btn-sm" disabled={loading} onClick={() => setMore({ key: filterKey, pages: pages + 1 })}>
								{loading ? c.loading : c.more}
							</button>
						)}
					</span>
				)}
			</div>
			<div className="dlg-foot mx-new-foot">
				<button type="button" className="btn" onClick={onClose}>
					{t.newSession.cancel}
				</button>
			</div>
		</div>
	);
}

interface AskBoxProps {
	ask: Ask;
	copy: MachinesCopy;
	ai: string;
	name: string;
	busy: boolean;
	open: (session: LocalSession, agreed: Agreed) => void;
	onCancel: () => void;
}

/** One question before the session opens: open elsewhere, a sensitive folder, or trusting its project settings. */
function AskBox({ ask, copy: t, ai, name, busy, open, onCancel }: AskBoxProps) {
	const { session, agreed } = ask;
	const [title, body, action, more] =
		ask.kind === "elsewhere"
			? [t.existing.elsewhereTitle, t.existing.elsewhereBody, t.existing.openAnyway, { ...agreed, anyway: true }]
			: ask.kind === "sensitive"
				? [t.newSession.sensitiveTitle(session.dir), t.newSession.sensitiveBody(ai, name), t.newSession.agree, { ...agreed, sensitive: true }]
				: [t.newSession.trustTitle(session.dir), t.newSession.trustBody(ai, name), t.newSession.trust, { ...agreed, trust: true }];
	return (
		<div className="mx-warn" role="alert" data-id={`existing-sessions-ask-${ask.kind}`}>
			<b>{title}</b>
			<span>{body}</span>
			<div className="acts">
				<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => open(session, more)}>
					{action}
				</button>
				<button type="button" className="btn btn-sm" onClick={onCancel}>
					{t.existing.notNow}
				</button>
			</div>
		</div>
	);
}
