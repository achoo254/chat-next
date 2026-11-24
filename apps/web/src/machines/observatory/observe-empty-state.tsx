// The Observe view of a thread with no recorded Claude Code session, in one
// of three ways (emptyStateOf):
// - never: the thread has had no conversation (or is having its first, which
//   a machine with Observatory records from its start); the first message
//   starts a session and Observatory records it from there;
// - notRecorded: the thread's session was opened before Observatory was on,
//   so nothing of it is recorded; "Mở lại phiên để bắt đầu ghi" reopens it
//   (its terminal after a confirmation, or its chat session) so it is
//   recorded from then on;
// - elsewhere: the session runs elsewhere on the machine (an IDE, a terminal
//   outside tunelo): reopening is not offered, the viewer is told how to
//   record it there.
// The button is locked, with the reason under it, while the thread runs a
// turn, and gone once the session was reopened (the view then asks for the
// thread's sessions again until the recorded one shows). What reopening does
// is the page's (session-chat.tsx): this view knows only its kind and how to
// run it.
import type { ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { ConfirmDialog } from "../../messaging/bots/dialogs.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { relaunchErrorText, type RelaunchKind } from "./relaunch-session.ts";

export type EmptyStateKind = "never" | "notRecorded" | "elsewhere";

/** What the empty view reads of the thread: its last message's line ("" before any) and whether it is busy here or elsewhere. */
export type ObserveThread = Pick<ThreadSummary, "preview" | "busyElsewhere"> & {
	/** A turn runs (or waits, or is queued) on the machine. */
	readonly running: boolean;
};

/** Reopening the thread's session, as the page offers it. */
export interface RelaunchAction {
	readonly kind: RelaunchKind;
	/** Why it cannot be done now (a turn running); absent when it can. */
	readonly blocked?: string;
	run(): Promise<void>;
}

/** Which empty view a thread gets; no thread known (a page with no thread to reopen) reads as one with no session yet. */
export function emptyStateOf(thread: ObserveThread | undefined): EmptyStateKind {
	if (thread === undefined) return "never";
	if (thread.busyElsewhere) return "elsewhere";
	// A thread that had a conversation has a session opened before. One having its first turn (no line yet) opened
	// its session just now, which this machine records: nothing to reopen.
	return thread.preview !== "" ? "notRecorded" : "never";
}

export interface ObserveEmptyStateProps {
	readonly thread: ObserveThread | undefined;
	readonly relaunch: RelaunchAction | undefined;
	/** The session was reopened this way while the view was open (the view is asked again afterwards). */
	readonly reopened: RelaunchKind | null;
	readonly onReopened: (kind: RelaunchKind) => void;
}

export function ObserveEmptyState({ thread, relaunch, reopened, onReopened }: ObserveEmptyStateProps) {
	const copy = useMachinesCopy();
	const t = copy.observe.empty;
	const kind = emptyStateOf(thread);
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// Reopened once: the session just opened again is recorded, a second reopen would only cut it off.
	const offered = kind !== "never" && relaunch !== undefined && reopened === null;
	const locked = kind === "elsewhere" || relaunch?.blocked !== undefined;

	const run = async (): Promise<void> => {
		if (relaunch === undefined) return;
		setBusy(true);
		setError("");
		try {
			await relaunch.run();
			setAsking(false);
			onReopened(relaunch.kind);
		} catch (err) {
			setAsking(false);
			setError(relaunchErrorText(copy, err));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mx-body" data-id="observe-empty" data-kind={kind}>
			<div className="note mx-group-note" role="status">
				<p>{kind === "never" ? t.never : t.notRecorded}</p>
				{kind === "elsewhere" && (
					<p data-id="observe-elsewhere">
						{t.elsewhere} <code>{t.elsewhereCommand}</code>
					</p>
				)}
				{offered && kind !== "elsewhere" && relaunch.blocked !== undefined && <p data-id="observe-relaunch-blocked">{relaunch.blocked}</p>}
				{reopened !== null && <p data-id="observe-reopened">{reopened === "terminal" ? t.doneTerminal : t.doneChat}</p>}
			</div>
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
			{offered && (
				<div className="acts">
					<button
						type="button"
						className="btn btn-sm"
						disabled={locked || busy}
						aria-busy={busy}
						onClick={() => (relaunch.kind === "terminal" ? setAsking(true) : void run())}
						data-id="observe-relaunch"
					>
						{busy && !asking ? t.relaunching : t.relaunch}
					</button>
				</div>
			)}
			{asking && (
				<ConfirmDialog
					title={t.confirmTitle}
					body={<p>{t.confirmBody}</p>}
					action={t.confirm}
					busyLabel={t.relaunching}
					busy={busy}
					danger={false}
					onConfirm={() => void run()}
					onClose={() => {
						if (!busy) setAsking(false);
					}}
				/>
			)}
		</div>
	);
}
