// Advisor's take on one advisor_weigh call of the session (AdvisorVerdictItem),
// titled with the name of the user's Advisor: exactly the question, options
// and context that were sent (secrets already hidden by the machine), each
// option with its probability, the verdict (confident or unsure) and
// Advisor's confidence. Asked for next steps, the options become chips: one
// tap sends that option to the session as the user's message; they stay
// dimmed while a turn runs (sending then would land in the wrong turn), and
// they are spent for good once the user sent anything after the card (read
// from the transcript, so a reload does not bring them back). An option
// that would run as a command ("/…", "!…") is never a chip.
// Advisor did not answer: only why, worded by its code, no chips. The call's
// raw input is never shown (Advisor may have refused to send it).
// Also the quiet line under a turn whose AI never asked for next steps.
import { useState } from "react";
import type { AdvisorVerdictItem } from "@achoo254/chat-proto/remote/remote";
import { pictureOf } from "../../advisor/looks.ts";
import type { AdvisorCopy } from "../../advisor/copy-vi.ts";
import { useAdvisorCopy } from "../../advisor/use-advisor-copy.ts";
import { useAdvisorIdentity } from "../../advisor/use-advisor-identity.ts";
import { isCommand, rankedOptions } from "../../advisor/use-advisor-presence.ts";
import { PercentBar } from "../percent-bar.tsx";
import { errorText } from "../use-machines.ts";
import { useMachinesCopy } from "../use-machines-copy.ts";

interface AdvisorVerdictCardProps {
	readonly verdict: AdvisorVerdictItem;
	/** Sends a chip's option as the user's message; none where nothing can be sent (Advisor's own session). */
	readonly onSend?: ((text: string) => Promise<void>) | undefined;
	/** The user sent a message after this card (or one is on its way): its chips are spent. */
	readonly past: boolean;
	/** A turn runs: chips wait for it to end. */
	readonly running: boolean;
	/** The session cannot take a message now (machine offline, session held by its terminal). */
	readonly unavailable: boolean;
	/** The session's AI, for wording a failed send. */
	readonly ai: string;
}

const percent = (p: number): number => Math.round(p * 100);

/** Why the chips are dimmed, the strongest reason first; "" when they can be sent. */
function lockReason(t: AdvisorCopy, past: boolean, running: boolean, unavailable: boolean): string {
	if (past) return t.card.past;
	if (running) return t.card.locked;
	if (unavailable) return t.card.unavailable;
	return "";
}

export function AdvisorVerdictCard({ verdict, onSend, past, running, unavailable, ai }: AdvisorVerdictCardProps) {
	const t = useAdvisorCopy();
	const tm = useMachinesCopy();
	const { name, look } = useAdvisorIdentity();
	const [sending, setSending] = useState(false);
	/** The option this card sent: a turn's next steps are taken once. */
	const [chosen, setChosen] = useState<string | null>(null);
	const [error, setError] = useState("");
	const failed = verdict.error !== "";
	const top = failed ? undefined : rankedOptions(verdict)[0];
	const chips = !failed && verdict.kind === "next_steps" && onSend !== undefined ? rankedOptions(verdict).filter((o) => !isCommand(o.text)) : [];
	const reason = lockReason(t, past, running, unavailable);
	const disabled = reason !== "" || sending || chosen !== null;

	const send = (text: string) => {
		if (onSend === undefined || disabled || isCommand(text)) return;
		setSending(true);
		setError("");
		onSend(text).then(
			() => {
				setSending(false);
				setChosen(text);
			},
			(err: unknown) => {
				setSending(false);
				setError(errorText(tm, err, ai));
			},
		);
	};

	return (
		<section className="mx-advisor" role="group" aria-label={t.card.title(name)} data-id="advisor-verdict">
			<header className="mx-advisor-head">
				<img src={pictureOf(look, failed ? "idle" : "answering")} alt="" />
				<b className="grow">{t.card.title(name)}</b>
				{t.card.kinds[verdict.kind] !== undefined && <span className="mx-tag">{t.card.kinds[verdict.kind]}</span>}
			</header>
			{verdict.question !== "" && <p className="mx-advisor-sent">{verdict.question}</p>}
			{failed ? (
				<p className="mx-advisor-note mx-error">
					{t.answer.errors[verdict.error] ?? t.answer.otherError}
				</p>
			) : (
				<>
					<p className="mx-advisor-note">
						{verdict.verdict === "confident" ? t.answer.confident : t.answer.unsure} · {t.answer.confidence(percent(verdict.confidence))}
					</p>
					<ul className="mx-advisor-options" aria-label={t.card.options}>
						{verdict.options.map((option, i) => (
							<li key={i} className={option === top ? "top" : undefined}>
								<span className="grow">{option.text}</span>
								<PercentBar pct={percent(option.probability)} />
								<span className="pct">{percent(option.probability)}%</span>
							</li>
						))}
					</ul>
				</>
			)}
			{chips.length > 0 && (
				<div className="mx-advisor-chips" role="group" aria-label={t.card.next}>
					{chips.map((option, i) => (
						<button
							key={i}
							type="button"
							className="btn btn-sm mx-advisor-chip"
							disabled={disabled}
							aria-busy={sending}
							title={reason === "" ? undefined : reason}
							onClick={() => send(option.text)}
						>
							{option.text}
							{chosen === option.text && <span className="muted"> · {t.card.chosen}</span>}
						</button>
					))}
					{reason !== "" && chosen === null && <span className="mx-advisor-hint muted">{reason}</span>}
				</div>
			)}
			{error !== "" && (
				<p className="mx-advisor-note mx-error" role="alert">
					{error}
				</p>
			)}
			{verdict.context !== "" && (
				<details className="mx-advisor-context">
					<summary>{t.answer.context}</summary>
					<p className="mx-advisor-sent">{verdict.context}</p>
				</details>
			)}
		</section>
	);
}

/** Under a COMPLETED turn of an automatic session whose AI never asked Advisor for next steps. */
export function AdvisorMissedLine() {
	const t = useAdvisorCopy();
	const { name } = useAdvisorIdentity();
	return <div className="mx-line mx-advisor-missed">{t.card.missed(name)}</div>;
}
