// Settings › Góp ý (mockups/settings.html#feedback): an idea or a bug
// report for the team, filed straight into the moderation queue
// (FeedbackService.SendFeedback). Loaded when the user opens it.
import { Code, ConnectError } from "@connectrpc/connect";
import { useState, type FormEvent } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { FeedbackKind } from "../data/remote.ts";
import { useServices } from "../data/services.tsx";
import { Choice, DialogHead, Modal, useDomId } from "../ui/parts.tsx";

/** The server's limit, in characters. */
export const FEEDBACK_TEXT_MAX = 2000;

export default function FeedbackDialog({ onClose }: { onClose: () => void }) {
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
				toasts.show(t.sent);
				onClose();
			},
			(err: unknown) => {
				setBusy(false);
				toasts.show(ConnectError.from(err).code === Code.ResourceExhausted ? t.tooFast : copy.common.failed);
			},
		);
	};
	return (
		<Modal labelledBy={id} onClose={onClose}>
			<form onSubmit={submit}>
				<DialogHead id={id} title={t.title} onClose={onClose} />
				<div className="dlg-body flow">
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
							rows={5}
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
				</div>
				<div className="dlg-foot">
					<button type="button" className="btn" onClick={onClose}>
						{copy.common.cancel}
					</button>
					<button type="submit" className="btn btn-primary" aria-busy={busy} disabled={empty || busy}>
						{t.send}
					</button>
				</div>
			</form>
		</Modal>
	);
}
