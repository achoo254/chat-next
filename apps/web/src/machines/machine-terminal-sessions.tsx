// "Terminal đang chạy trên máy" on a machine's page: every session the
// machine's terminal process holds (tunelo-term-host), as TermListResult
// lists them. Each one is a real program on the machine (a shell, or an AI's
// CLI with its MCP servers) that keeps its memory whether or not a device
// shows it, so this is where they are seen and stopped: one by one, or all
// the ones no device has open at once. Stopping is TermClose (the machine
// hangs the session up); an AI's conversation stays and opens again resumed.
// An exited session only waits to be dropped from the list.
import { useCallback, useEffect, useState } from "react";
import { ErrorReason, type TermSessionInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { ConfirmDialog } from "../messaging/bots/dialogs.tsx";
import { Link } from "../router.tsx";
import { endOnPurpose, forgetEnded } from "../terminal/ended-sessions.ts";
import { openedTime } from "../terminal/new-tab-actions.ts";
import { aiPaths } from "./ai-paths.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { RemoteError, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { folderName } from "./new-session-hints.ts";
import { isRunning, useNow } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** How often the list is asked again while the page is open (sessions open and end elsewhere). */
const RELIST_MS = 30_000;

type TermState = "viewed" | "idle" | "exited";

/** Open on some device now, running with no device on it, or ended (waiting to be dropped). */
export function termState(s: Pick<TermSessionInfo, "attached" | "exited">): TermState {
	return s.exited ? "exited" : s.attached ? "viewed" : "idle";
}

const ORDER: Record<TermState, number> = { viewed: 0, idle: 1, exited: 2 };

/** Open ones first, then the ones nobody watches, the ended last; newest first in each. */
export function sortTermSessions(list: readonly TermSessionInfo[]): TermSessionInfo[] {
	return [...list].sort((a, b) => ORDER[termState(a)] - ORDER[termState(b)] || Number(b.createdAt - a.createdAt));
}

/** The thread's title for an AI's session, else what the program set, else "Shell" / "Phiên AI". */
function titleOf(t: MachinesCopy["terminal"], s: TermSessionInfo, threads: readonly ThreadSummary[]): string {
	const thread = s.threadId === "" ? undefined : threads.find((x) => x.id === s.threadId);
	return thread?.title || s.title || (s.threadId === "" ? t.shellSession : t.aiSession);
}

export function MachineTerminalSessions({ machine, link, online, threads }: { machine: string; link: Pick<MachineLink, "request">; online: boolean; threads: readonly ThreadSummary[] }) {
	const t = useMachinesCopy();
	const tt = t.terminal;
	const m = tt.manage;
	const [list, setList] = useState<readonly TermSessionInfo[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	/** A session to stop (asked first), or every unwatched one ("idle"). */
	const [asking, setAsking] = useState<TermSessionInfo | "idle" | null>(null);
	const [busy, setBusy] = useState(false);
	const now = useNow();

	/** The machine's list again; a failed ask keeps the one shown. */
	const fetchList = useCallback(
		(): Promise<void> =>
			link.request({ case: "termListRequest", value: {} }).then(
				(frame) => {
					if (frame.body.case === "termListResult") setList(frame.body.value.sessions);
				},
				() => undefined,
			),
		[link],
	);
	const relist = () => {
		setLoading(true);
		void fetchList().finally(() => setLoading(false));
	};

	useEffect(() => {
		if (!online) return;
		void fetchList();
		const timer = window.setInterval(() => {
			if (document.visibilityState === "visible") void fetchList();
		}, RELIST_MS);
		return () => window.clearInterval(timer);
	}, [online, fetchList]);

	/**
	 * Hangs the sessions up on the machine; gone from the list at once, the machine's list again after. One the
	 * machine no longer has counts as stopped; a refused one comes back (with the list as it was, if asking fails).
	 */
	const stop = async (sessions: readonly number[]) => {
		const before = list;
		setBusy(true);
		setError("");
		for (const session of sessions) endOnPurpose(machine, session);
		setList((l) => l?.filter((s) => !sessions.includes(s.session)) ?? l);
		const results = await Promise.allSettled(sessions.map((session) => link.request({ case: "termClose", value: { session } })));
		const refused = sessions.filter((session, i) => {
			const r = results[i];
			return r?.status === "rejected" && !(r.reason instanceof RemoteError && r.reason.reason === ErrorReason.TERMINAL_SESSION_NOT_FOUND);
		});
		for (const session of refused) forgetEnded(machine, session);
		setBusy(false);
		setAsking(null);
		if (refused.length > 0) {
			setError(m.failed);
			setList(before);
		}
		await fetchList();
	};

	const sorted = sortTermSessions(list ?? []);
	const viewed = sorted.filter((s) => termState(s) === "viewed").length;
	/** An AI in the middle of a turn is left out of "stop all": it is stopped one by one, knowingly. */
	const busyTurn = (s: TermSessionInfo) => s.threadId !== "" && threads.some((x) => x.id === s.threadId && isRunning(x));
	const idle = sorted.filter((s) => termState(s) === "idle" && !busyTurn(s));
	const asked = asking !== null && asking !== "idle" ? asking : null;

	return (
		<section className="card pad mx-card mx-terms" data-id="machine-terminals">
			<header className="mx-terms-head">
				<div>
					<h3>{m.title}</h3>
					<p className="note">{m.note}</p>
				</div>
				<button type="button" className="btn btn-sm mx-btn-ghost" disabled={!online || loading} onClick={relist} title={m.refresh} aria-label={m.refresh} data-id="machine-terminals-refresh">
					{loading ? <span className="spin" aria-hidden="true" /> : <Icon name="refresh" small />}
				</button>
			</header>
			{!online && <p className="muted">{t.detail.needsLink}</p>}
			{online && list !== null && sorted.length === 0 && <p className="mx-terms-empty muted">{m.empty}</p>}
			{online && sorted.length > 0 && (
				<>
					<p className="mx-terms-summary" data-id="machine-terminals-summary">
						{m.summary(sorted.length, viewed, idle.length)}
					</p>
					<ul className="mx-terms-list">
						{sorted.map((s) => {
							const state = termState(s);
							const title = titleOf(tt, s, threads);
							const open = s.threadId === "" ? aiPaths.showSession(machine, s.session) : aiPaths.sessionTerminal(machine, s.threadId);
							const facts = [s.cwd === "" ? "" : folderName(s.cwd), s.createdAt > 0n ? tt.openedAt(openedTime(Number(s.createdAt), now)) : ""].filter((x) => x !== "").join(" · ");
							return (
								<li key={s.session} className="mx-term" data-state={state} data-id={`machine-terminal-${s.session}`}>
									<span className="mx-term-icon" aria-hidden="true">
										<MachineIcon name={s.threadId === "" ? "terminal" : "ai-session"} small />
									</span>
									<span className="mx-term-text">
										<b title={title}>{title}</b>
										{facts !== "" && <small title={s.cwd}>{facts}</small>}
									</span>
									<span className={`chip mx-chip mx-term-chip ${state}`}>{state === "exited" ? tt.exitedShort(s.exitCode) : state === "viewed" ? m.viewed : m.idle}</span>
									<span className="mx-term-acts">
										{state !== "exited" && (
											<Link to={open} className="btn btn-sm" aria-label={`${m.open} ${title}`} data-id={`machine-terminal-open-${s.session}`}>
												<MachineIcon name="terminal" small />
												{m.open}
											</Link>
										)}
										{state === "exited" ? (
											<button type="button" className="btn btn-sm mx-btn-ghost" disabled={busy} onClick={() => void stop([s.session])} aria-label={`${m.remove}: ${title}`} data-id={`machine-terminal-remove-${s.session}`}>
												<Icon name="x" small />
												{m.remove}
											</button>
										) : (
											<button type="button" className="btn btn-sm danger-outline" disabled={busy} onClick={() => setAsking(s)} aria-label={m.stopOf(title)} data-id={`machine-terminal-stop-${s.session}`}>
												<MachineIcon name="power" small />
												{m.stop}
											</button>
										)}
									</span>
								</li>
							);
						})}
					</ul>
					{idle.length > 0 && (
						<div className="acts mx-terms-foot">
							<button type="button" className="btn btn-sm danger-outline" disabled={busy || !online} onClick={() => setAsking("idle")} data-id="machine-terminals-stop-idle">
								<MachineIcon name="power" small />
								{m.stopIdle(idle.length)}
							</button>
						</div>
					)}
				</>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{asked !== null && (
				<ConfirmDialog
					title={m.stopTitle}
					body={<p>{m.stopBody(titleOf(tt, asked, threads))}</p>}
					action={m.stop}
					busyLabel={m.stopping}
					busy={busy}
					danger
					onConfirm={() => void stop([asked.session])}
					onClose={() => setAsking(null)}
				/>
			)}
			{asking === "idle" && (
				<ConfirmDialog
					title={m.stopIdleTitle(idle.length)}
					body={
						<>
							<p>{m.stopIdleBody}</p>
							<ul className="mx-terms-confirm">
								{idle.map((s) => (
									<li key={s.session}>
										<MachineIcon name={s.threadId === "" ? "terminal" : "ai-session"} small />
										<span>{titleOf(tt, s, threads)}</span>
									</li>
								))}
							</ul>
						</>
					}
					action={m.stopIdle(idle.length)}
					busyLabel={m.stopping}
					busy={busy}
					danger
					onConfirm={() => void stop(idle.map((s) => s.session))}
					onClose={() => setAsking(null)}
				/>
			)}
		</section>
	);
}
