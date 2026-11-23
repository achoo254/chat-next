// "Phiên Claude Code trên máy" on a machine's page: the most recent Claude
// Code sessions the machine's Observatory recorded (ObservatorySessionList),
// including the ones started outside the app (a CLI with Observatory's hooks,
// a terminal). Each row says the repository, how the session runs, when it
// started and whether it still runs, and opens the session on the Live Map:
// in its thread's "Quan sát" tab when a thread holds it (as the machine's
// session list says), else by its own id. Advisor's own sessions are left
// out. No filter, no search.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "../../components/screen-icons.tsx";
import { Link } from "../../router.tsx";
import { openedTime } from "../../terminal/new-tab-actions.ts";
import { aiPaths } from "../ai-paths.ts";
import type { MachineLink } from "../link/machine-link.ts";
import { MachineIcon } from "../machine-icons.tsx";
import { useNow } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { LiveMapSessionInfo } from "./live-map-types.ts";
import { failureOf, failureText, listMachineSessions, threadsBySession, type ObservatoryFailure } from "./observatory-client.ts";
import { OBSERVED_PROVIDER } from "../session-mode.tsx";

/** Rows shown at most. */
export const SESSIONS_SHOWN = 20;
/** Asked of the machine: more than shown, since Advisor's own sessions are left out. */
const SESSIONS_ASKED = 40;

/** The rows to show: the user's own sessions (not Advisor's), newest first, at most SESSIONS_SHOWN. */
export function shownSessions(sessions: readonly LiveMapSessionInfo[]): LiveMapSessionInfo[] {
	return sessions
		.filter((s) => s.internalLabel === "")
		.sort((a, b) => b.startedAt - a.startedAt)
		.slice(0, SESSIONS_SHOWN);
}

export function MachineClaudeSessions({ machine, link, online }: { machine: string; link: Pick<MachineLink, "request">; online: boolean }) {
	const copy = useMachinesCopy().observe;
	const t = copy.sessions;
	const [list, setList] = useState<readonly LiveMapSessionInfo[] | null>(null);
	/** The thread holding a session, by session id. */
	const [threads, setThreads] = useState<ReadonlyMap<string, string>>(new Map());
	const [failure, setFailure] = useState<ObservatoryFailure | null>(null);
	const [loading, setLoading] = useState(false);
	const now = useNow();

	const fetchList = useCallback(
		(): Promise<void> =>
			Promise.all([
				listMachineSessions(link, SESSIONS_ASKED),
				// Without the threads every row still opens, by its session id.
				threadsBySession(link, OBSERVED_PROVIDER).catch((): ReadonlyMap<string, string> => new Map()),
			]).then(
				([sessions, held]) => {
					setFailure(null);
					setList(shownSessions(sessions));
					setThreads(held);
				},
				(err: unknown) => setFailure(failureOf(err)),
			),
		[link],
	);
	const relist = () => {
		setLoading(true);
		void fetchList().finally(() => setLoading(false));
	};

	useEffect(() => {
		if (online) void fetchList();
	}, [online, fetchList]);

	return (
		<section className="card pad mx-card mx-terms" data-id="machine-claude-sessions">
			<header className="mx-terms-head">
				<div>
					<h3>{t.title}</h3>
					<p className="note">{t.note}</p>
				</div>
				<button type="button" className="btn btn-sm mx-btn-ghost" disabled={!online || loading} onClick={relist} title={t.refresh} aria-label={t.refresh} data-id="machine-claude-sessions-refresh">
					{loading ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" small />}
				</button>
			</header>
			{!online && <p className="muted">{copy.offline}</p>}
			{online && failure !== null && (
				<p className="mx-error" role="alert">
					{failureText(copy, failure)}
				</p>
			)}
			{online && list !== null && list.length === 0 && <p className="mx-terms-empty muted">{t.empty}</p>}
			{online && list !== null && list.length > 0 && (
				<ul className="mx-terms-list">
					{list.map((s) => {
						const repo = s.projectKey === "" || s.projectKey === "scratch" ? t.noRepo : s.projectKey;
						const running = s.endedAt === 0;
						const thread = threads.get(s.sessionId);
						const open = thread === undefined ? aiPaths.observeSession(machine, s.sessionId) : aiPaths.sessionObserve(machine, thread);
						const facts = [t.source[s.source], s.startedAt > 0 ? t.startedAt(openedTime(s.startedAt, now)) : ""].filter((x) => x !== "").join(" · ");
						return (
							<li key={s.sessionId} className="mx-term" data-state={running ? "viewed" : "exited"} data-id={`machine-claude-session-${s.sessionId}`}>
								<span className="mx-term-icon" aria-hidden="true">
									<MachineIcon name="run-claude" small />
								</span>
								<span className="mx-term-text">
									<b title={s.cwd}>{repo}</b>
									<small>{facts}</small>
								</span>
								<span className={`chip mx-chip mx-term-chip ${running ? "viewed" : "exited"}`}>{running ? t.running : t.ended}</span>
								<span className="mx-term-acts">
									<Link to={open} className="btn btn-sm" aria-label={t.openOf(repo)} data-id={`machine-claude-session-open-${s.sessionId}`}>
										<MachineIcon name="run-claude" small />
										{t.open}
									</Link>
								</span>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
