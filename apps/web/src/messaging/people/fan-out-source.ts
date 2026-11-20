// The data source the merged screen's composer sends through (ADR 0025): a
// text, a file, a voice message or an album written there goes to every
// target chat, one message in each, each through that chat's own outbox
// (its own pending bubble, upload and retry). A chat that takes nothing is
// not tried and says why; a chat whose send fails says so with a retry; the
// other chats send all the same. Only when nothing at all could be queued
// does the send fail, so the composer keeps what was written. Editing, typing
// and everything else go to the composer's own chat unchanged.
import type { AlbumItemInput, PendingMessage } from "@achoo254/chat-core";
import type { ChatSource } from "../data/source.ts";
import type { TargetReason } from "./send-targets.ts";

export interface FanOutPlan {
	/** The chats a new message goes to now. */
	readonly targets: readonly number[];
	/** Chats that take nothing, with why: reported, never tried. */
	readonly blocked: ReadonlyMap<number, TargetReason>;
}

/** What became of a send to one chat. */
export type SendReport =
	| { readonly kind: "sent"; readonly chatId: number }
	| { readonly kind: "skipped"; readonly chatId: number; readonly reason: TargetReason }
	| { readonly kind: "failed"; readonly chatId: number; readonly retry: () => Promise<void> };

export interface FanOutHooks {
	plan(): FanOutPlan;
	/** Asked before a message goes to two chats or more; false sends nothing. */
	confirm(chatIds: readonly number[]): Promise<boolean>;
	report(report: SendReport): void;
}

/** The user chose not to send to several apps after all. */
export class SendCancelled extends Error {
	constructor() {
		super("send cancelled");
		this.name = "SendCancelled";
	}
}

/** No target chat could take the message. */
export class NothingSent extends Error {
	constructor() {
		super("no target chat takes messages");
		this.name = "NothingSent";
	}
}

/** One send to one chat; `own` is the composer's chat, whose request is passed on as given. */
type SendTo<T> = (chatId: number, own: boolean) => Promise<T>;

/**
 * Album items for another chat: the same files and captions with no
 * random_id, so that chat's outbox picks its own (a random_id names the
 * pending message and its upload).
 */
function freshItems(items: readonly AlbumItemInput[]): AlbumItemInput[] {
	return items.map(({ randomId: _randomId, ...item }) => item);
}

export function fanOutSource(base: ChatSource, hooks: FanOutHooks): ChatSource {
	/** Sends to one chat and reports the outcome; a failure carries a retry that does the same again. */
	const attempt = async <T>(chatId: number, own: boolean, send: SendTo<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
		try {
			const value = await send(chatId, own);
			hooks.report({ kind: "sent", chatId });
			return { ok: true, value };
		} catch (error) {
			hooks.report({
				kind: "failed",
				chatId,
				retry: () => attempt(chatId, false, send).then(() => undefined),
			});
			return { ok: false, error };
		}
	};

	/** Sends to every target of the composer's chat `chatId`; the value of that chat's send, else of the first that went. */
	const fan = async <T>(chatId: number, send: SendTo<T>): Promise<T | null> => {
		const plan = hooks.plan();
		const targets = plan.targets.includes(chatId) ? plan.targets : [chatId];
		if (targets.length > 1 && !(await hooks.confirm(targets))) throw new SendCancelled();
		const tried: number[] = [];
		for (const target of targets) {
			const reason = plan.blocked.get(target);
			if (reason === undefined) tried.push(target);
			else hooks.report({ kind: "skipped", chatId: target, reason });
		}
		const outcomes = await Promise.all(tried.map((target) => attempt(target, target === chatId, send)));
		const values: T[] = [];
		let own: T | null = null;
		let failure: unknown = null;
		for (const [index, outcome] of outcomes.entries()) {
			if (!outcome.ok) {
				failure ??= outcome.error;
				continue;
			}
			values.push(outcome.value);
			if (tried[index] === chatId) own = outcome.value;
		}
		if (values.length === 0) throw failure ?? new NothingSent();
		return own ?? values[0] ?? null;
	};

	return {
		...base,
		sendText: (chatId, text, options) =>
			fan(chatId, (target, own) => {
				if (own || options === undefined) return base.sendText(target, text, options);
				const { randomId: _randomId, ...rest } = options;
				return base.sendText(target, text, rest);
			}),
		sendMedia: (chatId, file, media, options) =>
			fan(chatId, (target, own) => {
				if (own || options === undefined) return base.sendMedia(target, file, media, options);
				const { randomId: _randomId, ...rest } = options;
				return base.sendMedia(target, file, media, rest);
			}),
		sendAlbum: async (chatId, items, options): Promise<PendingMessage[]> =>
			(await fan(chatId, (target, own) => base.sendAlbum(target, own ? items : freshItems(items), options))) ?? [],
	};
}
