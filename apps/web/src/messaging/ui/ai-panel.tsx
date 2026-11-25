// The AI panel of a conversation: the chat's own AI Agent session on one of
// the user's machines (machine B), beside the conversation. On a computer it
// is a column on the right whose width the user drags (kept on this device);
// below 1100px it lays over the conversation; on a phone it is a sheet from
// the bottom, near full height, its header and composer fixed. «Hỏi AI» on a
// message opens it about that message (sender, time, text and seq) with
// quick questions; "/ai …" in the chat's composer sends the question here.
// Each of the AI's replies can go into the chat's composer («Đưa vào ô soạn
// tin»), replying to the message asked about: the user sends it. Nothing
// here posts in the chat; the AI posts only through its own tool, which asks
// the user to approve each message on the machine's side.
import { Suspense, lazy, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import type { Chat } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { AiMark } from "../../machines/ai-mark.tsx";
import { advisorStore } from "../../advisor/advisor-store.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { Link, paths } from "../../router.tsx";
import { useScreensCopy, type FullCopy } from "../copy/use-screens-copy.ts";
import { clock, fullDate } from "../data/format.ts";
import type { Drafts } from "../data/drafts.ts";
import { useDialog, useServices } from "../data/services.tsx";
import { DialogHead, Modal, useDomId } from "./parts.tsx";
import { useUi, type AiPanelRequest, type AiQuote, type Ui } from "./ui-context.tsx";
import { plainText } from "./ai-plain-text.ts";
import { useChatAi, type ChatAi } from "./use-chat-ai.ts";

const AiPanelSession = lazy(() => import("./ai-panel-session.tsx"));

/** The phone layout of the stylesheet (messaging.css): a sheet instead of a column. */
const PHONE_QUERY = "(max-width: 760px)";
const WIDTH_KEY = "chat:ai-width";
export const AI_MIN = 320;
export const AI_MAX = 640;
const AI_DEFAULT = 400;
const STEP = 10;

type Chip = "draft" | "summarize" | "translate" | "explain";
const CHIPS: readonly Chip[] = ["draft", "summarize", "translate", "explain"];

let nextFill = 0;

/**
 * Puts the AI's text in the chat's composer: the draft of that chat and
 * topic becomes the text, replying to `replyToSeq` when not 0; an edit in
 * progress ends (the caller asked first). A composer showing that chat takes
 * it at once.
 */
export function putInComposer(drafts: Drafts, ui: Ui, target: { readonly chatId: number; readonly topicId: number; readonly replyToSeq: number }, text: string): void {
	drafts.set(target.chatId, text, target.topicId);
	const intent = ui.intents.cell(target.chatId);
	if (target.replyToSeq !== 0) intent.set({ mode: "reply", seq: target.replyToSeq });
	else if (intent.get()?.mode === "edit") intent.set(null);
	nextFill += 1;
	ui.composerFill.set({ id: nextFill, chatId: target.chatId, topicId: target.topicId });
}

/** The quoted message and a question about it, as the AI reads them. */
export function aboutQuote(copy: FullCopy, quote: AiQuote, locale: string, question: string): string {
	const quoted = copy.aiPanel.quoted(quote.sender, `${clock(quote.date, locale)} ${fullDate(quote.date, locale)}`, quote.seq, quote.text);
	return question === "" ? quoted : `${quoted}\n\n${question}`;
}

function phoneQuery(): MediaQueryList | null {
	return typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null;
}

function usePhone(): boolean {
	const [phone, setPhone] = useState(() => phoneQuery()?.matches === true);
	useEffect(() => {
		const query = phoneQuery();
		if (query === null) return;
		const update = () => setPhone(query.matches);
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return phone;
}

interface AiPanelProps {
	chat: Chat;
	title: string;
	/** The topic open in the conversation: its composer takes the AI's text. */
	topicId: number;
	/** What opened the panel for this chat; null when it was opened for another chat and stayed open. */
	request: AiPanelRequest | null;
	/** The screen's grid, whose --ai-w sizes the panel's column. */
	app: RefObject<HTMLDivElement | null>;
}

export default function AiPanel({ chat, title, topicId, request, app }: AiPanelProps) {
	const copy = useScreensCopy();
	const ui = useUi();
	const phone = usePhone();
	const id = useDomId("ai-panel");
	const close = () => ui.ai.set(null);
	const body = <PanelBody chat={chat} title={title} topicId={topicId} request={request} phone={phone} titleId={id} onClose={close} />;
	if (phone) {
		return (
			<Modal labelledBy={id} onClose={close} className="ai-sheet">
				{body}
			</Modal>
		);
	}
	return (
		<aside className="ai-panel" aria-labelledby={id}>
			<AiResizer app={app} label={copy.aiPanel.resize} />
			{body}
		</aside>
	);
}

interface PanelBodyProps {
	chat: Chat;
	title: string;
	topicId: number;
	request: AiPanelRequest | null;
	phone: boolean;
	titleId: string;
	onClose: () => void;
}

function PanelBody({ chat, title, topicId, request, phone, titleId, onClose }: PanelBodyProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const ui = useUi();
	const { drafts, toasts, self, remote } = useServices();
	const ai = useChatAi(chat, title, self.id);
	const hidden = useDialog(chat.id)?.dialog.hiddenFromAi === true;
	// The message asked about, and the one the AI's text replies to once put in the composer.
	const [quote, setQuote] = useState<AiQuote | null>(request?.quote ?? null);
	const [replyTo, setReplyTo] = useState(request?.quote?.seq ?? 0);
	// A question from "/ai …" waits here until the machine can take it; it stays in the box if it never can.
	// Keyed by its request: the same question asked twice is two questions.
	const [waiting, setWaiting] = useState<{ readonly id: number; readonly text: string } | null>(request !== null && request.ask !== "" ? { id: request.id, text: request.ask } : null);
	// A question that could not be sent: back in the box, for the user to send again.
	const [unsent, setUnsent] = useState("");
	const [seen, setSeen] = useState(request?.id ?? 0);
	if (request !== null && request.id !== seen) {
		setSeen(request.id);
		if (request.quote !== null) {
			setQuote(request.quote);
			setReplyTo(request.quote.seq);
		}
		if (request.ask !== "") setWaiting({ id: request.id, text: request.ask });
	}
	const [busy, setBusy] = useState(false);
	const [confirm, setConfirm] = useState<string | null>(null);
	const machine = ai.target?.entry.ref ?? "";
	const threadId = ai.thread?.id ?? "";

	/** Sends a question: the session's first opens it, the others go to it. */
	const ask = async (question: string): Promise<boolean> => {
		if (ai.status !== "ready" || ai.target === null || question.trim() === "") return false;
		setBusy(true);
		try {
			if (threadId === "") return (await ai.start(question)) !== null;
			await ai.target.link.send(threadId, question);
			return true;
		} catch {
			toasts.show(copy.aiPanel.failed);
			return false;
		} finally {
			setBusy(false);
		}
	};

	// A quote that comes while the session is open waits in its composer, for a question of the user's own:
	// once per quote and session (the session's composer takes it through Advisor's fill, as "Gửi sang phiên").
	// What was put there, so a quick question sent about the quote takes it back out (it is asked already).
	const prefilled = useRef<{ readonly machine: string; readonly threadId: string; readonly text: string } | null>(null);
	const fillQuote = useEffectEvent((into: string, at: string) => {
		if (quote === null) return;
		const text = aboutQuote(copy, quote, locale, "");
		prefilled.current = { machine: into, threadId: at, text };
		advisorStore.fill(into, at, text);
	});
	const takeBackQuote = () => {
		const put = prefilled.current;
		prefilled.current = null;
		if (put !== null) advisorStore.fill(put.machine, put.threadId, put.text, true);
	};
	const quoteSeq = quote?.seq ?? 0;
	useEffect(() => {
		if (quoteSeq !== 0 && threadId !== "" && machine !== "") fillQuote(machine, threadId);
	}, [quoteSeq, threadId, machine]);

	// "/ai …": sent as soon as the machine can take it; back in the box when it fails.
	// The request being sent: an effect run twice (StrictMode) sends it once.
	const asking = useRef<number | null>(null);
	const sendWaiting = useEffectEvent(async (question: { readonly id: number; readonly text: string }) => {
		if (asking.current === question.id) return;
		asking.current = question.id;
		setWaiting((current) => (current?.id === question.id ? null : current));
		const sent = await ask(quote === null ? question.text : aboutQuote(copy, quote, locale, question.text));
		asking.current = null;
		if (sent) setQuote(null);
		else setUnsent(question.text);
	});
	// A chat hidden from AI is not asked about at all: the server would refuse the AI every read of it.
	const canAsk = !hidden && ai.status === "ready" && !ai.outdated && ai.provider !== "";
	const [showing, setShowing] = useState(false);
	const showToAi = () => {
		setShowing(true);
		remote.setDialogHiddenFromAi(chat.id, false).then(
			() => {
				setShowing(false);
				toasts.show(copy.info.hiddenFromAiOff);
			},
			() => {
				setShowing(false);
				toasts.show(copy.common.failed);
			},
		);
	};
	useEffect(() => {
		// The question is an external request (the chat's composer): it is sent once, when the machine can take it.
		// One at a time: a question asked while the first one opens the session goes to that session after it.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (waiting !== null && canAsk && !busy) void sendWaiting(waiting);
	}, [waiting, canAsk, busy]);

	const chip = (kind: Chip) => {
		if (quote === null) return;
		void ask(aboutQuote(copy, quote, locale, copy.aiPanel.prompt[kind])).then((sent) => {
			if (!sent) return;
			setQuote(null);
			takeBackQuote();
		});
	};

	// The chat gets plain text: its people (Telegram, Zalo) would see the markdown's marks as typed.
	const offerText = (markdown: string) => {
		const text = plainText(markdown);
		// An edit in progress is not in the draft: putting the text in would end it, so the user is asked first too.
		const editing = ui.intents.cell(chat.id).get()?.mode === "edit";
		const current = drafts.get(chat.id, topicId);
		if (editing || (current.trim() !== "" && current.trim() !== text.trim())) {
			setConfirm(text);
			return;
		}
		fill(text);
	};
	const fill = (text: string) => {
		putInComposer(drafts, ui, { chatId: chat.id, topicId, replyToSeq: replyTo }, text);
		toasts.show(copy.aiPanel.filled);
		// On a phone the sheet covers the conversation: it gives way to the composer.
		if (phone) onClose();
	};

	return (
		<>
			<header className="ai-head">
				<AiMark name="agent" />
				<h2 id={titleId}>{copy.aiPanel.title}</h2>
				<MachinePicker ai={ai} copy={copy} />
				<button type="button" className="icon-btn" aria-label={copy.aiPanel.close} title={copy.aiPanel.close} onClick={onClose}>
					<Icon name="x" />
				</button>
			</header>
			{hidden && (
				<div className="banner warn ai-note" role="status">
					<p>{copy.aiPanel.hidden}</p>
					<button type="button" className="btn" disabled={showing} onClick={showToAi}>
						{copy.aiPanel.showToAi}
					</button>
				</div>
			)}
			{quote !== null && (
				<QuoteCard quote={quote} locale={locale} copy={copy} disabled={!canAsk || busy} onChip={chip} onRemove={() => setQuote(null)} />
			)}
			<div className="ai-body">
				<Availability ai={ai} copy={copy} />
				{hidden ? null : ai.status === "ready" && !ai.outdated && threadId !== "" ? (
					<Suspense fallback={<div className="ai-loading" aria-busy="true" />}>
						<AiPanelSession key={`${machine}:${threadId}`} machine={machine} threadId={threadId} onUseText={offerText} />
					</Suspense>
				) : (
					<StartComposer
						key={`${waiting?.id ?? 0}\n${unsent}`}
						copy={copy}
						initial={waiting?.text ?? unsent}
						disabled={!canAsk}
						busy={busy}
						onSend={async (question) => {
							const sent = await ask(quote === null ? question : aboutQuote(copy, quote, locale, question));
							if (sent) setQuote(null);
							return sent;
						}}
					/>
				)}
			</div>
			{confirm !== null && (
				<ReplaceDialog
					copy={copy}
					onCancel={() => setConfirm(null)}
					onConfirm={() => {
						fill(confirm);
						setConfirm(null);
					}}
				/>
			)}
		</>
	);
}

/** The machine the panel uses: a list when there are several. */
function MachinePicker({ ai, copy }: { ai: ChatAi; copy: FullCopy }) {
	if (ai.machines.length < 2 || ai.target === null) return null;
	return (
		<select className="input ai-machine" aria-label={copy.aiPanel.machine} title={ai.target.entry.name} value={ai.target.entry.ref} onChange={(event) => ai.pickMachine(event.target.value)}>
			{ai.machines.map((m) => (
				<option key={m.entry.ref} value={m.entry.ref}>
					{m.entry.name}
				</option>
			))}
		</select>
	);
}

/** Why the panel cannot ask yet, with the way to AI Agent; nothing once it can. */
function Availability({ ai, copy }: { ai: ChatAi; copy: FullCopy }) {
	const name = ai.target?.entry.name ?? "";
	let note: { title: string; body?: string } | null = null;
	if (ai.status === "loading") note = { title: copy.aiPanel.loading };
	else if (ai.status === "none") note = { title: copy.aiPanel.noMachine, body: copy.aiPanel.noMachineBody };
	else if (ai.status === "offline") note = { title: copy.aiPanel.offline, body: copy.aiPanel.offlineBody(name) };
	else if (ai.status === "connecting") note = { title: copy.aiPanel.connecting(name) };
	else if (ai.outdated) note = { title: copy.aiPanel.outdated };
	else if (ai.provider === "") note = { title: copy.aiPanel.noAi };
	else if (ai.thread === null) return <p className="ai-intro">{copy.aiPanel.intro}</p>;
	if (note === null) return null;
	const link = ai.status === "none" || ai.status === "offline" || ai.outdated || ai.provider === "";
	return (
		<div className="ai-state" role="status">
			<strong>{note.title}</strong>
			{note.body !== undefined && <span>{note.body}</span>}
			{link && (
				<Link to={paths.machines()} className="btn btn-sm">
					{copy.aiPanel.openAgent}
				</Link>
			)}
		</div>
	);
}

function QuoteCard({ quote, locale, copy, disabled, onChip, onRemove }: { quote: AiQuote; locale: string; copy: FullCopy; disabled: boolean; onChip: (kind: Chip) => void; onRemove: () => void }) {
	return (
		<section className="ai-quote" aria-label={copy.aiPanel.quote}>
			<div className="ai-quote-head">
				<strong>{quote.sender}</strong>
				<span className="muted">
					{clock(quote.date, locale)} · #{quote.seq}
				</span>
				<button type="button" className="icon-btn" aria-label={copy.aiPanel.removeQuote} title={copy.aiPanel.removeQuote} onClick={onRemove}>
					<Icon name="x" small />
				</button>
			</div>
			<blockquote>{quote.text}</blockquote>
			<div className="ai-chips" role="group" aria-label={copy.aiPanel.chips}>
				{CHIPS.map((kind) => (
					<button key={kind} type="button" className="chip" disabled={disabled} onClick={() => onChip(kind)}>
						{copy.aiPanel.chip[kind]}
					</button>
				))}
			</div>
		</section>
	);
}

/** The box before the chat has a session: its first question opens it. */
function StartComposer({ copy, initial, disabled, busy, onSend }: { copy: FullCopy; initial: string; disabled: boolean; busy: boolean; onSend: (question: string) => Promise<boolean> }) {
	const [text, setText] = useState(initial);
	const submit = async (event?: FormEvent) => {
		event?.preventDefault();
		if (disabled || busy || text.trim() === "") return;
		if (await onSend(text.trim())) setText("");
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	};
	return (
		<form className="ai-compose" onSubmit={(event) => void submit(event)}>
			<textarea
				className="input"
				rows={2}
				aria-label={copy.aiPanel.placeholder}
				placeholder={copy.aiPanel.placeholder}
				value={text}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={onKeyDown}
			/>
			<button type="submit" className="send" aria-label={busy ? copy.aiPanel.sending : copy.aiPanel.send} title={copy.aiPanel.send} disabled={disabled || busy || text.trim() === ""} aria-busy={busy}>
				<Icon name="send" />
			</button>
		</form>
	);
}

function ReplaceDialog({ copy, onCancel, onConfirm }: { copy: FullCopy; onCancel: () => void; onConfirm: () => void }) {
	const id = useDomId("ai-replace");
	return (
		<Modal labelledBy={id} onClose={onCancel} className="narrow">
			<DialogHead id={id} title={copy.aiPanel.replaceTitle} onClose={onCancel} />
			<div className="dlg-body stack">
				<p>{copy.aiPanel.replaceBody}</p>
			</div>
			<div className="dlg-foot">
				<button type="button" className="btn" onClick={onCancel}>
					{copy.common.cancel}
				</button>
				<button type="button" className="btn btn-primary" onClick={onConfirm}>
					{copy.aiPanel.replace}
				</button>
			</div>
		</Modal>
	);
}

function storedWidth(): number | null {
	try {
		const value = Number(window.localStorage.getItem(WIDTH_KEY));
		return Number.isFinite(value) && value > 0 ? clampWidth(value) : null;
	} catch {
		return null;
	}
}

function storeWidth(width: number): void {
	try {
		window.localStorage.setItem(WIDTH_KEY, String(width));
	} catch {
		// Storage off: the width lasts until the tab closes.
	}
}

export function clampWidth(width: number): number {
	return Math.round(Math.min(AI_MAX, Math.max(AI_MIN, width)));
}

/**
 * The handle on the panel's left edge (the chat list's handle, mirrored):
 * drag it, or focus it and press ←/→ (Home/End for the limits). The width
 * sets --ai-w on the screen's grid and is kept on this device.
 */
function AiResizer({ app, label }: { app: RefObject<HTMLDivElement | null>; label: string }): ReactNode {
	const [width, setWidth] = useState(() => storedWidth() ?? AI_DEFAULT);
	const [drag, setDrag] = useState<{ right: number; pointer: number } | null>(null);
	useLayoutEffect(() => {
		const element = app.current;
		if (element === null) return;
		element.style.setProperty("--ai-w", `${width}px`);
		// The page's floating parts (Advisor's mascot, advisor.css) keep clear of the panel by its width.
		const root = document.documentElement;
		root.style.setProperty("--ai-panel-w", `${width}px`);
		return () => {
			element.style.removeProperty("--ai-w");
			root.style.removeProperty("--ai-panel-w");
		};
	}, [app, width]);
	const apply = (next: number) => {
		const clamped = clampWidth(next);
		setWidth(clamped);
		storeWidth(clamped);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		// The panel is on the right: ← widens it, → narrows it.
		let next: number | null = null;
		if (event.key === "ArrowLeft") next = width + STEP;
		else if (event.key === "ArrowRight") next = width - STEP;
		else if (event.key === "Home") next = AI_MIN;
		else if (event.key === "End") next = AI_MAX;
		if (next === null) return;
		event.preventDefault();
		apply(next);
	};
	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const panel = event.currentTarget.parentElement;
		if (panel === null) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrag({ right: panel.getBoundingClientRect().right, pointer: event.pointerId });
	};
	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		if (drag === null || drag.pointer !== event.pointerId) return;
		setWidth(clampWidth(drag.right - event.clientX));
	};
	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		if (drag?.pointer !== event.pointerId) return;
		setDrag(null);
		storeWidth(width);
	};
	return (
		// A focusable separator with a value is a widget in ARIA 1.2 (window splitter); the plugin treats separator as structure only.
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
		<div
			className="ai-resize"
			role="separator"
			aria-orientation="vertical"
			aria-label={label}
			aria-valuemin={AI_MIN}
			aria-valuemax={AI_MAX}
			aria-valuenow={width}
			// eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the window splitter is operated with the keyboard, so it is in the tab order
			tabIndex={0}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		/>
	);
}
