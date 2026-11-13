// Settings › Góp ý: an idea or a bug report for the team, filed straight
// into the moderation queue (FeedbackService.SendFeedback). A settings page
// like any other (docs/settings-menu.md), loaded when the user opens it.
import { Code, ConnectError } from "@connectrpc/connect";
import { useState, type FormEvent } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { FeedbackKind } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { Choice, useDomId } from "../ui/parts.tsx";

/** The server's limit, in characters. */
export const FEEDBACK_TEXT_MAX = 2000;

export default function FeedbackPage() {
	const copy = useScreensCopy();
	const { remote, toasts } = useServices();
	const [kind, setKind] = useState<FeedbackKind>("idea");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const id = useDomId("feedback");
	const t = copy.feedbackDialog;
	const empty = text.trim() === "";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (empty || busy) return;
		setBusy(true);
		remote.sendFeedback(kind, text.trim()).then(
			() => {
				setBusy(false);
				setText("");
				toasts.show(t.sent);
			},
			(err: unknown) => {
				setBusy(false);
				toasts.show(ConnectError.from(err).code === Code.ResourceExhausted ? t.tooFast : copy.common.failed);
			},
		);
	};
	return (
		<div className="set-body">
			<form className="card pad flow" onSubmit={submit} aria-labelledby={`${id}-title`}>
				<h2 className="card-title" id={`${id}-title`}>
					{t.title}
				</h2>
				<Choice
					label={t.kind}
					value={kind}
					options={[
						{ value: "idea", label: t.idea },
						{ value: "bug", label: t.bug },
					]}
					onChange={setKind}
					disabled={busy}
				/>
				<div className="field">
					<label htmlFor={`${id}-text`}>{t.label}</label>
					<textarea
						id={`${id}-text`}
						className="input"
						rows={6}
						maxLength={FEEDBACK_TEXT_MAX}
						placeholder={kind === "bug" ? t.bugPlaceholder : t.ideaPlaceholder}
						value={text}
						disabled={busy}
						aria-describedby={`${id}-hint ${id}-count`}
						onChange={(event) => setText(event.target.value)}
					/>
					<span className="hint" id={`${id}-hint`}>
						{t.hint}
					</span>
					<span className="hint counter" id={`${id}-count`}>
						{t.count(text.length, FEEDBACK_TEXT_MAX)}
					</span>
				</div>
				<div className="row-end">
					<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={empty || busy}>
						{t.send}
					</button>
				</div>
			</form>
		</div>
	);
}
