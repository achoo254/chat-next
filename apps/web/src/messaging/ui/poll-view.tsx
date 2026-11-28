// A poll in a message: the question, its answers and, once the user voted or the
// poll closed, the results with a bar per answer. A single-answer poll votes on the
// click; a multiple-answer one takes the ticked answers with "Bình chọn". A quiz
// marks the right answer and the user's wrong one once the server tells it. The
// sender stops the poll with a second click on "Kết thúc bình chọn". Loaded with the
// first poll a chat shows.
import { useState, type ReactNode } from "react";
import type { Poll } from "@achoo254/chat-core";
import { Icon } from "../../components/icon.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import { useUi } from "./ui-context.tsx";
import { ReactorAvatars } from "./message-item.tsx";
import "./poll-view.css";

/** Code.FailedPrecondition of @connectrpc/connect (gRPC status 9). */
const FAILED_PRECONDITION = 9;

/** True when the server refused a vote because the poll belongs to the chat's synced app. */
export function isPollExternal(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code: unknown = "code" in err ? err.code : undefined;
	const rawMessage: unknown = "rawMessage" in err ? err.rawMessage : undefined;
	return code === FAILED_PRECONDITION && typeof rawMessage === "string" && rawMessage.startsWith("poll_external");
}

/** Share of the voters who chose an answer, in whole percent. */
export function pollPercent(count: number, voters: number): number {
	return voters > 0 ? Math.round((count / voters) * 100) : 0;
}

interface PollViewProps {
	chatId: number;
	seq: number;
	poll: Poll;
	/** The user sent the poll: they may stop it. */
	mine: boolean;
	/** A copy of the message (a quote, a preview): nothing to press. */
	inert: boolean;
	/** The time of the message, after the poll. */
	stamp: ReactNode;
}

export default function PollView({ chatId, seq, poll, mine, inert, stamp }: PollViewProps) {
	"use no memo";
	const copy = useScreensCopy().pollView;
	const { remote, toasts } = useServices();
	const ui = useUi();
	const [ticked, setTicked] = useState<readonly number[]>([]);
	// A vote or a closing keeps the buttons off until the poll it changes comes back
	// (the realtime update), not only until the call answers; a few seconds at most.
	const shown = `${poll.chosen.join(",")}|${poll.closed ? 1 : 0}`;
	const [waiting, setWaiting] = useState<string | null>(null);
	if (waiting !== null && waiting !== shown && waiting !== "call") setWaiting(null);
	const busy = waiting !== null;
	const [confirmClose, setConfirmClose] = useState(false);
	const voted = poll.chosen.length > 0;
	const results = voted || poll.closed;
	const canVote = !inert && !poll.closed && !voted && !busy;
	const run = (call: Promise<void>, after?: () => void) => {
		setWaiting("call");
		call
			.then(() => {
				after?.();
				setWaiting(shown);
				setTimeout(() => setWaiting(null), 5000);
			})
			.catch((err: unknown) => {
				setWaiting(null);
				toasts.show(isPollExternal(err) ? copy.external : copy.failed);
			});
	};
	const vote = (options: readonly number[]) => run(remote.votePoll(chatId, seq, options), () => setTicked([]));
	// The latest faces of the whole poll beside its kind, as Telegram shows them.
	const faces = results && !poll.resultsHidden ? [...new Set(poll.recentVoters.flat())].slice(0, 3) : [];
	const kind = poll.closed ? copy.closed : poll.quiz ? copy.quiz : poll.publicVoters ? copy.public : copy.anonymous;
	const pick = (i: number) => {
		if (!canVote) return;
		if (!poll.multiple) {
			vote([i]);
			return;
		}
		setTicked((now) => (now.includes(i) ? now.filter((x) => x !== i) : [...now, i].sort((a, b) => a - b)));
	};
	return (
		<div className="poll" data-id="poll">
			<p className="poll-question">{poll.question}</p>
			<p className="poll-kind">
				{kind}
				{faces.length > 0 && <ReactorAvatars ids={faces} more={0} />}
				{poll.multiple && !results && <> · {copy.multipleHint}</>}
			</p>
			<ul className="poll-options" data-id="poll-options">
				{poll.options.map((text, i) => {
					const count = poll.counts[i] ?? 0;
					const percent = pollPercent(count, poll.voters);
					const chosen = poll.chosen.includes(i);
					const right = poll.quiz && poll.correct.includes(i);
					const wrong = poll.quiz && chosen && poll.correct.length > 0 && !right;
					const mark = right ? "check" : wrong ? "x" : chosen ? "check" : null;
					const label = poll.resultsHidden ? text : copy.option(text, count, percent, chosen);
					return (
						<li key={i} data-id={`poll-option-${i}`}>
							{results ? (
								<div className={`poll-result${chosen ? " chosen" : ""}${right ? " right" : ""}${wrong ? " wrong" : ""}`} aria-label={label}>
									<span className="poll-percent" aria-hidden="true">
										{poll.resultsHidden ? "" : `${percent}%`}
									</span>
									<span className="poll-text" aria-hidden="true">
										{text}
										{mark !== null && <Icon name={mark} />}
									</span>
									{!poll.resultsHidden && (
										<span className="poll-count" aria-hidden="true">
											{count}
											{(poll.recentVoters[i]?.length ?? 0) > 0 && <ReactorAvatars ids={poll.recentVoters[i] ?? []} more={0} />}
										</span>
									)}
									{!poll.resultsHidden && (
										<span className="poll-track" aria-hidden="true">
											<span className="poll-bar" style={{ width: `${percent}%` }} />
										</span>
									)}
								</div>
							) : (
								<button
									type="button"
									className="poll-choice"
									role={poll.multiple ? "checkbox" : undefined}
									aria-checked={poll.multiple ? ticked.includes(i) : undefined}
									disabled={!canVote}
									onClick={() => pick(i)}
								>
									<span className={poll.multiple ? "poll-box" : "poll-dot"} aria-hidden="true">
										{ticked.includes(i) && <Icon name="check" />}
									</span>
									{text}
								</button>
							)}
						</li>
					);
				})}
			</ul>
			{poll.quiz && results && poll.explanation !== "" && (
				<p className="poll-explanation">
					<b>{copy.explanation}:</b> {poll.explanation}
				</p>
			)}
			<div className="poll-foot">
				<span className="poll-voters">{poll.resultsHidden ? copy.hidden : copy.voters(poll.voters)}</span>
				{poll.publicVoters && results && !poll.resultsHidden && poll.voters > 0 && !inert && (
					<button type="button" className="btn btn-sm" data-id="poll-show-voters" onClick={() => ui.dialog.set({ kind: "pollVoters", chatId, seq })}>
						{copy.showVoters(poll.voters)}
					</button>
				)}
				{poll.multiple && !results && !inert && (
					<button type="button" className="btn btn-sm" data-id="poll-vote" disabled={!canVote || ticked.length === 0} onClick={() => vote(ticked)}>
						{copy.vote}
					</button>
				)}
				{voted && !poll.closed && !poll.quiz && !inert && (
					<button type="button" className="btn btn-sm" data-id="poll-retract" disabled={busy} onClick={() => vote([])}>
						{copy.retract}
					</button>
				)}
				{mine && !poll.closed && !inert && (
					<button
						type="button"
						className="btn btn-sm"
						data-id="poll-close"
						disabled={busy}
						onClick={() => (confirmClose ? run(remote.closePoll(chatId, seq)) : setConfirmClose(true))}
						onBlur={() => setConfirmClose(false)}
					>
						{confirmClose ? copy.closeConfirm : copy.close}
					</button>
				)}
				{stamp}
			</div>
		</div>
	);
}
