// The live side of Advisor, loaded with the link code the first time the
// bubble opens (or on the machines screens, which have it already): which
// machine and AI a question goes to, the link to that machine (started only
// now, kept pinging while a question waits there), the mascot's mood, the
// questions this tab asked and their answers read from the Advisor thread's
// journal, and the short line beside the mascot when an automatic verdict
// comes in the session shown. Asking uses the thread requests (proto
// "advisor"): ThreadCreate{kind: ADVISOR} gives the thread of that folder
// and AI, ThreadSend{client_msg_id} queues the question, ThreadInterrupt
// with the same id stops it.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AdvisorTone as ProtoAdvisorTone, ErrorCode, LoginState, Role, ThreadKind, ThreadState, TurnState, type AdvisorVerdictItem, type Item, type MachineInfo, type ProviderInfo, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import type { AdvisorTone } from "@achoo254/chat-core";
import { LOCAL_REF, localMachine, type LinkHub } from "../machines/link/link-hub.ts";
import { OfflineError, RemoteError, type LinkState, type MachineLink } from "../machines/link/machine-link.ts";
import { shouldConnect } from "../machines/machine-status.ts";
import type { MachineEntry } from "../machines/machines-client.ts";
import { inFolder } from "../machines/projects-view.ts";
import { EMPTY_JOURNAL, orderedItems, type Journal } from "../machines/transcript/reducer.ts";
import { folderName, useDirectory, useHub, useNow } from "../machines/use-machines.ts";
import { allowedFields } from "./advisor-surfaces.ts";
import { advisorStore, lastAi, lastMachine, rememberAi, rememberMachine, useAdvisorState, type AdvisorStore, type CopyRecord, type Mood, type Note, type Question } from "./advisor-store.ts";

/** How long asking waits for the machine's link to open. */
const OPEN_WAIT_MS = 20_000;
/** How long the short line of an automatic verdict stays beside the mascot. */
export const FLASH_MS = 20_000;
/** Attachments one question takes (proto AdvisorAttachment). */
const MAX_ATTACHMENTS = 5;
/** Characters of one context field (proto AdvisorContext). */
const CONTEXT_CHARS = 200;

/** A sent question the idle thread does not know after this long is lost (the machine answers within 120 s or fails). */
const LOST_AFTER_MS = 15_000;
/** Times an older page of a thread is asked for before the thread counts as unreadable. */
const EARLIER_TRIES = 3;
/** The wait before trying an older page again, times the attempt. */
const EARLIER_RETRY_MS = 300;
/** A machine that lists no Advisor thread: a question it never answered is given up after this long. */
const GIVE_UP_MS = 15 * 60_000;

/** The profile's tone as the proto names it: the machine turns it into a fixed line of its own. */
export const PROTO_TONES: Readonly<Record<AdvisorTone, ProtoAdvisorTone>> = {
	short: ProtoAdvisorTone.SHORT,
	fun: ProtoAdvisorTone.FUN,
	serious: ProtoAdvisorTone.SERIOUS,
};

export type AnswerState = "waiting" | "thinking" | "answered" | "stopped" | "failed";

export interface Answer {
	readonly state: AnswerState;
	/** The question as the journal holds it ("" until it arrives). */
	readonly question: string;
	/** The AI's reply (its text of the turn). */
	readonly text: string;
	/** Advisor's verdict of the turn (kind "answer"), when the AI weighed its options. */
	readonly verdict: AdvisorVerdictItem | null;
	/** The error the turn ended with ("" when none). */
	readonly error: string;
}

/** The answer of question `id` in an Advisor thread's items (display order). */
export function answerOf(items: readonly Item[], id: string): Answer {
	let question = "";
	let turnAt = -1;
	for (const [i, item] of items.entries()) {
		const b = item.body;
		if (b.case === "text" && b.value.role === Role.USER && b.value.clientMsgId === id) question = b.value.text;
		if (b.case === "turn" && b.value.clientMsgId === id) turnAt = i;
	}
	const turn = turnAt < 0 ? undefined : items[turnAt];
	if (turn === undefined || turn.body.case !== "turn") return { state: "waiting", question, text: "", verdict: null, error: "" };
	const turnId = turn.id;
	const texts: string[] = [];
	let verdict: AdvisorVerdictItem | null = null;
	let error = "";
	for (const item of items.slice(turnAt + 1)) {
		const b = item.body;
		// The next question's turn starts the next answer.
		if (b.case === "turn") break;
		if (b.case === "text" && b.value.role === Role.ASSISTANT && b.value.text.trim() !== "") texts.push(b.value.text.trim());
		if (b.case === "error") error = b.value.message;
	}
	for (const item of items) {
		const b = item.body;
		if (b.case !== "advisorVerdict" || b.value.turnId !== turnId) continue;
		// The answer's own verdict wins over one the AI asked on the way.
		if (verdict === null || b.value.kind === "answer") verdict = b.value;
	}
	const states: Partial<Record<TurnState, AnswerState>> = {
		[TurnState.RUNNING]: "thinking",
		[TurnState.COMPLETED]: "answered",
		[TurnState.INTERRUPTED]: "stopped",
		[TurnState.FAILED]: "failed",
	};
	return { state: states[turn.body.value.state] ?? "thinking", question, text: texts.join("\n\n"), verdict, error };
}

/** Options by probability, highest first; the first is the one to take. */
export function rankedOptions(verdict: AdvisorVerdictItem): AdvisorVerdictItem["options"] {
	return [...verdict.options].sort((a, b) => b.probability - a.probability);
}

/** An option that would run as a command in a session ("/…", "!…"): never sent there. */
export function isCommand(text: string): boolean {
	const t = text.trimStart();
	return t.startsWith("/") || t.startsWith("!");
}

/** The AIs of a machine that can run Advisor's read-only session (and are signed in). */
export function advisorAis(info: MachineInfo | null): ProviderInfo[] {
	return (info?.providers ?? []).filter((p) => p.capabilities?.advisorSession === true && p.loginState !== LoginState.NEEDS_LOGIN);
}

/** Why Advisor cannot answer on the machine now; "" when it can, null while its link is still opening. */
export function noteOf(target: string, state: LinkState | null): Note | null {
	if (target === "" || state === null) return "no-machine";
	const status = state.status.kind;
	if (status === "failed" || status === "offline") return "offline";
	if (status !== "open" || state.info === null) return null;
	const advisor = state.info.advisor;
	if (advisor === undefined) return "update";
	if (!advisor.available) return "mcp-off";
	if (advisorAis(state.info).length === 0) return "no-ai";
	if (!advisor.keySet) return "no-key";
	return "";
}

/** The mascot's mood from the target machine and this tab's questions. */
export function moodOf(note: Note | null, waiting: boolean, unseen: boolean): Mood {
	if (waiting) return "thinking";
	if (unseen) return "answering";
	if (note === null) return "connecting";
	if (note === "" || note === "no-key") return "idle";
	return "sleeping";
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, CONTEXT_CHARS);
}

/** What goes to the machine for the copies attached: never the machine's own ref (the link names it). */
export function attachmentsOf(
	copies: readonly CopyRecord[],
): { text: string; context: { screen: string; dir: string; branch: string; threadId: string; panel: string; action: string; errorCode: string; failureId: string; fields: Record<string, string> } }[] {
	return copies.slice(0, MAX_ATTACHMENTS).map(({ text, context: c }) => ({
		text,
		context: {
			screen: oneLine(c.screen),
			dir: oneLine(c.dir),
			branch: oneLine(c.branch),
			threadId: oneLine(c.threadId),
			panel: oneLine(c.panel),
			action: oneLine(c.action),
			errorCode: oneLine(c.errorCode),
			failureId: oneLine(c.failureId),
			// Only what the surface lists, one line each; the rest never leaves the page.
			fields: Object.fromEntries(Object.entries(allowedFields(c.panel, c.screen, c.fields)).map(([key, value]) => [key, oneLine(value)])),
		},
	}));
}

/** Resolves true once the link is open, false after `ms` without. */
/** True once the machine's thread list has arrived on the link; false when it does not within `ms`. */
function waitListed(link: MachineLink, ms: number): Promise<boolean> {
	if (link.snapshot().listed) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => {
			off();
			resolve(false);
		}, ms);
		const off = link.subscribe(() => {
			if (!link.snapshot().listed) return;
			window.clearTimeout(timer);
			off();
			resolve(true);
		});
	});
}

function waitOpen(link: MachineLink, ms: number): Promise<boolean> {
	if (link.snapshot().status.kind === "open") return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => {
			off();
			resolve(false);
		}, ms);
		const off = link.subscribe(() => {
			const kind = link.snapshot().status.kind;
			if (kind !== "open" && kind !== "failed") return;
			window.clearTimeout(timer);
			off();
			resolve(kind === "open");
		});
	});
}

export type AskResult = { readonly kind: "asked" } | { readonly kind: "consent"; readonly dir: string } | { readonly kind: "error"; readonly error: unknown };

export interface AskInput {
	readonly text: string;
	readonly attached: readonly CopyRecord[];
	readonly tone: AdvisorTone;
	/** The user agreed that Advisor reads in a sensitive folder. */
	readonly sensitive: boolean;
}

export interface Presence {
	readonly hub: LinkHub;
	readonly machines: readonly MachineEntry[];
	/** The machine a question goes to; "" when none is known. */
	readonly target: string;
	readonly pickMachine: (ref: string) => void;
	readonly state: LinkState | null;
	/** The state of a machine's link this tab follows (the target, the session shown, a question's). */
	readonly stateOf: (ref: string) => LinkState | null;
	readonly ais: readonly ProviderInfo[];
	readonly ai: string;
	readonly pickAi: (id: string) => void;
	/** Where the question runs ("" for the machine's scratch folder). */
	readonly dir: string;
	readonly note: Note | null;
	readonly answers: ReadonlyMap<string, Answer>;
	/** Questions the machine will never answer (no turn of theirs in the thread's whole journal). */
	readonly lost: ReadonlySet<string>;
	readonly ask: (input: AskInput) => Promise<AskResult>;
	readonly stop: (question: Question) => Promise<void>;
	/** Sessions of the question's machine working in its folder, for "Gửi sang phiên". */
	readonly sessionsFor: (question: Question) => readonly ThreadSummary[];
	/** Whether a session can still be opened: the machine answers and still lists it. */
	readonly checkSession: (machine: string, threadId: string) => Promise<SessionCheck>;
}

export type SessionCheck = "ok" | "missing" | "unreachable";

/** Every machine the directory lists (and the development machine). */
function machinesOf(listed: readonly MachineEntry[], hub: LinkHub): MachineEntry[] {
	const local = localMachine() !== null ? hub.entry(LOCAL_REF) : null;
	return local === null ? [...listed] : [...listed, local];
}

/** A question this tab still waits for: not failed, not lost, its turn not over. */
function waitingFor(q: Question, answer: Answer | undefined): boolean {
	return q.error === "" && (answer?.state === "waiting" || answer?.state === "thinking");
}

/**
 * The live part of the mascot. The machine a question goes to: the newest
 * attached copy's (`attachedMachine`), the one picked in the bubble or last
 * time, the session shown; else the first machine online with a key (their
 * links open only while the bubble is open), else the first online.
 */
export function useAdvisorPresence(attachedMachine: string, open: boolean, store: AdvisorStore = advisorStore): Presence {
	const hub = useHub();
	const directory = useDirectory(hub);
	const machines = machinesOf(directory.machines, hub);
	const [picked, setPicked] = useState("");
	const [pickedAi, setPickedAi] = useState("");
	const { questions, session } = useAdvisorState(store);

	// The directory and this device's key, once (the machines screens do it too).
	useEffect(() => {
		hub.device().catch(() => undefined);
		if (hub.directory().status !== "ready") hub.refresh().catch(() => undefined);
	}, [hub]);

	// "Last seen" in the directory ages while a page stays open: look again each time the bubble opens
	// (one request at a time, the hub shares it), or a machine that came back is not found.
	useEffect(() => {
		if (open) hub.refresh().catch(() => undefined);
	}, [hub, open]);

	const known = (ref: string) => ref !== "" && machines.some((m) => m.ref === ref);
	const now = useNow();
	const online = machines.filter((m) => shouldConnect(m, now)).map((m) => m.ref);
	const chosen = [attachedMachine, picked, lastMachine(), session?.machine ?? ""].find(known) ?? "";
	// Nothing points at a machine: the bubble looks at the machines online for one with a key.
	const looking = chosen === "" && open ? online : [];

	// The machines this tab follows (the target, the session shown, the questions', those online), their links' states;
	// following a link opens nothing: links start only below.
	const watchedRefs = [...new Set([chosen, session?.machine ?? "", ...online, ...questions.map((q) => q.machine)].filter((r) => r !== ""))].sort().join("\n");
	const states = useLinkStates(hub, watchedRefs);
	const target = chosen !== "" ? chosen : (online.find((ref) => states.get(ref)?.info?.advisor?.keySet === true) ?? online[0] ?? "");
	const link = target === "" ? null : hub.link(target);

	// Links open only while the bubble is open or a question waits (lazy connection).
	const lookingKey = looking.join("\n");
	useEffect(() => {
		if (!open) return;
		if (link !== null) link.start();
		for (const ref of lookingKey === "" ? [] : lookingKey.split("\n")) hub.link(ref).start();
	}, [hub, link, open, lookingKey]);

	/** Threads whose older pages could not be read (EARLIER_TRIES failed in a row, "machine\nthread"): their unfound questions are lost. */
	const [unreadable, setUnreadable] = useState<ReadonlySet<string>>(() => new Set());
	const answers = new Map<string, Answer>();
	/** Questions the journal no longer knows (stopped while queued elsewhere, sent while the link dropped, …). */
	const lost = new Set<string>();
	/** Threads whose older items must be read before a question can be called lost ("machine\nthread\nearlier mark"). */
	const older = new Set<string>();
	for (const q of questions) {
		const linkState = states.get(q.machine);
		const journal: Journal = linkState?.journals.get(q.threadId) ?? EMPTY_JOURNAL;
		const answer = answerOf(orderedItems(journal), q.id);
		answers.set(q.id, answer);
		if (answer.state !== "waiting" || answer.question !== "" || !q.sent || linkState === undefined) continue;
		const thread = linkState.advisorThreads.find((t) => t.id === q.threadId);
		const busy = thread === undefined || thread.state === ThreadState.RUNNING || thread.state === ThreadState.QUEUED;
		const loaded = linkState.status.kind === "open" && journal.cursor !== null;
		if (loaded && journal.earlier !== "" && unreadable.has(`${q.machine}\n${q.threadId}`)) lost.add(q.id);
		else if (loaded && journal.earlier !== "") older.add(`${q.machine}\n${q.threadId}\n${journal.earlier}`);
		// The thread is idle with its journal read to the start and no turn names it: it will never answer.
		else if (loaded && !busy && now - q.askedAt > LOST_AFTER_MS) lost.add(q.id);
		// A machine that never says (no Advisor thread listed): give up after a long while.
		else if (thread === undefined && now - q.askedAt > GIVE_UP_MS) lost.add(q.id);
	}
	const waiting = questions.filter((q) => !lost.has(q.id) && waitingFor(q, answers.get(q.id)));

	// A question not found in the pages read so far: the page before is read, and the next one once it is in (the mark
	// is part of the key), until the question shows or the start is in. A page that fails EARLIER_TRIES times in a row
	// makes the thread unreadable: its questions are lost and their hold ends.
	const olderKey = [...older].sort().join("\n\n");
	useEffect(() => {
		let stopped = false;
		for (const entry of olderKey === "" ? [] : olderKey.split("\n\n")) {
			const [ref = "", threadId = "", mark = ""] = entry.split("\n");
			const link = hub.link(ref);
			const moved = () => (link.snapshot().journals.get(threadId)?.earlier ?? "") !== mark;
			void (async () => {
				for (let attempt = 0; attempt < EARLIER_TRIES && !stopped; attempt++) {
					if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, EARLIER_RETRY_MS * attempt));
					if (stopped) return;
					await link.loadEarlier(threadId);
					if (stopped || moved()) return;
				}
				if (!stopped) setUnreadable((was) => new Set(was).add(`${ref}\n${threadId}`));
			})();
		}
		return () => {
			stopped = true;
		};
	}, [hub, olderKey]);

	// Questions: their threads followed (a reconnect reads the journal again); the links of waiting ones kept up and pinging.
	const waitingKey = waiting.map((q) => `${q.machine}\n${q.threadId}`).join("\n\n");
	const allKey = questions.map((q) => `${q.machine}\n${q.threadId}`).join("\n\n");
	useEffect(() => {
		const offs: (() => void)[] = [];
		for (const pair of allKey === "" ? [] : allKey.split("\n\n")) {
			const [ref = "", threadId = ""] = pair.split("\n");
			const l = hub.link(ref);
			l.start();
			offs.push(l.watch(threadId));
		}
		const held = new Set(waitingKey === "" ? [] : waitingKey.split("\n\n").map((pair) => pair.split("\n")[0] ?? ""));
		for (const ref of held) offs.push(hub.hold(ref));
		return () => {
			for (const off of offs) off();
		};
	}, [hub, allKey, waitingKey]);

	// Questions not taken yet (the link dropped while sending): sent again once it opens; the machine drops a repeat.
	const sending = useRef(new Set<string>());
	useEffect(() => {
		for (const q of questions) {
			if (q.sent || q.error !== "" || q.threadId === "" || sending.current.has(q.id)) continue;
			const l = hub.link(q.machine);
			if (l.snapshot().status.kind !== "open") continue;
			sending.current.add(q.id);
			sendQuestion(l, q, store).finally(() => sending.current.delete(q.id));
		}
	});

	const state = states.get(target) ?? null;
	const note = noteOf(target, state);
	const ais = advisorAis(state?.info ?? null);
	const ai = [pickedAi, lastAi(target)].find((id) => ais.some((p) => p.id === id)) ?? ais[0]?.id ?? "";
	const sessionDir = session !== null && session.machine === target ? (state?.threads.find((t) => t.id === session.threadId)?.dir ?? "") : "";

	// The mood: answers not seen yet make it "answering" until the bubble opens.
	const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
	const answered = questions.filter((q) => answers.get(q.id)?.state === "answered").map((q) => q.id);
	const unseen = answered.some((id) => !seen.has(id));
	// Opening the bubble shows them (state kept from render, as React allows).
	if (open && unseen) setSeen(new Set(answered));
	const mood = moodOf(note, waiting.length > 0, unseen && !open);
	useEffect(() => store.setMood(mood, note ?? ""), [store, mood, note]);
	const busy = waiting.length > 0;
	useEffect(() => store.setBusy(busy), [store, busy]);

	useVerdictFlash(hub, store);
	const waitingThreads = useMemo(() => new Set(waitingKey === "" ? [] : waitingKey.split("\n\n").map((pair) => pair.split("\n")[1] ?? "")), [waitingKey]);
	useOtherAnswers(hub, watchedRefs, waitingThreads, store);

	const ask = async (input: AskInput): Promise<AskResult> => {
		if (link === null || ai === "") return { kind: "error", error: new OfflineError() };
		const attachedDir = input.attached.find((c) => c.context.machine === target && c.context.dir !== "")?.context.dir;
		const dir = attachedDir ?? sessionDir;
		rememberMachine(target);
		rememberAi(target, ai);
		link.start();
		if (!(await waitOpen(link, OPEN_WAIT_MS))) return { kind: "error", error: new OfflineError() };
		let threadId: string;
		try {
			const frame = await link.request({
				case: "threadCreate",
				value: { provider: ai, model: "", dir, text: "", kind: ThreadKind.ADVISOR, consent: { sensitive: input.sensitive } },
			});
			if (frame.body.case !== "threadCreated" || frame.body.value.thread === undefined) return { kind: "error", error: new OfflineError() };
			threadId = frame.body.value.thread.id;
		} catch (err) {
			if (err instanceof RemoteError && err.code === ErrorCode.NEEDS_CONSENT) return { kind: "consent", dir: err.subject || dir };
			return { kind: "error", error: err };
		}
		const question: Question = {
			id: crypto.randomUUID(),
			machine: target,
			threadId,
			dir,
			askedAt: Date.now(),
			text: input.text,
			tone: input.tone,
			attached: input.attached,
			sent: false,
			error: "",
		};
		store.addQuestion(question);
		store.markUsed(input.attached.map((c) => c.id));
		sending.current.add(question.id);
		try {
			await sendQuestion(link, question, store);
		} finally {
			sending.current.delete(question.id);
		}
		return { kind: "asked" };
	};

	const stop = async (question: Question): Promise<void> => {
		await hub.link(question.machine).request({ case: "threadInterrupt", value: { threadId: question.threadId, clientMsgId: question.id } });
		// Stopped while it waited in the queue: it never gets a turn, so it is done here.
		if (answers.get(question.id)?.state === "waiting") store.dropQuestion(question.id);
	};

	const checkSession = async (machine: string, threadId: string): Promise<SessionCheck> => {
		const l = hub.link(machine);
		l.start();
		if (!(await waitOpen(l, OPEN_WAIT_MS)) || !(await waitListed(l, OPEN_WAIT_MS))) return "unreachable";
		return l.snapshot().threads.some((t) => t.id === threadId && !t.archived) ? "ok" : "missing";
	};
	const sessionsFor = (question: Question): readonly ThreadSummary[] => {
		const threads = (states.get(question.machine)?.threads ?? []).filter((t) => !t.archived && t.kind !== ThreadKind.ADVISOR);
		const from = new Set(question.attached.map((c) => c.context.threadId).filter((id) => id !== ""));
		const inDir = threads.filter((t) => from.has(t.id) || (question.dir !== "" && (inFolder(t.dir, question.dir) || inFolder(question.dir, t.dir))));
		return [...inDir.filter((t) => from.has(t.id)), ...inDir.filter((t) => !from.has(t.id))].slice(0, 5);
	};

	return {
		hub,
		machines,
		target,
		pickMachine: (ref) => {
			setPicked(ref);
			setPickedAi("");
		},
		state,
		stateOf: (ref) => states.get(ref) ?? null,
		ais,
		ai,
		pickAi: setPickedAi,
		dir: sessionDir,
		note,
		answers,
		lost,
		ask,
		stop,
		sessionsFor,
		checkSession,
	};
}

/**
 * The states of the links to `refs` ("\n"-separated), read through a
 * subscribing hook: a new map whenever one of them changes.
 */
function useLinkStates(hub: LinkHub, refs: string): ReadonlyMap<string, LinkState> {
	const cache = useRef<{ readonly refs: string; readonly list: readonly LinkState[]; readonly map: ReadonlyMap<string, LinkState> } | null>(null);
	const subscribe = useCallback(
		(listener: () => void) => {
			const offs = refs === "" ? [] : refs.split("\n").map((ref) => hub.link(ref).subscribe(listener));
			return () => {
				for (const off of offs) off();
			};
		},
		[hub, refs],
	);
	const read = useCallback((): ReadonlyMap<string, LinkState> => {
		const list = refs === "" ? [] : refs.split("\n").map((ref) => hub.link(ref).snapshot());
		const last = cache.current;
		if (last !== null && last.refs === refs && last.list.length === list.length && last.list.every((s, i) => s === list[i])) return last.map;
		const keys = refs === "" ? [] : refs.split("\n");
		const map = new Map(keys.map((ref, i) => [ref, list[i] ?? hub.link(ref).snapshot()]));
		cache.current = { refs, list, map };
		return map;
	}, [hub, refs]);
	return useSyncExternalStore(subscribe, read);
}

/**
 * Sends a question; the machine drops a repeat of its id. A link that drops
 * meanwhile leaves it unsent (sent again on reconnect); a refusal is kept
 * as its error.
 */
async function sendQuestion(link: MachineLink, question: Question, store: AdvisorStore): Promise<void> {
	// After a reload the text is gone (only ids are stored): nothing to send again.
	if (question.text === "") return;
	try {
		await link.request({
			case: "threadSend",
			value: {
				threadId: question.threadId,
				text: question.text,
				clientMsgId: question.id,
				attachmentIds: [],
				advisorAttachments: attachmentsOf(question.attached),
				advisorTone: question.tone === undefined ? ProtoAdvisorTone.UNSPECIFIED : PROTO_TONES[question.tone],
			},
		});
		store.updateQuestion(question.id, { sent: true });
	} catch (err) {
		if (err instanceof OfflineError) return;
		store.updateQuestion(question.id, { error: err instanceof Error ? err.message || "error" : "error" });
	}
}

/**
 * The session shown with automatic Advisor on: a verdict that comes while it
 * shows puts a short line beside the mascot (the transcript's card is the
 * session's own). Verdicts already there when it opened say nothing.
 */
function useVerdictFlash(hub: LinkHub, store: AdvisorStore): void {
	const session = store.snapshot().session;
	const machine = session?.machine ?? "";
	const threadId = session?.threadId ?? "";
	useEffect(() => {
		if (machine === "" || threadId === "") return;
		const link = hub.link(machine);
		let seen: Set<string> | null = null;
		let timer = 0;
		const check = () => {
			const journal = link.snapshot().journals.get(threadId);
			if (journal === undefined) return;
			const verdicts = orderedItems(journal).filter((i) => i.body.case === "advisorVerdict");
			if (seen === null) {
				seen = new Set(verdicts.map((i) => i.id));
				return;
			}
			const fresh = verdicts.filter((i) => !seen?.has(i.id));
			for (const i of fresh) seen.add(i.id);
			const page = window.location.pathname + window.location.search;
			const thread = link.snapshot().threads.find((x) => x.id === threadId);
			for (const i of fresh) {
				const text = i.body.case === "advisorVerdict" ? verdictLine(i.body.value) : "";
				if (text !== "") store.addHistory({ id: i.id, machine, threadId, title: thread?.title || (thread === undefined ? "" : folderName(thread.dir)), text, target: page, at: Date.now(), unavailable: "" });
			}
			const last = fresh.at(-1)?.body;
			if (last?.case !== "advisorVerdict" || store.snapshot().open || store.snapshot().busy) return;
			// The page as it shows now (the session in its chat, terminal or office view): a tap on the line returns to it.
			store.setFlash(verdictLine(last.value), page);
			window.clearTimeout(timer);
			timer = window.setTimeout(() => store.setFlash(""), FLASH_MS);
		};
		check();
		const off = link.subscribe(check);
		return () => {
			off();
			window.clearTimeout(timer);
		};
	}, [hub, machine, threadId, store]);
}

/** "Option (82%)" for a verdict; its error code when Advisor did not answer (worded by the mascot). */
export function verdictLine(verdict: AdvisorVerdictItem): string {
	if (verdict.error !== "") return `!${verdict.error}`;
	const top = rankedOptions(verdict)[0];
	return top === undefined ? "" : `${top.text} (${Math.round(top.probability * 100)}%)`;
}

/**
 * An Advisor thread of a machine this tab follows finished a turn while this
 * tab waited for nothing there (the thread is shared by folder and AI, so it
 * was another device's question): a dot on the mascot.
 */
function useOtherAnswers(hub: LinkHub, refs: string, mine: ReadonlySet<string>, store: AdvisorStore): void {
	const previous = useRef(new Map<string, ThreadState>());
	useEffect(() => {
		if (refs === "") return;
		const links = refs.split("\n").map((ref) => hub.link(ref));
		const check = () => {
			for (const link of links) {
				for (const thread of link.snapshot().advisorThreads) {
					const before = previous.current.get(thread.id);
					previous.current.set(thread.id, thread.state);
					const ended = before === ThreadState.RUNNING && thread.state !== ThreadState.RUNNING && thread.state !== ThreadState.QUEUED;
					if (ended && !mine.has(thread.id) && !store.snapshot().open && !store.snapshot().busy) store.setDot(true);
				}
			}
		};
		check();
		const offs = links.map((link) => link.subscribe(check));
		return () => {
			for (const off of offs) off();
		};
	}, [hub, refs, mine, store]);
}
