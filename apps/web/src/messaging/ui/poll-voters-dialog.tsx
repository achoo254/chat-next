// Who chose each answer of a public poll (PollView's "Xem ai đã chọn"): one section
// per answer with its count, the people newest first, and how many more the poll
// counts than the list names (a synced app may name only some). Loaded when opened.
import { useEffect, useState } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { PollAnswerVoters } from "../data/remote.ts";
import { useMessage, useServices } from "../data/services.tsx";
import { ChatAvatar, DialogHead, Modal, useDomId } from "./parts.tsx";
import "./poll-view.css";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; answers: readonly PollAnswerVoters[] };

export default function PollVotersDialog({ chatId, seq, onClose }: { chatId: number; seq: number; onClose: () => void }) {
	const copy = useScreensCopy();
	const t = copy.pollVoters;
	const { remote, store } = useServices();
	const message = useMessage(chatId, seq);
	const id = useDomId("poll-voters");
	const [state, setState] = useState<State>({ status: "loading" });
	// Read again when the poll's results change while the list is open.
	const shown = message?.poll === undefined ? "" : message.poll.counts.join(",");

	useEffect(() => {
		let active = true;
		remote.pollVoters(chatId, seq).then(
			(answers) => {
				if (active) setState({ status: "ready", answers });
			},
			() => {
				if (active) setState({ status: "error" });
			},
		);
		return () => {
			active = false;
		};
	}, [remote, chatId, seq, shown]);

	const options = message?.poll?.options ?? [];
	return (
		<Modal labelledBy={id} onClose={onClose} className="narrow">
			<DialogHead id={id} title={t.title} onClose={onClose} />
			<div className="dlg-body stack poll-voters" data-id="poll-voters">
				{message?.poll !== undefined && <p className="poll-question">{message.poll.question}</p>}
				{state.status === "loading" && <p className="note">{copy.common.loading}</p>}
				{state.status === "error" && <p className="note">{t.unavailable}</p>}
				{state.status === "ready" &&
					state.answers.map((answer) => (
						<section key={answer.option} aria-label={options[answer.option] ?? ""} data-id={`poll-voters-${answer.option}`}>
							<h3 className="poll-voters-answer">{t.answer(options[answer.option] ?? "", answer.count)}</h3>
							{answer.count === 0 && <p className="note">{t.none}</p>}
							{answer.people.map((person) => (
								<div className="row" key={person.id}>
									<ChatAvatar id={person.id} name={person.name} photoOf={person.id} photoId={person.photoId} size="sm" bot={person.isBot} />
									<span className="grow">{person.id === store.selfId ? copy.common.you : person.name}</span>
								</div>
							))}
							{answer.count > answer.people.length && <p className="note">{t.more(answer.count - answer.people.length)}</p>}
						</section>
					))}
			</div>
		</Modal>
	);
}
