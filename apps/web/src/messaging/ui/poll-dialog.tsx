// "Tạo bình chọn" (the composer's attach menu): a question, 2 to 10 answers, and the
// kind of poll — anonymous or not, several answers, or a quiz with its right answer
// and an optional explanation. Loaded when first opened.
import { useState } from "react";
import { cryptoRandomId } from "@achoo254/chat-platform";
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import type { PollDraft } from "../data/remote.ts";
import { DialogHead, Modal, Switch, useDomId } from "./parts.tsx";
import "./poll-view.css";

/** Limits of the server (chat/polls.go), which are Telegram's. */
export const POLL_QUESTION_MAX = 300;
export const POLL_OPTION_MAX = 100;
export const POLL_OPTIONS_MAX = 10;
export const POLL_EXPLANATION_MAX = 200;

/** The draft the form posts, or why it cannot be posted yet. */
export function pollDraft(
	question: string,
	options: readonly string[],
	flags: { anonymous: boolean; multiple: boolean; quiz: boolean; correct: number; explanation: string },
): PollDraft | "question" | "options" {
	const q = question.trim();
	if (q === "") return "question";
	const answers: string[] = [];
	let correct = -1;
	options.forEach((o, i) => {
		const text = o.trim();
		if (text === "" || answers.includes(text)) return;
		if (i === flags.correct) correct = answers.length;
		answers.push(text);
	});
	if (answers.length < 2) return "options";
	if (flags.quiz && correct < 0) return "options";
	return {
		question: q,
		options: answers,
		multiple: flags.multiple && !flags.quiz,
		publicVoters: !flags.anonymous,
		quiz: flags.quiz,
		correct: flags.quiz ? correct : 0,
		explanation: flags.quiz ? flags.explanation.trim() : "",
	};
}

export default function PollDialog({ chatId, topicId, onClose }: { chatId: number; topicId: number; onClose: () => void }) {
	const copy = useScreensCopy();
	const words = copy.pollForm;
	const { remote, toasts } = useServices();
	const id = useDomId("poll");
	const [question, setQuestion] = useState("");
	const [options, setOptions] = useState<readonly string[]>(["", ""]);
	const [anonymous, setAnonymous] = useState(true);
	const [multiple, setMultiple] = useState(false);
	const [quiz, setQuiz] = useState(false);
	const [correct, setCorrect] = useState(0);
	const [explanation, setExplanation] = useState("");
	const [busy, setBusy] = useState(false);
	const [tried, setTried] = useState(false);
	// One id for this form: sending again after a lost answer finds the poll already posted.
	const [randomId] = useState(cryptoRandomId);
	const draft = pollDraft(question, options, { anonymous, multiple, quiz, correct, explanation });
	const problem = draft === "question" ? words.needQuestion : draft === "options" ? words.needOptions : "";

	const setOption = (i: number, value: string) => setOptions((now) => now.map((o, k) => (k === i ? value : o)));
	const removeOption = (i: number) => {
		setOptions((now) => now.filter((_, k) => k !== i));
		setCorrect((now) => (now === i ? 0 : now > i ? now - 1 : now));
	};
	const send = () => {
		setTried(true);
		if (typeof draft === "string") return;
		setBusy(true);
		remote
			.sendPoll(chatId, topicId, draft, randomId)
			.then(onClose)
			.catch(() => {
				setBusy(false);
				toasts.show(words.failed);
			});
	};

	return (
		<Modal labelledBy={id} onClose={onClose}>
			<DialogHead id={id} title={words.title} onClose={onClose} />
			<div className="dlg-body poll-form" data-id="poll-form">
				<div className="field">
					<label htmlFor={`${id}-q`}>{words.question}</label>
					<input
						id={`${id}-q`}
						className="input"
						data-id="poll-form-question"
						maxLength={POLL_QUESTION_MAX}
						value={question}
						placeholder={words.questionPlaceholder}
						onChange={(event) => setQuestion(event.target.value)}
					/>
				</div>
				<fieldset className="field poll-form-options">
					<legend>{words.options}</legend>
					{quiz && <span className="hint">{words.quizHint}</span>}
					{options.map((value, i) => (
						<div className="poll-form-option" key={i} data-id={`poll-form-option-${i}`}>
							{quiz && (
								<button
									type="button"
									className="poll-dot"
									role="radio"
									aria-checked={correct === i}
									aria-label={words.markCorrect(i + 1)}
									onClick={() => setCorrect(i)}
								>
									{correct === i && <Icon name="check" />}
								</button>
							)}
							<input
								className="input"
								aria-label={words.option(i + 1)}
								maxLength={POLL_OPTION_MAX}
								value={value}
								placeholder={words.option(i + 1)}
								onChange={(event) => setOption(i, event.target.value)}
							/>
							{options.length > 2 && (
								<button type="button" className="icon-btn" aria-label={words.removeOption(i + 1)} onClick={() => removeOption(i)}>
									<Icon name="x" />
								</button>
							)}
						</div>
					))}
					{options.length < POLL_OPTIONS_MAX && (
						<button type="button" className="btn btn-sm" data-id="poll-form-add" onClick={() => setOptions((now) => [...now, ""])}>
							<Icon name="plus" />
							{words.addOption}
						</button>
					)}
				</fieldset>
				<div className="row">
					<span className="grow">
						{words.anonymous}
						<small>{words.anonymousHint}</small>
					</span>
					<Switch checked={anonymous} label={words.anonymous} onChange={setAnonymous} />
				</div>
				<div className="row">
					<span className="grow">{words.multiple}</span>
					<Switch checked={multiple && !quiz} label={words.multiple} disabled={quiz} onChange={setMultiple} />
				</div>
				<div className="row">
					<span className="grow">{words.quiz}</span>
					<Switch checked={quiz} label={words.quiz} onChange={setQuiz} />
				</div>
				{quiz && (
					<div className="field">
						<label htmlFor={`${id}-why`}>{words.explanation}</label>
						<input
							id={`${id}-why`}
							className="input"
							maxLength={POLL_EXPLANATION_MAX}
							value={explanation}
							onChange={(event) => setExplanation(event.target.value)}
						/>
					</div>
				)}
				{tried && problem !== "" && (
					<span className="error-text" role="alert">
						{problem}
					</span>
				)}
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onClose}>
					{words.cancel}
				</button>
				<button type="button" className="btn btn-primary" data-id="poll-form-send" aria-busy={busy} disabled={busy} onClick={send}>
					{words.send}
				</button>
			</div>
		</Modal>
	);
}
