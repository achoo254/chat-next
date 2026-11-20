// The send side of a person's merged screen (ADR 0025). The screen's composer
// is the chat screen's own, bound to one chat (its draft, reply and edit are
// per chat) and sending through a data source that fans every new message out
// to the target chats (fan-out-source.ts). Replying to or editing a message
// binds the composer to that message's chat and narrows the targets to it;
// what was typed moves along, and when the reply or edit ends the composer
// and its text go back to the chat they came from, the targets as they were.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { Drafts } from "../data/drafts.ts";
import { Toasts, useServices, type Services } from "../data/services.tsx";
import { addAttachments, attachments } from "../media/media-state.ts";
import type { LimitedActions } from "../ui/message-item.tsx";
import { useIntent, useUi, type ComposerIntent } from "../ui/ui-context.tsx";
import { fanOutSource, type FanOutPlan } from "./fan-out-source.ts";
import type { LinkedPerson } from "./people-api.ts";
import { SendStatus } from "./send-status.ts";
import { PersonSendPrefs } from "./send-prefs.ts";
import { blocks, effectiveTargets, hasRow, initialSelection, newestChat, primaryOf, toggleTarget, type SendTarget, type TargetReason } from "./send-targets.ts";
import { usePersonTargets } from "./target-health.ts";

/** The composer's toasts, one of which can be said differently (a send the user cancelled is not a failure). */
class ComposerToasts extends Toasts {
	private replacement: string | null = null;

	constructor(private readonly base: Toasts) {
		super();
	}

	/** The next toast the composer shows reads `text` instead. */
	replaceNext(text: string): void {
		this.replacement = text;
	}

	override show(text: string): void {
		const shown = this.replacement ?? text;
		this.replacement = null;
		this.base.show(shown);
	}
}

/** Moves what is typed (and files waiting to go) from one chat's composer to another's. */
function carry(drafts: Drafts, from: number, to: number): void {
	if (from === 0 || to === 0 || from === to) return;
	const text = drafts.get(from);
	if (text !== "") {
		drafts.set(to, text);
		drafts.set(from, "");
	}
	const files = attachments(from, 0);
	const waiting = files.get();
	if (waiting.length > 0) {
		addAttachments(to, 0, waiting);
		files.set([]);
	}
}

/** What the screen showed last, for the sends and handlers that run after it. */
interface Shown {
	readonly sending: readonly number[];
	readonly targets: readonly SendTarget[];
	readonly selected: readonly number[];
	readonly chosen: readonly number[] | null;
	readonly primary: number;
	readonly chatId: number;
}

/** The screen's state outside rendering: what it showed last, the chat a reply or edit bound the composer to, and an answered question. */
class SendSession {
	private shown: Shown;
	private bound: number | null = null;
	/** The user agreed to send to several apps on this visit. */
	confirmed = false;

	constructor(shown: Shown) {
		this.shown = shown;
	}

	now(): Shown {
		return this.shown;
	}

	update(shown: Shown): void {
		this.shown = shown;
	}

	/** Binds the composer to `chatId` for a reply or an edit; returns the chat it was bound to before (null: none). */
	bind(chatId: number): number | null {
		const previous = this.bound;
		this.bound = chatId;
		return previous;
	}

	/** Ends the binding to `chatId`; false when the composer has since been bound elsewhere. */
	leave(chatId: number): boolean {
		if (this.bound !== chatId) return false;
		this.bound = null;
		return true;
	}
}

/** The confirmation asked before the first send to several apps. */
export interface SendQuestion {
	readonly chatIds: readonly number[];
	answer(send: boolean, dontAskAgain: boolean): void;
}

export interface PersonSend {
	readonly targets: readonly SendTarget[];
	readonly selected: readonly number[];
	/** Two chats or more can send: the target row shows. */
	readonly row: boolean;
	/** The chats a message goes to now (one while replying or editing). */
	readonly sending: readonly number[];
	/** The chat the composer is bound to; 0 when the person has no chat. */
	readonly chatId: number;
	/** Replying to or editing a message of `chatId`. */
	readonly intent: ComposerIntent | null;
	toggle(chatId: number): void;
	/** Reply and edit of the timeline's messages, each in its own chat. */
	readonly actions: LimitedActions;
	/** The services the composer runs with: its sends fan out. */
	readonly services: Services;
	readonly status: SendStatus;
	readonly question: SendQuestion | null;
}

export function usePersonSend(person: LinkedPerson): PersonSend {
	const copy = useScreensCopy();
	const services = useServices();
	const ui = useUi();
	const { drafts } = services;
	const { targets, dates } = usePersonTargets(person.members);
	const prefs = useMemo(() => new PersonSendPrefs(services.store.selfId), [services.store.selfId]);
	// The remembered choice; null until the user chooses or first sends (the newest message's chat is preselected).
	const [chosen, setChosen] = useState<readonly number[] | null>(() => prefs.targets(person.id));
	const [override, setOverride] = useState<number | null>(null);
	const [question, setQuestion] = useState<SendQuestion | null>(null);
	const status = useMemo(() => new SendStatus(), []);

	const selected = initialSelection(targets, chosen, newestChat(targets, dates));
	const row = hasRow(targets);
	const effective = effectiveTargets(targets, selected);
	const primary = row ? primaryOf(targets, selected) : (effective[0] ?? 0);
	const chatId = override ?? primary;
	const intent = useIntent(chatId);
	const sending = intent !== null ? [chatId] : effective;

	// What the fan-out and the handlers read when they run (after the render that showed it).
	const [session] = useState(() => new SendSession({ sending, targets, selected, chosen, primary, chatId }));
	useLayoutEffect(() => {
		session.update({ sending, targets, selected, chosen, primary, chatId });
	});

	// The reply or edit ended (sent, saved or cancelled): back to the chat the composer came from.
	useEffect(() => {
		if (override === null) return;
		const cell = ui.intents.cell(override);
		return cell.subscribe(() => {
			if (cell.get() !== null || !session.leave(override)) return;
			carry(drafts, override, session.now().primary);
			setOverride(null);
		});
	}, [ui, drafts, override, session]);

	const actions = useMemo<LimitedActions>(() => {
		const bindTo = (target: number, next: ComposerIntent) => {
			const from = session.now().chatId;
			const previous = session.bind(target);
			carry(drafts, from, target);
			ui.intents.cell(target).set(next);
			// A reply begun in another chat before this one is dropped there.
			if (previous !== null && previous !== target) ui.intents.cell(previous).set(null);
			setOverride(target);
		};
		return {
			reply: (target, seq) => bindTo(target, { mode: "reply", seq }),
			edit: (target, seq) => bindTo(target, { mode: "edit", seq }),
		};
	}, [ui, drafts, session]);

	const toasts = useMemo(() => new ComposerToasts(services.toasts), [services.toasts]);
	const cancelled = copy.personScreen.sendCancelled;
	const fanned = useMemo<Services>(() => {
		const reasonOf = (target: number): TargetReason | null => session.now().targets.find((t) => t.chatId === target)?.reason ?? null;
		const plan = (): FanOutPlan => {
			const now = session.now();
			// The first send keeps the preselection as the person's choice.
			if (now.chosen === null && now.sending.length > 0) {
				prefs.setTargets(person.id, now.selected);
				setChosen(now.selected);
			}
			const blocked = new Map<number, TargetReason>();
			for (const target of now.sending) {
				const reason = reasonOf(target);
				if (reason !== null && blocks(reason)) blocked.set(target, reason);
			}
			return { targets: now.sending, blocked };
		};
		const confirm = (chatIds: readonly number[]): Promise<boolean> => {
			if (session.confirmed || prefs.confirmed()) return Promise.resolve(true);
			return new Promise((resolve) => {
				setQuestion({
					chatIds,
					answer: (send, dontAskAgain) => {
						setQuestion(null);
						if (send) {
							session.confirmed = true;
							if (dontAskAgain) prefs.setConfirmed();
						} else {
							toasts.replaceNext(cancelled);
						}
						resolve(send);
					},
				});
			});
		};
		const source = fanOutSource(services.source, {
			plan,
			confirm,
			report: (report) => {
				const reason = reasonOf(report.chatId);
				status.note(report, reason !== null && !blocks(reason) ? reason : undefined);
			},
		});
		return { ...services, source, toasts };
	}, [services, prefs, person.id, status, toasts, cancelled, session]);

	const toggle = (target: number) => {
		const next = toggleTarget(targets, selected, target);
		if (override === null) carry(drafts, primary, primaryOf(targets, next));
		prefs.setTargets(person.id, next);
		setChosen(next);
	};

	return { targets, selected, row, sending, chatId, intent, toggle, actions, services: fanned, status, question };
}
