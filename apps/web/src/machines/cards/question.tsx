// The AI asks the user: each question with its options (one, or several when
// multi-select) or a free answer ("Other…"), sent together as one answer.
import { useState } from "react";
import { PromptState, type QuestionItem } from "@achoo254/chat-proto/remote/remote";
import { useDomId } from "../../messaging/ui/parts.tsx";
import { MachineIcon } from "../machine-icons.tsx";
import { useMachinesCopy } from "../use-machines-copy.ts";

const OTHER = "\u0000other";

interface QuestionCardProps {
	question: QuestionItem;
	ai: string;
	onAnswer: (answers: string[][]) => Promise<void>;
	compact?: boolean;
}

export function QuestionCard({ question, ai, onAnswer, compact = false }: QuestionCardProps) {
	const t = useMachinesCopy();
	const id = useDomId("q");
	const [picked, setPicked] = useState<string[][]>(() => question.questions.map(() => []));
	const [other, setOther] = useState<string[]>(() => question.questions.map(() => ""));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	if (question.state !== PromptState.PENDING) {
		const given = question.answers?.answers.map((a) => a.values.join(", ")).join(" · ") ?? "";
		return (
			<div className="mx-done-line">
				<MachineIcon name="help" small />
				<span>{question.questions[0]?.question ?? ""}</span>
				<span className="muted">· {question.state === PromptState.ANSWERED ? (given === "" ? t.question.answered : given) : t.approval.cancelled}</span>
			</div>
		);
	}
	const values = (i: number): string[] =>
		(picked[i] ?? []).flatMap((v) => (v === OTHER ? ((other[i] ?? "").trim() === "" ? [] : [(other[i] ?? "").trim()]) : [v]));
	const complete = question.questions.every((_, i) => values(i).length > 0);
	const toggle = (i: number, value: string, multi: boolean) => {
		setPicked((all) =>
			all.map((list, j) => {
				if (j !== i) return list;
				if (!multi) return [value];
				return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
			}),
		);
	};
	const submit = (answers: string[][]) => {
		setBusy(true);
		setError("");
		onAnswer(answers).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(err instanceof Error ? err.message : String(err));
			},
		);
	};
	// The board answers a single one-choice question with one tap.
	const quick = compact && question.questions.length === 1 && question.questions[0]?.multiSelect === false;
	return (
		<div className="mx-action question" role="group" aria-label={t.question.label(ai)}>
			{question.questions.map((q, i) => (
				<fieldset key={i} className="mx-q">
					<legend>
						<MachineIcon name="help" />
						<span>{q.question}</span>
					</legend>
					{quick ? (
						<div className="acts">
							{q.options.map((o) => (
								<button key={o.label} type="button" className="btn btn-sm" disabled={busy} onClick={() => submit([[o.label]])}>
									{o.label}
								</button>
							))}
						</div>
					) : (
						<>
							{q.options.map((o) => (
								<label key={o.label} className="mx-opt">
									<input
										type={q.multiSelect ? "checkbox" : "radio"}
										name={`${id}-${i}`}
										checked={(picked[i] ?? []).includes(o.label)}
										onChange={() => toggle(i, o.label, q.multiSelect)}
									/>
									<span>
										{o.label}
										{o.description !== "" && <small>{o.description}</small>}
									</span>
								</label>
							))}
							<label className="mx-opt">
								<input
									type={q.multiSelect ? "checkbox" : "radio"}
									name={`${id}-${i}`}
									checked={(picked[i] ?? []).includes(OTHER)}
									onChange={() => toggle(i, OTHER, q.multiSelect)}
								/>
								<span>{t.question.other}</span>
							</label>
							{(picked[i] ?? []).includes(OTHER) && (
								<input
									className="input"
									aria-label={t.question.otherPlaceholder}
									placeholder={t.question.otherPlaceholder}
									value={other[i] ?? ""}
									onChange={(event) => {
										const text = event.target.value;
										setOther((all) => all.map((v, j) => (j === i ? text : v)));
									}}
								/>
							)}
						</>
					)}
				</fieldset>
			))}
			{!quick && (
				<div className="acts">
					<button
						type="button"
						className="btn btn-primary btn-sm"
						disabled={busy || !complete}
						onClick={() => submit(question.questions.map((_, i) => values(i)))}
					>
						{t.question.send}
					</button>
				</div>
			)}
			{error !== "" && (
				<p className="mx-error" role="alert">
					{error}
				</p>
			)}
		</div>
	);
}
