// Archiving and deleting a session (tunelo 2.0.6+), from the session's own
// menu and from its row in the AI Agent column. Archiving only hides it on
// every device. Deleting asks first and says where things go: the machine
// moves Claude's record of the session and the files sent in it to its
// Trash, where they can be restored. A session running a turn asks to stop
// it first; one that seems open elsewhere on the machine warns before going on.
import { useState } from "react";
import { ErrorReason, ThreadState, type MachineInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { DialogHead, Modal, useDomId } from "../messaging/ui/parts.tsx";
import { AGENT_SAFE_CLOSE, AGENT_THREAD_ACTIONS, versionAtLeast } from "./agent-version.ts";
import { RemoteError, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
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

/** Confirms and deletes; asks again when the machine says the session runs or seems open elsewhere. */
export function DeleteThreadDialog({
	link,
	thread,
	machine,
	ai,
	onClose,
	onDeleted,
}: {
	link: ThreadLink;
	thread: Pick<ThreadSummary, "id" | "title">;
	machine: string;
	ai: string;
	onClose: () => void;
	onDeleted?: () => void;
}) {
	const t = useMachinesCopy();
	const id = useDomId("delete-thread");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [stopRunning, setStopRunning] = useState(false);
	const [openAnyway, setOpenAnyway] = useState(false);
	const [ask, setAsk] = useState<"running" | "elsewhere" | null>(null);
	const run = (stop: boolean, anyway: boolean) => {
		setBusy(true);
		setError("");
		link.request({ case: "threadDelete", value: { threadId: thread.id, stopRunning: stop, openAnyway: anyway } }).then(
			() => {
				setBusy(false);
				onDeleted?.();
				onClose();
			},
			(err: unknown) => {
				setBusy(false);
				if (err instanceof RemoteError && err.reason === ErrorReason.THREAD_RUNNING) return setAsk("running");
				if (err instanceof RemoteError && err.reason === ErrorReason.SESSION_OPEN_ELSEWHERE) return setAsk("elsewhere");
				setError(errorText(t, err, ai));
			},
		);
	};
	const confirm = () => {
		const stop = stopRunning || ask === "running";
		const anyway = openAnyway || ask === "elsewhere";
		setStopRunning(stop);
		setOpenAnyway(anyway);
		setAsk(null);
		run(stop, anyway);
	};
	const label = busy ? t.agent.thread.deleting : ask === "running" ? t.agent.thread.stopAndDelete : ask === "elsewhere" ? t.agent.thread.deleteAnyway : t.agent.thread.delete;
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={t.agent.thread.deleteTitle} onClose={onClose} />
			<div className="dlg-body stack">
				<p>{t.agent.thread.deleteBody(thread.title, machine)}</p>
				{ask === "running" && (
					<p className="mx-warn" role="alert">
						{t.agent.thread.deleteRunning(ai)}
					</p>
				)}
				{ask === "elsewhere" && (
					<p className="mx-warn" role="alert">
						{t.agent.thread.deleteElsewhere}
					</p>
				)}
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
				<button type="button" className="btn btn-danger" disabled={busy} onClick={confirm}>
					{label}
				</button>
			</div>
		</Modal>
	);
}
