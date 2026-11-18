// Advisor's bubble, loaded with the link code the first time it opens: the
// question box (with what was just copied already attached, the machine
// and the AI when there is a choice), then the answer of the question this
// tab asked: Advisor's pick with its probability, "Xem tất cả" (every option
// and exactly what was sent to be weighed), "Gửi sang phiên" (fills a session's
// composer; the user sends it), "Hỏi tiếp", the Advisor session, and Stop
// while it thinks. Its menu leads to the settings, where automatic Advisor is
// switched for every session. On a phone it is a bottom sheet (docs modal-popup-design.md).
// Nothing copied inside it is kept for Advisor.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import type { AdvisorTone } from "@achoo254/chat-core";
import { ThreadKind } from "@achoo254/chat-proto/remote/remote";
import { Icon } from "../components/screen-icons.tsx";
import { navigate, paths } from "../router.tsx";
import { errorText, folderName, providerOf, useNow } from "../machines/use-machines.ts";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import { PercentBar } from "../machines/percent-bar.tsx";
import { IGNORE_ATTR } from "./advisor-context.tsx";
import { advisorStore, offerOf, useAdvisorState, type AdvisorStore, type CopyContext, type CopyRecord, type Question } from "./advisor-store.ts";
import { pictureOf, type Look } from "./looks.ts";
import { useI18n, type Locale } from "../i18n/i18n.tsx";
import { surfaceLabel } from "./advisor-surfaces.ts";
import { useAdvisorCopy } from "./use-advisor-copy.ts";
import { isCommand, rankedOptions, useAdvisorPresence, type Answer, type Presence } from "./use-advisor-presence.ts";
import { hasFinePointer } from "../components/fine-pointer.ts";
import { usePopover } from "../machines/use-popover.ts";
import { bubblePlacement, MASCOT_SIZE, menuPlacement, placementStyle, VIEW_MARGIN, type Box, type Viewport } from "./advisor-drag.ts";

/** Where the bubble is a bottom sheet (advisor.css) instead of a panel beside the mascot. */
const SHEET_QUERY = "(max-width: 760px)";
/** The menu's width on a wide screen. */
const MENU_WIDTH = 280;

function subscribeLayout(listener: () => void): () => void {
	window.addEventListener("resize", listener);
	window.visualViewport?.addEventListener("resize", listener);
	return () => {
		window.removeEventListener("resize", listener);
		window.visualViewport?.removeEventListener("resize", listener);
	};
}

/**
 * The viewport and the box `read` measures, as a string that changes only
 * when one of them does (re-read on every render and on resize), then parsed.
 */
function useLayout(read: () => Box | null): { readonly view: Viewport; readonly box: Box | null; readonly sheet: boolean } {
	const snapshot = useCallback(() => {
		const b = read();
		// Without matchMedia (an old WebView) the panel is placed beside the mascot.
		const sheet = typeof window.matchMedia === "function" && window.matchMedia(SHEET_QUERY).matches;
		return [window.innerWidth, window.innerHeight, sheet ? 1 : 0, ...(b === null ? [] : [b.left, b.top, b.width, b.height])].map((n) => Math.round(n)).join(",");
	}, [read]);
	const key = useSyncExternalStore(subscribeLayout, snapshot);
	const [width = 0, height = 0, sheet = 0, left, top, w, h] = key.split(",").map(Number);
	const box = left === undefined || top === undefined || w === undefined || h === undefined ? null : { left, top, width: w, height: h };
	return { view: { width, height }, box, sheet: sheet === 1 };
}

/** The mascot's box without its hover shift (offset*, which transforms leave alone); null when it is hidden. */
function mascotBox(): Box | null {
	const el = document.querySelector<HTMLElement>("[data-id=advisor-mascot]");
	return el === null ? null : { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight };
}

export interface AdvisorLiveProps {
	readonly name: string;
	readonly look: Look;
	readonly tone: AdvisorTone;
	readonly store?: AdvisorStore;
}

/** Where a copy was made, for its chip: "Quản lý mã nguồn · chat-next · main"; a chat message says only that. */
export function whereOf(locale: Locale, context: CopyContext): string {
	const place = surfaceLabel(context.panel, context.screen, locale) || surfaceLabel("", "other", locale);
	if (context.screen === "chat") return place;
	return [place, context.dir === "" ? "" : folderName(context.dir), context.branch].filter((part) => part !== "").join(" · ");
}

/** The live part of the mascot: always running once loaded (mood, answers), the bubble while open. */
export default function AdvisorLive({ name, look, tone, store = advisorStore }: AdvisorLiveProps) {
	const state = useAdvisorState(store);
	const [attached, setAttached] = useState<readonly CopyRecord[]>([]);
	// The newest copy is offered for 10 minutes; the clock ticks with useNow (a newer copy is always "now").
	const now = useNow();
	const offer = offerOf(state, Math.max(now, state.copies[0]?.at ?? 0));
	// The machine of the copy attached; a copy only offered names none yet.
	const presence = useAdvisorPresence(attached[0]?.context.machine ?? "", state.open, store);
	if (!state.open) return null;
	return <Bubble name={name} look={look} tone={tone} store={store} presence={presence} attached={attached} setAttached={setAttached} offer={offer} />;
}

interface BubbleProps {
	readonly name: string;
	readonly look: Look;
	readonly tone: AdvisorTone;
	readonly store: AdvisorStore;
	readonly presence: Presence;
	readonly attached: readonly CopyRecord[];
	readonly setAttached: (copies: readonly CopyRecord[]) => void;
	readonly offer: CopyRecord | null;
}

function Bubble({ name, look, tone, store, presence, attached, setAttached, offer }: BubbleProps) {
	const t = useAdvisorCopy();
	const state = useAdvisorState(store);
	const ref = useRef<HTMLElement>(null);
	const [composing, setComposing] = useState(false);
	/** What "Hỏi lại" puts back in the box. */
	const [draft, setDraft] = useState("");
	const current = composing ? undefined : state.questions[0];
	const close = () => closeBubble(store);
	useEffect(() => {
		// Esc closes the bubble only from inside it: a dialog or menu elsewhere takes its own.
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape" && ref.current?.contains(document.activeElement) === true) closeBubble(store);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [store]);
	const elsewhere = state.dot && current === undefined;
	// Beside the mascot, toward the room there is (a hidden mascot: its corner); a bottom sheet on a phone (CSS).
	const layout = useLayout(mascotBox);
	const anchor = layout.box ?? { left: layout.view.width - MASCOT_SIZE, top: layout.view.height - MASCOT_SIZE - VIEW_MARGIN, width: MASCOT_SIZE, height: MASCOT_SIZE };
	const style = layout.sheet ? undefined : placementStyle(bubblePlacement(anchor, layout.view, state.dock.side));
	return (
		<section ref={ref} className="adv-bubble" role="dialog" aria-label={name} data-side={state.dock.side} style={style} {...{ [IGNORE_ATTR]: "" }}>
			<header className="adv-head">
				<img src={pictureOf(look, state.mood)} alt="" className="adv-head-pic" />
				<b className="grow">{name}</b>
				<Menu store={store} />
				<button type="button" className="icon-btn" aria-label={t.mascot.close} onClick={close}>
					<Icon name="x" small />
				</button>
			</header>
			{current === undefined ? (
				<AskForm
					key={draft}
					initial={draft}
					presence={presence}
					tone={tone}
					store={store}
					attached={attached}
					setAttached={setAttached}
					offer={offer}
					elsewhere={elsewhere}
					onAsked={() => setComposing(false)}
				/>
			) : (
				<AnswerView
					question={current}
					answer={presence.answers.get(current.id)}
					presence={presence}
					store={store}
					lost={presence.lost.has(current.id)}
					onAgain={(text) => {
						setDraft(text);
						setComposing(true);
						setAttached([]);
					}}
				/>
			)}
		</section>
	);
}

/** Why Advisor cannot answer on the machine, with the way to settings when a key is missing. */
function NoteLine({ presence, store }: { presence: Presence; store: AdvisorStore }) {
	const t = useAdvisorCopy();
	const note = presence.note;
	if (note === null) return <p className="adv-note muted" role="status">{t.ask.connecting}</p>;
	if (note === "") return null;
	return (
		<p className="adv-note" role="status">
			{t.notes[note]}
			{note === "no-key" && (
				<>
					{" "}
					<button type="button" className="adv-text-link" onClick={() => openSettings(store)}>
						{t.ask.settings}
					</button>
				</>
			)}
		</p>
	);
}

function openSettings(store: AdvisorStore): void {
	store.setOpen(false);
	navigate(paths.settings("advisor"));
}

/** Closes the bubble, the keyboard back on the mascot. */
function closeBubble(store: AdvisorStore): void {
	store.setOpen(false);
	document.querySelector<HTMLElement>("[data-id=advisor-mascot]")?.focus();
}

interface AskFormProps {
	readonly presence: Presence;
	readonly tone: AdvisorTone;
	readonly store: AdvisorStore;
	readonly attached: readonly CopyRecord[];
	readonly setAttached: (copies: readonly CopyRecord[]) => void;
	readonly offer: CopyRecord | null;
	/** Another device's question was answered meanwhile. */
	readonly elsewhere: boolean;
	/** Text the box opens with ("Hỏi lại"). */
	readonly initial: string;
	readonly onAsked: () => void;
}

function AskForm({ presence, tone, store, attached, setAttached, offer, elsewhere, initial, onAsked }: AskFormProps) {
	const t = useAdvisorCopy();
	const { locale } = useI18n();
	const tm = useMachinesCopy();
	const { copies } = useAdvisorState(store);
	const [text, setText] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [consent, setConsent] = useState<string | null>(null);
	const [showRecent, setShowRecent] = useState(false);
	const now = useNow();
	const field = useRef<HTMLTextAreaElement>(null);
	// A phone's keyboard would cover the sheet: the box takes the focus only with a mouse or trackpad.
	useEffect(() => {
		if (hasFinePointer()) field.current?.focus();
	}, []);
	const offered = offer !== null && !attached.some((c) => c.id === offer.id) ? offer : null;
	// A copy just made goes in with the question: the user types the question and sends (no chip to press first).
	// It is attached once (markUsed): removing it with ✕ leaves it in the recent copies, it does not come back.
	useEffect(() => {
		if (offered === null) return;
		setAttached([offered, ...attached].slice(0, 5));
		store.markUsed([offered.id]);
	}, [offered, attached, setAttached, store]);
	const canAsk = presence.note === "" && presence.ai !== "" && text.trim() !== "" && !busy;
	const submit = async (sensitive: boolean) => {
		if (presence.note !== "" || text.trim() === "") return;
		setBusy(true);
		setError("");
		const result = await presence.ask({ text: text.trim(), attached, tone, sensitive });
		setBusy(false);
		if (result.kind === "consent") return setConsent(result.dir);
		if (result.kind === "error") return setError(errorText(tm, result.error, providerOf(presence.state?.info ?? null, presence.ai)?.name ?? "AI") || t.ask.failed);
		setConsent(null);
		setText("");
		setAttached([]);
		onAsked();
	};
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		void submit(false);
	};
	/** The recent copies still to pick: the ones already attached are above. */
	const choices = copies.filter((copy) => !attached.some((c) => c.id === copy.id));
	const attach = (copy: CopyRecord) => {
		if (attached.some((c) => c.id === copy.id)) return;
		setAttached([copy, ...attached].slice(0, 5));
	};
	return (
		<form className="adv-form" onSubmit={onSubmit}>
			<div className="adv-body">
				{elsewhere && <p className="adv-note muted">{t.answer.elsewhere}</p>}
				<NoteLine presence={presence} store={store} />
				{attached.length > 0 && <p className="adv-attach-title">{t.ask.attachedTitle}</p>}
				{attached.map((copy) => (
					<div key={copy.id} className="adv-attached">
						<span className="grow">
							<small className="muted">{whereOf(locale, copy.context)}</small>
							<span className="adv-clip mono">{copy.text}</span>
						</span>
						<button type="button" className="icon-btn" aria-label={t.ask.remove} onClick={() => setAttached(attached.filter((c) => c.id !== copy.id))}>
							<Icon name="x" small />
						</button>
					</div>
				))}
				{attached.length > 0 && <p className="adv-note muted">{t.ask.attachedHint}</p>}
				{choices.length > 0 && (
					<details className="adv-recent" open={showRecent} onToggle={(event) => setShowRecent(event.currentTarget.open)}>
						<summary>{t.ask.recent(choices.length)}</summary>
						<p className="adv-note muted">{t.ask.recentHint}</p>
						<ul>
							{choices.map((copy) => (
								<li key={copy.id}>
									<button type="button" className="adv-recent-item" onClick={() => attach(copy)}>
										<small className="muted">
											{whereOf(locale, copy.context)} · {t.ask.ago(Math.max(0, Math.floor((now - copy.at) / 60_000)))}
										</small>
										<span className="adv-clip mono">{copy.text}</span>
									</button>
								</li>
							))}
						</ul>
					</details>
				)}
				{consent !== null && (
					<div className="adv-consent" role="alert">
						<p>{t.ask.consent(consent)}</p>
						<div className="adv-acts">
							<button type="button" className="btn btn-sm" onClick={() => setConsent(null)}>
								{t.ask.cancel}
							</button>
							<button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void submit(true)}>
								{t.ask.allow}
							</button>
						</div>
					</div>
				)}
				{error !== "" && (
					<p className="adv-note mx-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="adv-foot">
				{(presence.machines.length > 1 || presence.ais.length > 1) && (
					<div className="adv-pickers">
						{presence.machines.length > 1 && (
							<select className="input" aria-label={t.ask.machine} value={presence.target} onChange={(event) => presence.pickMachine(event.target.value)}>
								{presence.machines.map((m) => (
									<option key={m.ref} value={m.ref}>
										{m.name}
									</option>
								))}
							</select>
						)}
						{presence.ais.length > 1 && (
							<select className="input" aria-label={t.ask.ai} value={presence.ai} onChange={(event) => presence.pickAi(event.target.value)}>
								{presence.ais.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name || p.id}
									</option>
								))}
							</select>
						)}
					</div>
				)}
				<div className="adv-send">
					<textarea
						ref={field}
						className="input"
						rows={2}
						maxLength={2000}
						placeholder={attached.length > 0 ? t.ask.placeholderAttached : t.ask.placeholder}
						aria-label={t.ask.placeholder}
						value={text}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void submit(false);
							}
						}}
					/>
					<button type="submit" className="btn btn-primary" disabled={!canAsk} data-id="advisor-ask">
						{t.ask.send}
					</button>
				</div>
			</div>
		</form>
	);
}

/** Copies one option so the user can paste it into any session themselves. */
function CopyOption({ text }: { readonly text: string }) {
	const t = useAdvisorCopy();
	const [done, setDone] = useState(false);
	return (
		<button
			type="button"
			className="btn btn-sm"
			data-advisor-ignore
			onClick={() => {
				navigator.clipboard.writeText(text).then(
					() => {
						setDone(true);
						window.setTimeout(() => setDone(false), 1500);
					},
					() => undefined,
				);
			}}
		>
			{done ? t.answer.copied : t.answer.copy}
		</button>
	);
}

interface AnswerViewProps {
	readonly question: Question;
	readonly answer: Answer | undefined;
	readonly presence: Presence;
	readonly store: AdvisorStore;
	/** The machine will never answer it (presence.lost). */
	readonly lost: boolean;
	readonly onAgain: (text: string) => void;
}

function AnswerView({ question, answer, presence, store, lost, onAgain }: AnswerViewProps) {
	const t = useAdvisorCopy();
	const { locale } = useI18n();
	const tm = useMachinesCopy();
	const [all, setAll] = useState(false);
	const [picking, setPicking] = useState(false);
	const [error, setError] = useState("");
	const state = answer?.state ?? "waiting";
	const verdict = answer?.verdict ?? null;
	const ranked = verdict === null || verdict.error !== "" ? [] : rankedOptions(verdict);
	const top = ranked[0];
	const asked = question.text !== "" ? question.text : (answer?.question ?? "");
	const running = !lost && question.error === "" && (state === "waiting" || state === "thinking");
	const toSession = (threadId: string) => {
		if (top === undefined) return;
		store.fill(question.machine, threadId, top.text);
		store.setOpen(false);
		navigate(paths.machineSession(question.machine, threadId));
	};
	// The session the user has open right now (on the machine that answered, not Advisor's own thread) gets it at once; the list is for when none is.
	const open = useAdvisorState(store).session;
	const active =
		open !== null && open.machine === question.machine
			? (presence.stateOf(question.machine)?.threads.find((x) => x.id === open.threadId && !x.archived && x.kind !== ThreadKind.ADVISOR)?.id ?? "")
			: "";
	const sessions = picking ? presence.sessionsFor(question) : [];
	return (
		<>
			<div className="adv-body" aria-live="polite">
				<p className="adv-asked">
					<small className="muted">{t.answer.yours}</small>
					<span>{asked}</span>
				</p>
				{question.attached.map((copy) => (
					<p key={copy.id} className="adv-attached-line muted">
						<Icon name="clip" small /> {whereOf(locale, copy.context)}
					</p>
				))}
				{question.error !== "" && <p className="adv-note mx-error">{t.ask.failed}</p>}
				{lost && question.error === "" && <p className="adv-note mx-error">{t.answer.lost}</p>}
				{running && (
					<p className="adv-note muted" role="status">
						{state === "waiting" ? t.answer.waiting : t.answer.thinking}
					</p>
				)}
				{state === "stopped" && <p className="adv-note muted">{t.answer.stopped}</p>}
				{state === "failed" && <p className="adv-note mx-error">{answer?.error || t.answer.failed}</p>}
				{answer !== undefined && answer.text !== "" && <p className="adv-reply">{answer.text}</p>}
				{verdict !== null && verdict.error !== "" && <p className="adv-note mx-error">{t.answer.errors[verdict.error] ?? t.answer.otherError}</p>}
				{top !== undefined && verdict !== null && (
					<div className="adv-best">
						<small className="muted">
							{t.answer.top} · {verdict.verdict === "confident" ? t.answer.confident : t.answer.unsure} · {t.answer.confidence(Math.round(verdict.confidence * 100))}
						</small>
						<div className="adv-option">
							<span className="grow">{top.text}</span>
							<CopyOption text={top.text} />
							<PercentBar pct={Math.round(top.probability * 100)} />
							<b>{Math.round(top.probability * 100)}%</b>
						</div>
					</div>
				)}
				{all && verdict !== null && (
					<div className="adv-all">
						{ranked.slice(1).map((option) => (
							<div key={option.text} className="adv-option">
								<span className="grow">{option.text}</span>
								<CopyOption text={option.text} />
								<PercentBar pct={Math.round(option.probability * 100)} />
								<span>{Math.round(option.probability * 100)}%</span>
							</div>
						))}
						<p>
							<small className="muted">{t.answer.question}</small>
							<span className="adv-sent">{verdict.question}</span>
						</p>
						{verdict.context !== "" && (
							<p>
								<small className="muted">{t.answer.context}</small>
								<span className="adv-sent">{verdict.context}</span>
							</p>
						)}
					</div>
				)}
				{picking && (
					<div className="adv-sessions">
						{sessions.length === 0 ? (
							<p className="muted">{t.answer.noSession}</p>
						) : (
							<>
								<small className="muted">{t.answer.pickSession}</small>
								{sessions.map((thread) => (
									<button key={thread.id} type="button" className="adv-recent-item" onClick={() => toSession(thread.id)}>
										<span>{thread.title || folderName(thread.dir)}</span>
										<small className="muted">{folderName(thread.dir)}</small>
									</button>
								))}
							</>
						)}
					</div>
				)}
				{error !== "" && (
					<p className="adv-note mx-error" role="alert">
						{error}
					</p>
				)}
			</div>
			<div className="adv-foot adv-acts">
				{running && (
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => {
							setError("");
							presence.stop(question).catch((err: unknown) => setError(errorText(tm, err, "AI")));
						}}
					>
						{t.answer.stop}
					</button>
				)}
				{!running && verdict !== null && ranked.length > 0 && (
					<button type="button" className="btn btn-sm" aria-expanded={all} onClick={() => setAll(!all)}>
						{all ? t.answer.less : t.answer.all}
					</button>
				)}
				{!running && top !== undefined && !isCommand(top.text) && (
					<button type="button" className="btn btn-sm" aria-expanded={active === "" && picking} onClick={() => (active !== "" ? toSession(active) : setPicking(!picking))}>
						{t.answer.toSession}
					</button>
				)}
				{!running && !lost && (
					<button
						type="button"
						className="btn btn-sm"
						onClick={() => {
							store.setOpen(false);
							navigate(paths.machineSession(question.machine, question.threadId));
						}}
					>
						{t.answer.view}
					</button>
				)}
				{!running && (
					<button type="button" className="btn btn-sm btn-primary" onClick={() => onAgain(lost ? asked : "")}>
						{lost ? t.answer.askAgain : t.answer.again}
					</button>
				)}
				{/* Always a way out, even while it waits: the question is done on this device. */}
				<button
					type="button"
					className="btn btn-sm"
					onClick={() => {
						store.dropQuestion(question.id);
						store.setOpen(false);
					}}
				>
					{t.answer.close}
				</button>
			</div>
		</>
	);
}

/** The mascot's menu: Advisor's settings (where automatic Advisor is switched for every session) and hiding the mascot. */
function Menu({ store }: { store: AdvisorStore }) {
	const t = useAdvisorCopy();
	// Closes on a click outside it (or Esc, below).
	const { open, setOpen, ref } = usePopover();
	const button = useRef<HTMLButtonElement>(null);
	const readButton = useCallback((): Box | null => {
		const r = button.current?.getBoundingClientRect();
		return r === undefined ? null : { left: r.left, top: r.top, width: r.width, height: r.height };
	}, []);
	const layout = useLayout(readButton);
	const place = layout.box === null ? undefined : placementStyle(menuPlacement(layout.box, layout.view, MENU_WIDTH));
	// Esc closes the menu only, not the bubble around it: taken on the way down, before the bubble hears it.
	useEffect(() => {
		if (!open) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.stopPropagation();
			setOpen(false);
			button.current?.focus();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open, setOpen]);
	return (
		<div className="adv-menu-anchor" ref={ref}>
			<button ref={button} type="button" className="icon-btn" aria-label={t.menu.label} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>
				<Icon name="dots" small />
			</button>
			{open && (
				<div className="adv-menu" role="group" aria-label={t.menu.label} style={place}>
					<button type="button" className="adv-menu-item" onClick={() => openSettings(store)}>
						{t.ask.settings}
					</button>
					<button type="button" className="adv-menu-item" onClick={() => store.setHidden(true)}>
						{t.menu.hide}
					</button>
				</div>
			)}
		</div>
	);
}
