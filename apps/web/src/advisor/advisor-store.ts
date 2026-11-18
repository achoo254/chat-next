// What the Advisor mascot keeps on this device, outside React: the last five
// copies with where they were made (memory only, never stored), the
// questions this tab asked and waits for (sessionStorage: only their ids,
// so a reload goes on showing them), where the mascot sits and whether it
// shows (localStorage, per device), the mascot's mood as the live part
// (advisor-bubble.tsx) works it out, a short line to say beside it, and
// text waiting for a session's composer ("Gửi sang phiên").
// One store per page; the signed-in app clears the copies when it goes.
import { useSyncExternalStore } from "react";
import type { AdvisorTone } from "@achoo254/chat-core";

/** Where a copy was made, as the screen declared it (proto AdvisorContext plus the machine it names). */
export interface CopyContext {
	/** "chat", "session", "scm", "terminal", "machine", "settings", … */
	readonly screen: string;
	/** The machine (its ref in the app's paths); "" outside the machines screens. */
	readonly machine: string;
	readonly dir: string;
	readonly branch: string;
	readonly threadId: string;
	readonly panel: string;
	readonly action: string;
	readonly errorCode: string;
	readonly failureId: string;
	/** What the screen's surface lists beyond these (advisor-surfaces.ts); inner scopes add to the ones around them. */
	readonly fields: Readonly<Record<string, string>>;
}

export const EMPTY_CONTEXT: CopyContext = { screen: "", machine: "", dir: "", branch: "", threadId: "", panel: "", action: "", errorCode: "", failureId: "", fields: {} };

export interface CopyRecord {
	readonly id: string;
	readonly text: string;
	readonly context: CopyContext;
	/** Unix milliseconds. */
	readonly at: number;
}

/** A question this tab asked Advisor. Its text lives in the thread's journal; only the ids are stored. */
export interface Question {
	/** ThreadSend.client_msg_id: the question's id on the machine. */
	readonly id: string;
	readonly machine: string;
	readonly threadId: string;
	readonly dir: string;
	readonly askedAt: number;
	/** What the user typed, while this page lives (the journal holds it too). */
	readonly text: string;
	/** The profile's answer style when asked (the machine words it); unknown after a reload. */
	readonly tone?: AdvisorTone | undefined;
	/** The copies attached, as sent (shown under the question while this page lives). */
	readonly attached: readonly CopyRecord[];
	/** The machine took it (ThreadSend answered); false while it waits for the link. */
	readonly sent: boolean;
	/** Why it could not be sent; "" when it was (or is on its way). */
	readonly error: string;
}

/**
 * An answer Advisor gave on its own (automatic mode) while a session showed:
 * kept for a while, so one that came and went from beside the mascot can still
 * be found and followed back to its session. Memory only, never stored.
 */
export interface HistoryEntry {
	/** The verdict's item id. */
	readonly id: string;
	readonly machine: string;
	readonly threadId: string;
	/** The session's title (or folder) when the answer came; "" when unknown. */
	readonly title: string;
	/** Option and its share ("Option (82%)"), or "!" and the error code, as the flash line has it. */
	readonly text: string;
	/** The page (path and query, mode and tab included) the answer came on. */
	readonly target: string;
	/** Unix milliseconds. */
	readonly at: number;
	/** Why the session cannot be opened any more, found when it was tapped; "" while it can. */
	readonly unavailable: "" | "missing" | "unreachable";
}

export type Mood = "idle" | "connecting" | "thinking" | "answering" | "sleeping";

/** Why the mascot sleeps or cannot ask, for the bubble to say. */
export type Note = "" | "no-machine" | "offline" | "update" | "no-ai" | "mcp-off" | "no-key";

/** Dock: the screen edge the mascot sits on and its height there (0 top … 1 bottom of the free band). */
export interface Dock {
	readonly side: "left" | "right";
	readonly y: number;
}

export const DEFAULT_DOCK: Dock = { side: "right", y: 0.62 };

export interface AdvisorState {
	readonly copies: readonly CopyRecord[];
	/** Copies attached or dismissed: never offered again. */
	readonly used: ReadonlySet<string>;
	readonly questions: readonly Question[];
	readonly open: boolean;
	readonly mood: Mood;
	readonly note: Note;
	/** A short line beside the mascot (an automatic verdict, an answer ready); "" when none. */
	readonly flash: string;
	/** The page (path and query, the session's mode and tab included) the flash line came from; a tap on the line goes back there. "" when none. */
	readonly flashTarget: string;
	/** Answers Advisor gave on its own, newest first. */
	readonly history: readonly HistoryEntry[];
	/** An answer came that this device did not ask for (another device's question). */
	readonly dot: boolean;
	readonly dock: Dock;
	readonly hidden: boolean;
	/** The session shown now (session screen), for the automatic mode switch. */
	readonly session: { readonly machine: string; readonly threadId: string } | null;
	/** The chat open now (its composer is showing), for "Điền vào ô soạn tin"; never leaves the page. */
	readonly chat: { readonly chatId: number; readonly topicId: number } | null;
	/** Text for a composer, by `${machine}\n${threadId}` (a session) or `chat\n${chatId}\n${topicId}` (a chat). */
	readonly fills: ReadonlyMap<string, { readonly text: string; readonly id: number }>;
}

/** Copies kept, newest first. */
export const MAX_COPIES = 5;
/** A copy older than this is no longer offered as "đoạn vừa copy" (decided 16/11/2026). */
export const OFFER_WINDOW_MS = 10 * 60_000;
/** Characters of one attachment (proto AdvisorAttachment.text). */
export const MAX_COPY_CHARS = 8000;
/** Automatic answers kept for finding again; older ones drop. */
export const MAX_HISTORY = 8;
/** Questions kept for showing; older ones drop. */
const MAX_QUESTIONS = 5;

const DOCK_KEY = "advisor:dock";
const HIDDEN_KEY = "advisor:hidden";
const MACHINE_KEY = "advisor:machine";
const AI_KEY = "advisor:ai:";
const QUESTIONS_KEY = "advisor:questions";

function readJson(storage: () => Storage, key: string): unknown {
	try {
		const raw = storage().getItem(key);
		return raw === null ? null : (JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

function writeItem(storage: () => Storage, key: string, value: string | null): void {
	try {
		if (value === null) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
		// Private mode or storage full: the choice lasts this page only.
	}
}

const local = () => window.localStorage;
const session = () => window.sessionStorage;

function readDock(): Dock {
	const raw = readJson(local, DOCK_KEY);
	if (typeof raw !== "object" || raw === null) return DEFAULT_DOCK;
	const { side, y } = raw as Record<string, unknown>;
	if ((side !== "left" && side !== "right") || typeof y !== "number" || !Number.isFinite(y)) return DEFAULT_DOCK;
	return { side, y: Math.min(1, Math.max(0, y)) };
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The questions a reload left in this tab (ids only). */
function readQuestions(): Question[] {
	const raw = readJson(session, QUESTIONS_KEY);
	if (!Array.isArray(raw)) return [];
	const out: Question[] = [];
	for (const entry of raw.slice(0, MAX_QUESTIONS)) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		const id = str(e.id);
		const machine = str(e.machine);
		const threadId = str(e.threadId);
		if (id === "" || machine === "" || threadId === "") continue;
		const askedAt = typeof e.askedAt === "number" ? e.askedAt : 0;
		out.push({ id, machine, threadId, dir: str(e.dir), askedAt, text: "", attached: [], sent: true, error: "" });
	}
	return out;
}

function saveQuestions(questions: readonly Question[]): void {
	const kept = questions.filter((q) => q.threadId !== "").map(({ id, machine, threadId, dir, askedAt }) => ({ id, machine, threadId, dir, askedAt }));
	writeItem(session, QUESTIONS_KEY, kept.length === 0 ? null : JSON.stringify(kept));
}

let nextId = 0;

export class AdvisorStore {
	private state: AdvisorState;
	private readonly listeners = new Set<() => void>();
	private nextFill = 0;

	constructor(private readonly now: () => number = Date.now) {
		this.state = {
			copies: [],
			used: new Set(),
			questions: readQuestions(),
			open: false,
			mood: "idle",
			note: "",
			flash: "",
			flashTarget: "",
			history: [],
			dot: false,
			dock: readDock(),
			hidden: readJson(local, HIDDEN_KEY) === true,
			session: null,
			chat: null,
			fills: new Map(),
		};
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	readonly snapshot = (): AdvisorState => this.state;

	private set(change: Partial<AdvisorState>): void {
		this.state = { ...this.state, ...change };
		for (const listener of this.listeners) listener();
	}

	// --- copies ----------------------------------------------------------------

	/** Keeps a copy (already checked: no secret, not from a sensitive screen). */
	remember(text: string, context: CopyContext): void {
		const record: CopyRecord = { id: `c${++nextId}`, text, context, at: this.now() };
		// The same text copied again moves up instead of filling the list.
		const others = this.state.copies.filter((c) => c.text !== text);
		this.set({ copies: [record, ...others].slice(0, MAX_COPIES) });
	}

	/** The newest copy to offer now (offerOf). */
	offer(): CopyRecord | null {
		return offerOf(this.state, this.now());
	}

	/** Attached or dismissed: not offered again. */
	markUsed(ids: readonly string[]): void {
		if (ids.length === 0) return;
		const used = new Set(this.state.used);
		for (const id of ids) used.add(id);
		this.set({ used });
	}

	private forgetTimer: ReturnType<typeof setTimeout> | null = null;

	/** The signed-in app (the mascot) shows: a forget asked a moment ago was React remounting it, not a sign-out. */
	keep(): void {
		if (this.forgetTimer !== null) clearTimeout(this.forgetTimer);
		this.forgetTimer = null;
	}

	/**
	 * The signed-in app went away (sign-out, another account): nothing of this
	 * account's Advisor outlives it here, neither the copies, the questions
	 * (and their ids in this tab), the composer fills nor the session shown.
	 * Waits a tick, so a remount (keep) cancels it.
	 */
	forgetSoon(): void {
		this.keep();
		this.forgetTimer = setTimeout(() => {
			this.forgetTimer = null;
			this.forgetAll();
		}, 0);
	}

	forgetAll(): void {
		saveQuestions([]);
		this.set({ copies: [], used: new Set(), questions: [], fills: new Map(), session: null, chat: null, open: false, flash: "", flashTarget: "", history: [], dot: false, mood: "idle", note: "" });
	}

	// --- questions -------------------------------------------------------------

	addQuestion(question: Question): void {
		const questions = [question, ...this.state.questions.filter((q) => q.id !== question.id)].slice(0, MAX_QUESTIONS);
		saveQuestions(questions);
		this.set({ questions });
	}

	updateQuestion(id: string, change: Partial<Pick<Question, "sent" | "error" | "threadId">>): void {
		const questions = this.state.questions.map((q) => (q.id === id ? { ...q, ...change } : q));
		saveQuestions(questions);
		this.set({ questions });
	}

	/** The user closed the answer: the question is done on this device. */
	dropQuestion(id: string): void {
		const questions = this.state.questions.filter((q) => q.id !== id);
		saveQuestions(questions);
		this.set({ questions });
	}

	// --- mascot ----------------------------------------------------------------

	setOpen(open: boolean): void {
		if (open === this.state.open) return;
		// The dot (another device's answer) stays while the bubble says so; closing it is reading it.
		this.set(open ? { open, flash: "", flashTarget: "" } : { open, dot: false });
	}

	setMood(mood: Mood, note: Note): void {
		if (mood === this.state.mood && note === this.state.note) return;
		this.set({ mood, note });
	}

	/** `target`: the page the line is about, so a tap on it brings the user back to that session and tab. */
	setFlash(flash: string, target = ""): void {
		if (flash !== this.state.flash || target !== this.state.flashTarget) this.set({ flash, flashTarget: flash === "" ? "" : target });
	}

	addHistory(entry: HistoryEntry): void {
		if (this.state.history.some((h) => h.id === entry.id)) return;
		this.set({ history: [entry, ...this.state.history].slice(0, MAX_HISTORY) });
	}

	/** The session of this answer cannot be opened: the answer stays listed, no longer tappable. */
	markUnavailable(id: string, why: "missing" | "unreachable"): void {
		this.set({ history: this.state.history.map((h) => (h.id === id ? { ...h, unavailable: why } : h)) });
	}

	setDot(dot: boolean): void {
		if (dot !== this.state.dot) this.set({ dot });
	}

	setDock(dock: Dock): void {
		writeItem(local, DOCK_KEY, JSON.stringify(dock));
		this.set({ dock });
	}

	setHidden(hidden: boolean): void {
		writeItem(local, HIDDEN_KEY, hidden ? "true" : null);
		this.set(hidden ? { hidden, open: false } : { hidden });
	}

	setSession(session: AdvisorState["session"]): void {
		const s = this.state.session;
		if (s?.machine === session?.machine && s?.threadId === session?.threadId) return;
		this.set({ session });
	}

	/** The chat whose composer shows now; null when it goes. */
	setChat(chat: AdvisorState["chat"]): void {
		const c = this.state.chat;
		if (c?.chatId === chat?.chatId && c?.topicId === chat?.topicId) return;
		this.set({ chat });
	}

	// --- "Gửi sang phiên" ------------------------------------------------------

	/** Puts `text` in the composer of a session (it fills when the session shows). */
	fill(machine: string, threadId: string, text: string): void {
		const fills = new Map(this.state.fills);
		fills.set(fillKey(machine, threadId), { text, id: ++this.nextFill });
		this.set({ fills });
	}

	/** Puts `text` in the composer of a chat (the user sends it). */
	fillChat(chatId: number, topicId: number, text: string): void {
		const fills = new Map(this.state.fills);
		fills.set(chatFillKey(chatId, topicId), { text, id: ++this.nextFill });
		this.set({ fills });
	}

	/** The chat's composer took its text. */
	takeChatFill(chatId: number, topicId: number, id: number): void {
		this.takeKey(chatFillKey(chatId, topicId), id);
	}

	/** The session's composer took its text. */
	takeFill(machine: string, threadId: string, id: number): void {
		this.takeKey(fillKey(machine, threadId), id);
	}

	private takeKey(key: string, id: number): void {
		if (this.state.fills.get(key)?.id !== id) return;
		const fills = new Map(this.state.fills);
		fills.delete(key);
		this.set({ fills });
	}
}

/** The newest copy to offer at `now`: within 10 minutes and neither attached nor dismissed yet. */
export function offerOf(state: Pick<AdvisorState, "copies" | "used">, now: number): CopyRecord | null {
	const newest = state.copies[0];
	if (newest === undefined || state.used.has(newest.id) || now - newest.at > OFFER_WINDOW_MS) return null;
	return newest;
}

function fillKey(machine: string, threadId: string): string {
	return `${machine}\n${threadId}`;
}

function chatFillKey(chatId: number, topicId: number): string {
	return `chat\n${chatId}\n${topicId}`;
}

/** The machine picked last for asking (per device); "" before any. */
export function lastMachine(): string {
	return str(readJson(local, MACHINE_KEY));
}

export function rememberMachine(ref: string): void {
	writeItem(local, MACHINE_KEY, JSON.stringify(ref));
}

/** The AI picked last on a machine for asking; "" before any. */
export function lastAi(machine: string): string {
	return str(readJson(local, AI_KEY + machine));
}

export function rememberAi(machine: string, ai: string): void {
	writeItem(local, AI_KEY + machine, JSON.stringify(ai));
}

export const advisorStore = new AdvisorStore();

export function useAdvisorState(store: AdvisorStore = advisorStore): AdvisorState {
	return useSyncExternalStore(store.subscribe, store.snapshot);
}

/** Text Advisor put in this session's composer, until the composer takes it (session-chat.tsx). */
export function useSessionFill(machine: string, threadId: string): { readonly text: string; readonly id: number } | undefined {
	return useAdvisorState().fills.get(fillKey(machine, threadId));
}

/** Text Advisor put in this chat's composer, until the composer takes it (messaging/ui/composer.tsx). */
export function useChatFill(chatId: number, topicId: number): { readonly text: string; readonly id: number } | undefined {
	return useAdvisorState().fills.get(chatFillKey(chatId, topicId));
}
