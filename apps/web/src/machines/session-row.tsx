// One session in the AI Agent column: a dot when it needs the user (amber),
// runs (accent) or finished since the user last opened it, its name and a
// second line ("state · time"). Its menu (hover, or a long press on a phone)
// opens it in the terminal, archives or deletes it on machines that can
// (tunelo 2.0.6+). Disabled while its machine cannot be reached.
import { useState, useSyncExternalStore, type MouseEvent } from "react";
import type { MachineInfo, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { followInApp, navigate, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { phaseText, tokenCount } from "./activity-line.tsx";
import { useI18n } from "../i18n/i18n.tsx";
import { MachineIcon, type MachineIconName } from "./machine-icons.tsx";
import { threadStatus, type WorkStatus } from "./project-tree.ts";
import { clockText, useNow } from "./transcript/run-time.ts";
import type { Conn } from "./machine-status.ts";
import { rememberMode, rowMode, sessionPath, terminalOffered } from "./session-mode.tsx";
import { DeleteThreadDialog, ThreadMenuItems, threadActionsSupported } from "./thread-actions.tsx";
import { aiName, isRunning, modelName, stateKey, timeAgo, type MachineView } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";
import { usePopover } from "./use-popover.ts";

/** The machine's state in words, the same everywhere. */
export function connText(t: MachinesCopy, conn: Conn, now: number): string {
	switch (conn.kind) {
		case "offline":
			return conn.lastSeenMs === 0 ? t.agent.conn.never : t.agent.conn.offline(timeAgo(t, conn.lastSeenMs, now));
		case "retrying":
			return t.agent.conn.retrying(conn.attempt);
		case "unpaired":
			return conn.online ? t.agent.conn.unpaired : t.agent.conn.unpairedOffline;
		default:
			return t.agent.conn[conn.kind];
	}
}

/**
 * A session row's second line: what waits for the user first, then the tool
 * running now, the last message (tunelo 2.0.2+), else the state or model.
 * A session opened with no message (it has no name yet) says so.
 */
export function rowLine(t: MachinesCopy, thread: ThreadSummary, info: MachineInfo | null, terminalAsIcon = false): string {
	const key = stateKey(thread);
	if (key === "waiting") return t.agent.sub.waiting;
	// The column shows a terminal-held session with an icon; the words stay for other lists.
	if (thread.terminalSession > 0 && !terminalAsIcon) return isRunning(thread) ? t.agent.sub.inTerminal : t.agent.sub.openInTerminal;
	if (thread.previewTool !== "") return t.agent.sub.tool(thread.previewTool);
	if (thread.preview !== "") return thread.preview;
	if (key === "running" || key === "queued" || key === "error") return t.agent.sub[key];
	if (thread.title === "") return t.agent.sub.empty;
	if (!thread.open) return t.agent.sub.parked;
	const model = thread.model === "" ? aiName(info, thread.provider) : modelName(info, thread.provider, thread.model);
	return (info?.providers.length ?? 0) > 1 ? `${aiName(info, thread.provider)} · ${model}` : model;
}

/**
 * A row's own icon (folder, branch, the AI's spark), or its state in its place
 * while it has one to show: spinner, check, alert or cross; dimmed while
 * offline. One column carries both, so a calm list wastes no space on an empty
 * status column. `who` (the AI's name on a session) leads the label.
 */
export function StatusGlyph({ status, icon, who, offline = false }: { status: WorkStatus; icon: MachineIconName; who?: string; offline?: boolean }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const state = offline ? p.offlineStatus(p.status[status]) : p.status[status];
	const label = who === undefined ? state : `${who} · ${state}`;
	return (
		<span className={`mx-glyph ${status}`} data-offline={offline ? "" : undefined} role="img" aria-label={label} title={label}>
			<MachineIcon name={GLYPHS[status] ?? icon} small />
		</span>
	);
}

/** The list's clock is coarse (it ticks every 30 s): an activity older than the turn by more than this is an earlier turn's. */
const EARLIER_TURN_MS = 60_000;

// Held by a terminal is calm, not work: the row keeps its own icon, as idle does, since its second line already shows the terminal icon.
const GLYPHS: Partial<Record<WorkStatus, MachineIconName>> = { need: "alert-circle", failed: "x-circle", running: "spinner", done: "check-circle" };

/**
 * The second line: while the machine reports the turn live (the open
 * session, tunelo 2.5.0+), what it does now, how long it has run and its
 * tokens ("Đang chạy Bash · 27 giây · ↓ 1,2K token"), ticking each second;
 * else the line of rowLine. A session in the machine's terminal says so with
 * an icon.
 */
function RowActivity({ machine, thread, fallback, now: listNow }: { machine: MachineView; thread: ThreadSummary; fallback: string; now: number }) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const latest = useSyncExternalStore(machine.link.onActivity, () => machine.link.activity(thread.id));
	const working = isRunning(thread) && !thread.busyElsewhere;
	// A turn that started while this row showed: an activity from before it belongs to an earlier turn.
	const [was, setWas] = useState(working);
	const [since, setSince] = useState<number | null>(null);
	if (working !== was) {
		setWas(working);
		setSince(working ? listNow : null);
	}
	const live = working && latest !== undefined && (since === null || Number(latest.turnStartedAt) + EARLIER_TURN_MS >= since);
	const now = useNow(live);
	// A turn running in the terminal, or its AI only waiting there at its prompt.
	const held = isRunning(thread) ? t.agent.sub.inTerminal : t.agent.sub.openInTerminal;
	// Which view the session lives in: a terminal hold says how, otherwise "Trò chuyện" or "Terminal".
	const mode = rowMode(machine.entry.ref, thread);
	const modeLabel = thread.terminalSession > 0 ? held : t.terminal.mode[mode];
	let text = fallback;
	if (live) {
		const parts = [phaseText(t, latest), clockText(now - Number(latest.turnStartedAt), t, locale)];
		if (latest.outputTokens !== undefined) parts.push(t.transcript.activity.tokens(tokenCount(latest.outputTokens, locale)));
		text = parts.join(" · ");
	}
	return (
		<span className="sub" data-live={live ? "" : undefined}>
			<span className="mx-row-mode" role="img" aria-label={modeLabel} title={modeLabel} data-mode={mode}>
				<MachineIcon name={mode === "terminal" ? "terminal" : "chat"} small />
			</span>
			{text}
		</span>
	);
}

export function SessionRow({ machine, thread, now, current, done }: { machine: MachineView; thread: ThreadSummary; now: number; current: boolean; done: boolean }) {
	const t = useMachinesCopy();
	const key = stateKey(thread);
	const sub = rowLine(t, thread, machine.state.info, true);
	const manage = threadActionsSupported(machine.state.info) && machine.state.status.kind === "open";
	const { open, setOpen, ref } = usePopover();
	const [deleting, setDeleting] = useState(false);
	const online = machine.conn.kind === "on" || current;
	const ref_ = machine.entry.ref;
	const inTerminal = terminalOffered(machine.state.info, thread.provider);
	const status = threadStatus(thread, done);
	const path = sessionPath(ref_, thread.id, inTerminal);
	const ai = aiName(machine.state.info, thread.provider);
	const content = (
		<>
			<span className="tx">
				<span className="line">
					<StatusGlyph status={status} icon="spark" who={ai} offline={machine.conn.kind !== "on"} />
					<span className="name">{thread.title || t.agent.newSession}</span>
					{thread.pending > 0 && (
						<span className="badge" aria-label={t.sessions.waiting(thread.pending)}>
							{thread.pending}
						</span>
					)}
					<time>{timeAgo(t, Number(thread.updatedAt), now)}</time>
				</span>
				<span className="line">
					<RowActivity machine={machine} thread={thread} fallback={sub} now={now} />
				</span>
			</span>
		</>
	);
	const row = online ? (
		// A plain anchor (not Link): the row is one of the column's arrow-key rows, and a long press on a phone (or a right click) opens its menu.
		<a
			href={path}
			className={`mx-srow slim ${key}`}
			aria-current={current ? "page" : undefined}
			data-row=""
			onClick={(event) => followInApp(event, path)}
			onContextMenu={
				manage
					? (event: MouseEvent) => {
							event.preventDefault();
							setOpen(true);
						}
					: undefined
			}
		>
			{content}
		</a>
	) : (
		<div className={`mx-srow slim ${key} disabled`} aria-disabled="true" title={t.agent.openDisabled(connText(t, machine.conn, now))}>
			{content}
		</div>
	);
	if (!manage) return row;
	return (
		<div className="mx-srow-wrap" ref={ref} data-open={open ? "" : undefined}>
			{row}
			<button type="button" className="icon-btn mx-srow-menu" aria-label={t.agent.thread.rowMenu(thread.title)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
				<Icon name="dots" small />
			</button>
			{open && (
				<div className="mx-menu" role="menu" aria-label={t.agent.thread.rowMenu(thread.title)}>
					{inTerminal && (
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setOpen(false);
								rememberMode(ref_, "terminal");
								navigate(aiPaths.sessionTerminal(ref_, thread.id));
							}}
						>
							<MachineIcon name="terminal" small />
							<span>{t.terminal.openInTerminal}</span>
						</button>
					)}
					<ThreadMenuItems link={machine.link} thread={thread} onDelete={() => setDeleting(true)} onDone={() => setOpen(false)} />
				</div>
			)}
			{deleting && (
				<DeleteThreadDialog
					link={machine.link}
					thread={thread}
					machine={machine.entry.name}
					ai={aiName(machine.state.info, thread.provider)}
					onClose={() => setDeleting(false)}
					onDeleted={() => {
						if (current) navigate(paths.machines());
					}}
				/>
			)}
		</div>
	);
}
