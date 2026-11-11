// One session in the AI Agent column: a dot when it needs the user (amber),
// runs (accent) or finished since the user last opened it, its name and a
// second line ("state · time"). Its menu (hover, or a long press on a phone)
// opens it in the terminal, archives or deletes it on machines that can
// (tunelo 2.0.6+). Disabled while its machine cannot be reached.
import { useState, type MouseEvent } from "react";
import type { MachineInfo, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { Link, navigate, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import type { MachinesCopy } from "./copy-vi.ts";
import { MachineIcon } from "./machine-icons.tsx";
import type { Conn } from "./machine-status.ts";
import { rememberMode, sessionPath, terminalOffered } from "./session-mode.tsx";
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
export function rowLine(t: MachinesCopy, thread: ThreadSummary, info: MachineInfo | null): string {
	const key = stateKey(thread);
	if (key === "waiting") return t.agent.sub.waiting;
	if (thread.terminalSession > 0) return t.agent.sub.inTerminal;
	if (thread.previewTool !== "") return t.agent.sub.tool(thread.previewTool);
	if (thread.preview !== "") return thread.preview;
	if (key === "running" || key === "queued" || key === "error") return t.agent.sub[key];
	if (thread.title === "") return t.agent.sub.empty;
	if (!thread.open) return t.agent.sub.parked;
	const model = thread.model === "" ? aiName(info, thread.provider) : modelName(info, thread.provider, thread.model);
	return (info?.providers.length ?? 0) > 1 ? `${aiName(info, thread.provider)} · ${model}` : model;
}

export function SessionRow({ machine, thread, now, current, done }: { machine: MachineView; thread: ThreadSummary; now: number; current: boolean; done: boolean }) {
	const t = useMachinesCopy();
	const key = stateKey(thread);
	const sub = rowLine(t, thread, machine.state.info);
	const manage = threadActionsSupported(machine.state.info) && machine.state.status.kind === "open";
	const { open, setOpen, ref } = usePopover();
	const [deleting, setDeleting] = useState(false);
	const online = machine.conn.kind === "on" || current;
	const ref_ = machine.entry.ref;
	const inTerminal = terminalOffered(machine.state.info, thread.provider);
	const dot = key === "waiting" ? "need" : isRunning(thread) || thread.terminalSession > 0 ? "run" : done ? "done" : "";
	const content = (
		<>
			<span className={`mx-sdot ${dot}`} aria-hidden="true" />
			<span className="tx">
				<span className="line">
					<span className="name">{thread.title || t.agent.newSession}</span>
					{thread.pending > 0 && (
						<span className="badge" aria-label={t.sessions.waiting(thread.pending)}>
							{thread.pending}
						</span>
					)}
				</span>
				<span className="line">
					<span className="sub">
						{sub} · <time>{timeAgo(t, Number(thread.updatedAt), now)}</time>
					</span>
				</span>
			</span>
		</>
	);
	const row = online ? (
		<Link
			to={sessionPath(ref_, thread.id, inTerminal)}
			className={`mx-srow slim ${key}`}
			current={current}
			// A long press on a phone (or a right click) opens the row's menu.
			{...(manage
				? {
						onContextMenu: (event: MouseEvent) => {
							event.preventDefault();
							setOpen(true);
						},
					}
				: {})}
		>
			{content}
		</Link>
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
