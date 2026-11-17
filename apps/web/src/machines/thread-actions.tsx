// Archiving and deleting a session (tunelo 2.0.6+), from the session's own
// menu and from its row in the AI Agent column. Archiving only hides it on
// every device. Deleting asks first and says where things go: the machine
// moves Claude's record of the session and the files sent in it to its
// Trash, where they can be restored. That one confirmation is all: a turn
// running is stopped and a session open elsewhere on the machine is deleted
// all the same, with no second question. A session whose AI runs in the machine's terminal has that terminal stopped
// first: left running, its CLI would outlive the session as a nameless shell.
import { useState } from "react";
import { ThreadState, type MachineInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { AGENT_SAFE_CLOSE, AGENT_THREAD_ACTIONS, versionAtLeast } from "./agent-version.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { endOnPurpose, forgetEnded } from "../terminal/ended-sessions.ts";
import { errorText } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type ThreadLink = Pick<MachineLink, "request">;

/** The machine deletes and archives sessions. */
export function threadActionsSupported(info: MachineInfo | null): boolean {
	return versionAtLeast(info?.agentVersion ?? "", AGENT_THREAD_ACTIONS);
}

/**
 * The session's AI is open on the machine with nothing going on, so it can be
 * closed (its history kept): not mid-turn, not waiting for the user, not
 * queued, and not held by a terminal (which has its own way to stop it).
 */
export function threadClosable(thread: Pick<ThreadSummary, "open" | "state" | "pending" | "terminalSession">, info: Pick<MachineInfo, "agentVersion"> | null): boolean {
	// An older machine closes even a running session, cutting its turn off: not offered there.
	if (!versionAtLeast(info?.agentVersion ?? "", AGENT_SAFE_CLOSE)) return false;
	const quiet = thread.state === ThreadState.IDLE || thread.state === ThreadState.ERROR || thread.state === ThreadState.UNSPECIFIED;
	return thread.open && quiet && thread.pending === 0 && thread.terminalSession === 0;
}

/** "Đóng phiên" (when it can be closed), "Lưu trữ" / "Bỏ lưu trữ" and "Xoá phiên", as items of an open menu. */
export function ThreadMenuItems({
	link,
	thread,
	info,
	onDelete,
	onDone,
}: {
	link: ThreadLink & Pick<MachineLink, "closeThread">;
	thread: Pick<ThreadSummary, "id" | "archived" | "open" | "state" | "pending" | "terminalSession">;
	/** The machine, for what its tunelo offers. */
	info: Pick<MachineInfo, "agentVersion"> | null;
	onDelete: () => void;
	/** The menu closes. */
	onDone: () => void;
}) {
	const t = useMachinesCopy();
	return (
		<>
			{threadClosable(thread, info) && (
				<button
					type="button"
					role="menuitem"
					title={t.agent.thread.closeHint}
					onClick={() => {
						onDone();
						link.closeThread(thread.id).catch(() => undefined);
					}}
					data-id="thread-close"
				>
					<MachineIcon name="power" small />
					<span>{t.agent.thread.close}</span>
				</button>
			)}
			<button
				type="button"
				role="menuitem"
				onClick={() => {
					onDone();
					link.request({ case: "threadSetArchived", value: { threadId: thread.id, archived: !thread.archived } }).catch(() => undefined);
				}}
			>
				<Icon name="inbox" small />
				<span>{thread.archived ? t.agent.thread.unarchive : t.agent.thread.archive}</span>
			</button>
			<button
				type="button"
				role="menuitem"
				className="danger"
				onClick={() => {
					onDone();
					onDelete();
				}}
			>
				<Icon name="trash" small />
				<span>{t.agent.thread.delete}</span>
			</button>
		</>
	);
}

/**
 * Confirms once and deletes: a turn running is stopped and a session that seems open elsewhere is deleted anyway.
 * Its AI running in the machine's terminal (`terminalSession`) is stopped there first, and nothing is deleted if
 * that fails.
 */
export function DeleteThreadDialog({
	link,
	thread,
	machineRef,
	machine,
	ai,
	onClose,
	onDeleted,
}: {
	link: ThreadLink;
	thread: Pick<ThreadSummary, "id" | "title"> & Partial<Pick<ThreadSummary, "terminalSession">>;
	/** The machine's ref, which names its terminal sessions on this page. */
	machineRef: string;
	/** The machine's name, for the words. */
	machine: string;
	ai: string;
	onClose: () => void;
	onDeleted?: () => void;
}) {
	const t = useMachinesCopy();
	const id = useDomId("delete-thread");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const terminalSession = thread.terminalSession ?? 0;
	/** The terminal holding the AI was stopped already (a retry after an error does not stop it twice). */
	const [terminalStopped, setTerminalStopped] = useState(false);
	const stopTerminal = async (): Promise<boolean> => {
		if (terminalSession === 0 || terminalStopped) return true;
		endOnPurpose(machineRef, terminalSession);
		try {
			await link.request({ case: "termClose", value: { session: terminalSession } });
			setTerminalStopped(true);
			return true;
		} catch {
			forgetEnded(machineRef, terminalSession);
			return false;
		}
	};
	const confirm = async () => {
		setBusy(true);
		setError("");
		if (!(await stopTerminal())) {
			setBusy(false);
			setError(t.agent.thread.deleteStopFailed);
			return;
		}
		link.request({ case: "threadDelete", value: { threadId: thread.id, stopRunning: true, openAnyway: true } }).then(
			() => {
				setBusy(false);
				onDeleted?.();
				onClose();
			},
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	const label = busy ? t.agent.thread.deleting : t.agent.thread.delete;
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.agent.thread.deleteTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p>{t.agent.thread.deleteBody(thread.title, machine)}</p>
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
				<button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirm()}>
					{label}
				</button>
			</div>
		</Modal>
	);
}
