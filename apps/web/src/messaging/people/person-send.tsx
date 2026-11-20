// The bottom of a person's merged screen (ADR 0025): what became of the last
// sends, chat by chat; the target row "Gửi qua: [Telegram] [Zalo] [Chat]"
// when two chats or more can send (a single one is named in a small label,
// a reply or an edit names the chat it goes to); the one-time question
// before the first send to several apps; and the chat screen's composer,
// whose sends fan out (use-person-send.ts).
import { Suspense, lazy, useState, useSyncExternalStore } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { ServicesContext } from "../data/services.tsx";
import { appLabel, identityLabel } from "../ui/link-suggestions.tsx";
import { DialogHead, Modal, useDomId } from "../ui/parts.tsx";
import type { LinkedPerson } from "./people-api.ts";
import type { SendLine } from "./send-status.ts";
import { blocks, type SendTarget } from "./send-targets.ts";
import type { PersonSend as PersonSendState, SendQuestion } from "./use-person-send.ts";
import "./person-send.css";

// The same chunk the chat screen loads for its composer.
const Composer = lazy(() => import("../ui/composer.tsx").then((m) => ({ default: m.Composer })));

/** Each chat in words: its app, or its identity where the person has two chats on one app. */
function targetLabels(person: LinkedPerson, targets: readonly SendTarget[], copy: FullCopy): ReadonlyMap<number, string> {
	const labels = new Map<number, string>();
	for (const target of targets) {
		const shared = targets.filter((other) => other.app === target.app).length > 1;
		const member = person.members.find((candidate) => candidate.chatId === target.chatId);
		labels.set(target.chatId, shared && member !== undefined ? identityLabel(member, copy) : appLabel(target.app, copy));
	}
	return labels;
}

function TargetRow({ send, labels }: { send: PersonSendState; labels: ReadonlyMap<number, string> }) {
	const copy = useScreensCopy();
	const t = copy.personScreen;
	const label = (chatId: number): string => labels.get(chatId) ?? "";
	const chatId = send.chatId;
	if (send.intent !== null) {
		return (
			<div className="send-targets" role="status">
				<Icon name={send.intent.mode === "edit" ? "edit" : "reply"} small />
				<span>{send.intent.mode === "edit" ? t.editingVia(label(chatId)) : t.replyingVia(label(chatId))}</span>
			</div>
		);
	}
	if (!send.row) {
		const only = send.targets.find((target) => target.chatId === send.sending[0]);
		if (only === undefined) return null;
		return (
			<div className="send-targets">
				<span>{t.sendViaOne(label(only.chatId))}</span>
				{only.reason !== null && <span className="send-target-why">{t.reasons[only.reason]}</span>}
			</div>
		);
	}
	return (
		<div className="send-targets" role="group" aria-label={t.sendVia}>
			<span aria-hidden="true">{t.sendViaLead}</span>
			{send.targets.map((target) => {
				const on = send.selected.includes(target.chatId);
				const last = on && send.selected.length === 1;
				return (
					<button
						key={target.chatId}
						type="button"
						className={target.reason === null ? "send-target" : "send-target dim"}
						aria-pressed={on}
						title={last ? t.keepOne : target.reason === null ? undefined : t.reasons[target.reason]}
						onClick={() => send.toggle(target.chatId)}
					>
						{on && <Icon name="check" small />}
						{label(target.chatId)}
						{target.reason !== null && <span className="send-target-why">{t.reasons[target.reason]}</span>}
					</button>
				);
			})}
		</div>
	);
}

/** One chat's outcome: why nothing was sent there, a failure with its retry, or a message waiting for its account. */
function StatusLine({ line, app, onDismiss }: { line: SendLine; app: string; onDismiss: () => void }) {
	const copy = useScreensCopy();
	const t = copy.personScreen;
	const [busy, setBusy] = useState(false);
	const text = line.kind === "failed" ? t.sendFailed(app) : line.kind === "skipped" ? t.notSent(app, t.reasons[line.reason]) : t.waiting(app, t.reasons[line.reason]);
	return (
		<div className={line.kind === "waiting" ? "send-line warn" : "send-line error"} role={line.kind === "failed" ? "alert" : "status"}>
			<Icon name="alert" small />
			<span className="grow">{text}</span>
			{line.kind === "failed" && (
				<button
					type="button"
					className="btn btn-sm"
					disabled={busy}
					aria-busy={busy}
					onClick={() => {
						setBusy(true);
						line.retry().finally(() => setBusy(false));
					}}
				>
					{copy.common.retry}
				</button>
			)}
			<button type="button" className="icon-btn" aria-label={t.dismissLine(app)} title={copy.common.close} onClick={onDismiss}>
				<Icon name="x" small />
			</button>
		</div>
	);
}

/** "Tin sẽ được gửi riêng tới Telegram, Zalo và Chat", once, with "Không hỏi lại". */
function SendConfirm({ question, labels }: { question: SendQuestion; labels: ReadonlyMap<number, string> }) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const t = copy.personScreen;
	const id = useDomId("send-many");
	const [dontAsk, setDontAsk] = useState(true);
	const apps = new Intl.ListFormat(locale, { type: "conjunction" }).format(question.chatIds.map((chatId) => labels.get(chatId) ?? ""));
	return (
		<Modal labelledBy={id} className="narrow" onClose={() => question.answer(false, false)}>
			<DialogHead id={id} title={t.confirmTitle} onClose={() => question.answer(false, false)} />
			<div className="dlg-body stack">
				<p>{t.confirmBody(apps)}</p>
				<label className="opt check">
					<input type="checkbox" checked={dontAsk} onChange={(event) => setDontAsk(event.target.checked)} />
					<span>{t.dontAskAgain}</span>
				</label>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={() => question.answer(false, false)}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" onClick={() => question.answer(true, dontAsk)}>
					{t.confirmSend}
				</button>
			</div>
		</Modal>
	);
}

export function PersonSend({ person, send }: { person: LinkedPerson; send: PersonSendState }) {
	const copy = useScreensCopy();
	const lines = useSyncExternalStore(send.status.subscribe, send.status.current);
	if (send.chatId === 0) return null;
	const labels = targetLabels(person, send.targets, copy);
	const waiting = <div className="composer-wrap" aria-busy="true" />;
	const blocked = send.targets.every((target) => blocks(target.reason));
	return (
		<div className="person-send">
			{lines.map((line) => (
				<StatusLine key={line.chatId} line={line} app={labels.get(line.chatId) ?? ""} onDismiss={() => send.status.dismiss(line.chatId)} />
			))}
			<TargetRow send={send} labels={labels} />
			<ServicesContext value={send.services}>
				<Suspense fallback={waiting}>
					<Composer
						chatId={send.chatId}
						topicId={0}
						channel={false}
						label={copy.composer.label(person.name)}
						placeholder={blocked ? copy.personScreen.nowhereToSend : copy.composer.placeholder(person.name)}
						media
					/>
				</Suspense>
			</ServicesContext>
			{send.question !== null && <SendConfirm question={send.question} labels={labels} />}
		</div>
	);
}
