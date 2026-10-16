// Sync engine (ADR 0002). Realtime is the fast path; GetDifference and
// GetChatDifference are the source of truth:
// - per-user updates apply in pts order; a gap waits 150 ms for the missing
//   update, then GetDifference fills it;
// - sync_mode=large chats keep their own chat_pts log the same way, and while
//   GetChatDifference of a chat runs its realtime updates are only held for
//   comparison, never applied;
// - after (re)connecting, realtime updates are buffered until GetDifference
//   finished, then merged by pts (duplicates drop out);
// - too_long and a new server_epoch reset the position, reload what the user
//   sees and mark the rest of the cache stale instead of deleting it;
// - an update that references a user or chat the client does not have waits
//   until that entity is fetched.
import type { Timers } from "@app/platform";
import { HistoryDirection } from "@app/proto-ts/messages";
import type {
	Chat,
	ChatDifference,
	ChatSyncState,
	Difference,
	DialogsPage,
	HistoryPage,
	Hello,
	Message,
	NotificationSettings,
	SessionRevokeReason,
	SyncAck,
	SyncState,
	Update,
	UpdateBatch,
	User,
} from "../model/types.ts";
import { purgeChat } from "../purge/index.ts";
import { classifyFailure, isChatRefusal, type RemoteApi } from "../protocol/api.ts";
import {
	toChat,
	toChatDifference,
	toDialogsPage,
	toDifference,
	toHistoryPage,
	toNotificationSettings,
	toPeerDialogs,
	toState,
	toUser,
	toWireId,
} from "../protocol/map.ts";
import type { Repository } from "../repo/repository.ts";
import {
	dropMissingInRange,
	dropStaleAbove,
	markAllStale,
	markChatStale,
	putChat,
	putChatPts,
	putDialog,
	putNotificationSettings,
	putPinnedOrder,
	putMessage,
	putNewMessage,
	putSyncState,
	putUser,
	raiseTop,
	retopDialog,
	setHistoryStart,
	WriteBatch,
} from "../repo/writes.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffPolicy } from "../transport/backoff.ts";
import { applyBody, newEffects, requiredEntities, type ApplyContext, type Effects } from "./apply.ts";
import { SerialQueue } from "./serial-queue.ts";

export type HistoryDirectionName = "older" | "newer" | "around";

export interface SyncEngineOptions {
	readonly repo: Repository;
	readonly api: RemoteApi;
	readonly timers: Timers;
	readonly selfId: number;
	readonly random?: () => number;
	/** Wait for a missing update before asking the server (ADR 0002: 150 ms). */
	readonly gapTimeoutMs?: number;
	readonly differenceLimit?: number;
	/** Messages loaded around the viewed position after too_long. */
	readonly historyWindow?: number;
	readonly backoff?: BackoffPolicy;
	readonly onSessionEnded: (reason: SessionRevokeReason) => void;
	/** Incoming messages that arrived in realtime (notification candidates). */
	readonly onIncoming?: (messages: readonly Message[]) => void;
	/** Chats read on another device. */
	readonly onReadElsewhere?: (chatIds: readonly number[]) => void;
	/** Non-fatal sync failures; the engine retries on its own. */
	readonly onError?: (error: unknown, context: string) => void;
}

const MAX_DIALOG_PAGES = 100;
const DIALOG_PAGE_SIZE = 100;
const MAX_TOO_LONG_IN_A_ROW = 3;
/** Chats per GetPeerDialogs when repairing the dialog list. */
const REPAIR_BATCH = 100;
/** Most users one GetUsers may ask for (server/internal/chat/users.go getUsersMax). */
const GET_USERS_MAX = 200;

/** Inclusive range of seqs a history response speaks for. */
function coveredRange(
	direction: HistoryDirectionName,
	offsetSeq: number,
	page: HistoryPage,
): { lo: number; hi: number; openTop: boolean } {
	const first = page.messages[0]?.seq;
	const last = page.messages[page.messages.length - 1]?.seq;
	switch (direction) {
		case "older": {
			const hi = offsetSeq === 0 ? (last ?? 0) : offsetSeq - 1;
			return { lo: page.hasOlder ? (first ?? hi + 1) : 0, hi, openTop: offsetSeq === 0 };
		}
		case "newer": {
			const lo = offsetSeq + 1;
			return { lo, hi: last ?? lo - 1, openTop: !page.hasNewer };
		}
		case "around": {
			if (first === undefined || last === undefined) return { lo: 1, hi: 0, openTop: false };
			return { lo: page.hasOlder ? first : 0, hi: last, openTop: !page.hasNewer };
		}
	}
}

const WIRE_DIRECTIONS: Record<HistoryDirectionName, HistoryDirection> = {
	older: HistoryDirection.OLDER,
	newer: HistoryDirection.NEWER,
	around: HistoryDirection.AROUND,
};

export class SyncEngine {
	private readonly queue = new SerialQueue();
	private readonly gapTimeoutMs: number;
	private readonly differenceLimit: number;
	private readonly historyWindow: number;
	private readonly backoff: BackoffPolicy;
	private readonly random: () => number;

	private pts = 0;
	private epoch = 0;
	private hasState = false;
	private sessionId = 0;
	/** Highest pts a SyncAck promised; below it the log has a gap. */
	private expectedPts = 0;
	private chatPts = new Map<number, number>();
	private readonly expectedChatPts = new Map<number, number>();
	private readonly dirtyChatPts = new Set<number>();

	/** Per-user updates waiting for a gap to close, keyed by pts - pts_count. */
	private readonly pending = new Map<number, Update>();
	/** Same per large chat, keyed by chat_pts - chat_pts_count. */
	private readonly chatPending = new Map<number, Map<number, Update>>();
	private gapTimer: unknown = null;
	private readonly chatGapTimers = new Map<number, unknown>();

	private differenceRunning = false;
	private differenceAgain = false;
	private differenceAttempt = 0;
	/** repairDialogs ran (or runs) in this start. */
	private repairStarted = false;
	private differenceRetry: unknown = null;
	private accountBuffer: UpdateBatch[] = [];

	private readonly chatDiffRunning = new Set<number>();
	private readonly chatDiffAgain = new Set<number>();
	private readonly chatHeld = new Map<number, Update[]>();
	private readonly chatAttempts = new Map<number, number>();
	private readonly chatRetries = new Map<number, unknown>();

	private openChat = { chatId: 0, anchorSeq: 0 };
	private stopped = false;

	constructor(private readonly options: SyncEngineOptions) {
		this.gapTimeoutMs = options.gapTimeoutMs ?? 150;
		this.differenceLimit = options.differenceLimit ?? 1000;
		this.historyWindow = options.historyWindow ?? 50;
		this.backoff = options.backoff ?? DEFAULT_BACKOFF;
		this.random = options.random ?? Math.random;
	}

	/** Restores the log positions saved by the last run. */
	async load(): Promise<void> {
		const state = await this.options.repo.syncState();
		this.hasState = state !== null;
		this.pts = state?.pts ?? 0;
		this.epoch = state?.serverEpoch ?? 0;
		this.expectedPts = this.pts;
		this.chatPts = await this.options.repo.allChatPts();
		this.expectedChatPts.clear();
		this.dirtyChatPts.clear();
	}

	get state(): SyncState & { readonly hasState: boolean } {
		return { pts: this.pts, serverEpoch: this.epoch, date: 0, hasState: this.hasState };
	}

	/** True while a difference, a local write or a gap wait is in progress. */
	get busy(): boolean {
		return (
			this.queue.busy ||
			this.differenceRunning ||
			this.chatDiffRunning.size > 0 ||
			this.gapTimer !== null ||
			this.chatGapTimers.size > 0 ||
			this.differenceRetry !== null ||
			this.chatRetries.size > 0
		);
	}

	stop(): void {
		this.stopped = true;
		this.clearGap();
		for (const chatId of [...this.chatGapTimers.keys()]) this.clearChatGap(chatId);
		if (this.differenceRetry !== null) this.options.timers.clearTimeout(this.differenceRetry);
		this.differenceRetry = null;
		for (const handle of this.chatRetries.values()) this.options.timers.clearTimeout(handle);
		this.chatRetries.clear();
		this.accountBuffer = [];
	}

	/** The chat on screen and the seq the user looks at (0 = the newest). */
	setOpenChat(chatId: number, anchorSeq = 0): void {
		this.openChat = { chatId, anchorSeq };
	}

	/** A socket was accepted: buffer realtime and catch up (ADR 0002 reconnect order). */
	onConnected(hello: Hello): void {
		this.sessionId = hello.sessionId;
		this.requestDifference();
	}

	/** Entry point for realtime update frames. */
	ingest(batch: UpdateBatch): void {
		if (this.stopped) return;
		if (this.differenceRunning) {
			this.accountBuffer.push(batch);
			return;
		}
		this.enqueueIngest(batch, true);
	}

	// ---------------------------------------------------------------- ingest

	private enqueueIngest(batch: UpdateBatch, realtime: boolean): void {
		this.queue
			.run(() => this.ingestNow(batch, realtime))
			.catch((err: unknown) => this.recoverFromFailedIngest(err, batch));
	}

	private async ingestNow(batch: UpdateBatch, realtime: boolean): Promise<void> {
		if (this.stopped) return;
		const w = new WriteBatch();
		const effects = newEffects();
		await this.fetchMissingEntities(batch, w);
		this.putEntities(batch, w, effects);
		const ctx = this.context(w, effects);
		const ptsBefore = this.pts;
		for (const update of batch.updates) this.route(update, ctx);
		if (this.pts !== ptsBefore) putSyncState(w, this.syncState());
		await this.commit(w);
		this.afterCommit(effects, realtime);
	}

	private async recoverFromFailedIngest(err: unknown, batch: UpdateBatch): Promise<void> {
		if (classifyFailure(err) === "unauthenticated") {
			this.options.onSessionEnded("unknown");
			return;
		}
		this.report(err, "apply updates");
		// The batch was not applied; the server logs still hold it.
		this.requestDifference();
		for (const update of batch.updates) {
			if (update.chatPts > 0) this.requestChatDifference(update.chatId);
		}
	}

	private route(update: Update, ctx: ApplyContext): void {
		if (update.serverEpoch !== 0 && this.hasState && update.serverEpoch !== this.epoch) {
			// Written under another epoch (failover or restore): resync instead.
			this.requestDifference();
			return;
		}
		if (update.pts > 0) this.routePts(update, ctx);
		else if (update.chatPts > 0) this.routeChatPts(update, ctx);
		else this.applyUpdate(update, ctx);
	}

	private routePts(update: Update, ctx: ApplyContext): void {
		if (update.pts <= this.pts) return; // already applied
		const base = update.pts - update.ptsCount;
		if (base === this.pts) {
			this.applyUpdate(update, ctx);
			this.pts = update.pts;
			this.drainPending(ctx);
		} else if (base > this.pts) {
			this.pending.set(base, update);
			this.armGap();
		} else {
			// Overlaps what was applied: the local view of the log is off.
			this.requestDifference();
		}
	}

	private drainPending(ctx: ApplyContext): void {
		for (const [base, update] of this.pending) {
			if (update.pts <= this.pts || base < this.pts) this.pending.delete(base);
		}
		let next = this.pending.get(this.pts);
		while (next !== undefined) {
			this.pending.delete(this.pts);
			this.applyUpdate(next, ctx);
			this.pts = next.pts;
			next = this.pending.get(this.pts);
		}
		if (this.pending.size === 0 && this.pts >= this.expectedPts) this.clearGap();
	}

	private routeChatPts(update: Update, ctx: ApplyContext): void {
		const chatId = update.chatId;
		if (this.chatDiffRunning.has(chatId) || !this.chatPts.has(chatId)) {
			// Either GetChatDifference will return this update, or the chat's
			// base position is not known yet (its chat_mode_changed may sit in
			// a per-user gap). Keep it for comparison only.
			this.hold(update);
			if (!this.chatPts.has(chatId) && !this.chatDiffRunning.has(chatId)) this.requestDifference();
			return;
		}
		const local = this.chatPts.get(chatId) ?? 0;
		if (update.chatPts <= local) return;
		const base = update.chatPts - update.chatPtsCount;
		if (base === local) {
			this.applyUpdate(update, ctx);
			this.setChatPts(chatId, update.chatPts);
			this.drainChatPending(chatId, ctx);
		} else if (base > local) {
			let map = this.chatPending.get(chatId);
			if (map === undefined) {
				map = new Map();
				this.chatPending.set(chatId, map);
			}
			map.set(base, update);
			this.armChatGap(chatId);
		} else {
			this.requestChatDifference(chatId);
		}
	}

	private drainChatPending(chatId: number, ctx: ApplyContext): void {
		const map = this.chatPending.get(chatId);
		let local = this.chatPts.get(chatId) ?? 0;
		if (map !== undefined) {
			for (const [base, update] of map) {
				if (update.chatPts <= local || base < local) map.delete(base);
			}
			let next = map.get(local);
			while (next !== undefined) {
				map.delete(local);
				this.applyUpdate(next, ctx);
				this.setChatPts(chatId, next.chatPts);
				local = next.chatPts;
				next = map.get(local);
			}
			if (map.size === 0) this.chatPending.delete(chatId);
		}
		if (!this.chatPending.has(chatId) && local >= (this.expectedChatPts.get(chatId) ?? 0)) {
			this.clearChatGap(chatId);
		}
	}

	private hold(update: Update): void {
		const list = this.chatHeld.get(update.chatId);
		if (list === undefined) this.chatHeld.set(update.chatId, [update]);
		else list.push(update);
	}

	private applyUpdate(update: Update, ctx: ApplyContext): void {
		applyBody(update.body, ctx);
		for (const [chatId, base] of ctx.effects.modeChanges) {
			const local = this.chatPts.get(chatId);
			if (local === undefined || base > local) {
				this.chatPts.set(chatId, base);
				this.dirtyChatPts.delete(chatId); // apply already wrote chat_sync_state
			}
		}
		ctx.effects.modeChanges.clear();
		for (const chatId of ctx.effects.purgedChats) this.forgetChat(chatId);
	}

	private forgetChat(chatId: number): void {
		this.chatPts.delete(chatId);
		this.expectedChatPts.delete(chatId);
		this.dirtyChatPts.delete(chatId);
		this.chatPending.delete(chatId);
		this.chatHeld.delete(chatId);
		this.clearChatGap(chatId);
	}

	private setChatPts(chatId: number, chatPts: number): void {
		this.chatPts.set(chatId, chatPts);
		this.dirtyChatPts.add(chatId);
	}

	private context(w: WriteBatch, effects: Effects): ApplyContext {
		return {
			w,
			effects,
			selfId: this.options.selfId,
			sessionId: this.sessionId,
			chatPts: (chatId) => this.chatPts.get(chatId),
		};
	}

	private syncState(): SyncState {
		return { pts: this.pts, serverEpoch: this.epoch, date: Math.floor(this.options.timers.now() / 1000) };
	}

	/** Commits a batch together with dirty chat positions; resyncs memory on failure. */
	private async commit(w: WriteBatch): Promise<void> {
		for (const chatId of this.dirtyChatPts) {
			const value = this.chatPts.get(chatId);
			if (value !== undefined) putChatPts(w, chatId, value);
		}
		this.dirtyChatPts.clear();
		try {
			await this.options.repo.commit(w);
		} catch (err) {
			// Memory moved ahead of the database; take the database's word.
			await this.load();
			this.pending.clear();
			this.chatPending.clear();
			throw err;
		}
	}

	private putEntities(batch: Pick<UpdateBatch, "users" | "chats">, w: WriteBatch, effects: Effects): void {
		for (const user of batch.users) putUser(w, user);
		for (const chat of batch.chats) {
			putChat(w, chat);
			if (chat.left) {
				purgeChat(w, chat.id);
				effects.purgedChats.add(chat.id);
				this.forgetChat(chat.id);
			}
		}
	}

	/** Fetches users and chats the updates need but nobody has sent yet. */
	private async fetchMissingEntities(batch: UpdateBatch, w: WriteBatch): Promise<void> {
		const userIds = new Set<number>();
		const chatIds = new Set<number>();
		for (const update of batch.updates) {
			const need = requiredEntities(update.body, this.options.selfId);
			for (const id of need.users) userIds.add(id);
			for (const id of need.chats) chatIds.add(id);
		}
		// A private chat is shown by its peer (getChat below brings its own).
		for (const chat of batch.chats) if (chat.peerUserId !== 0) userIds.add(chat.peerUserId);
		for (const user of batch.users) userIds.delete(user.id);
		for (const chat of batch.chats) chatIds.delete(chat.id);
		const missingUsers = await this.options.repo.missing("users", userIds);
		const missingChats = await this.options.repo.missing("chats", chatIds);
		for (const user of await this.getUsers(missingUsers)) putUser(w, user);
		for (const chatId of missingChats) {
			const response = await this.options.api.chats.getChat({ chatId: toWireId(chatId) });
			if (response.chat !== undefined) putChat(w, toChat(response.chat));
			for (const user of response.users) putUser(w, toUser(user));
		}
	}

	private afterCommit(effects: Effects, realtime: boolean): void {
		if (effects.sessionEnded !== null) {
			this.options.onSessionEnded(effects.sessionEnded);
			return;
		}
		if (realtime && effects.incoming.length > 0) this.options.onIncoming?.(effects.incoming);
		if (effects.readChats.size > 0) this.options.onReadElsewhere?.([...effects.readChats]);
		for (const chatId of effects.refreshChats) void this.refreshChat(chatId);
		for (const chatId of effects.chatDifferences) this.requestChatDifference(chatId);
	}

	/**
	 * Reloads a chat and its dialog (read state, top message) with
	 * GetPeerDialogs, e.g. after an unpin, for a large chat first seen in a
	 * difference, or for a chat this device never synced. Failures are
	 * reported, not thrown; a chat the server does not return stays absent.
	 */
	async refreshChat(chatId: number): Promise<void> {
		await this.refreshChats([chatId]);
	}

	/** refreshChat for several chats in one GetPeerDialogs. */
	private async refreshChats(chatIds: readonly number[]): Promise<void> {
		if (chatIds.length === 0) return;
		try {
			const getPeerDialogs = this.options.api.chats.getPeerDialogs;
			if (getPeerDialogs === undefined) {
				for (const chatId of chatIds) await this.refreshChatEntity(chatId);
				return;
			}
			const page = toPeerDialogs(await getPeerDialogs({ chatIds: chatIds.map(toWireId) }));
			await this.queue.run(async () => {
				const w = new WriteBatch();
				const effects = newEffects();
				this.putEntities(page, w, effects);
				const topDates = new Map<number, number>();
				for (const message of page.messages) {
					putMessage(w, message);
					topDates.set(message.chatId, message.date);
				}
				for (const dialog of page.dialogs) putDialog(w, dialog, topDates.get(dialog.chatId) ?? dialog.sortDate, this.options.selfId);
				await this.commit(w);
			});
		} catch (err) {
			if (classifyFailure(err) === "unauthenticated") this.options.onSessionEnded("unknown");
			else this.report(err, "refresh chat");
		}
	}

	/**
	 * After the server refused a call about the chat (permission_denied or
	 * not_found), asks for the chat itself: when the user is no longer a
	 * member, or the chat is gone, it is purged as member_removed would
	 * have done. A chat the user still belongs to is left untouched.
	 * Failures are reported, not thrown.
	 */
	async confirmMembership(chatId: number): Promise<void> {
		let left: Chat | null = null;
		let users: User[] = [];
		try {
			const response = await this.options.api.chats.getChat({ chatId: toWireId(chatId) });
			if (response.chat === undefined) return;
			const chat = toChat(response.chat);
			if (!chat.left || (await this.options.repo.chat(chatId))?.left === true) return;
			left = chat;
			users = response.users.map(toUser);
		} catch (err) {
			if (classifyFailure(err) === "unauthenticated") {
				this.options.onSessionEnded("unknown");
				return;
			}
			if (!isChatRefusal(err)) {
				this.report(err, "confirm membership");
				return;
			}
			// Nothing of it here (a link to a chat that does not exist), or
			// purged already: writing would only wake the views to ask again.
			const local = await this.options.repo.chat(chatId);
			if (local === null || local.left) return;
		}
		if (this.stopped) return;
		try {
			await this.queue.run(async () => {
				const w = new WriteBatch();
				if (left !== null) {
					this.putEntities({ users, chats: [left] }, w, newEffects());
				} else {
					purgeChat(w, chatId);
					this.forgetChat(chatId);
				}
				await this.commit(w);
			});
		} catch (err) {
			this.report(err, "confirm membership");
		}
	}

	/** refreshChat for an API without GetPeerDialogs: the chat entity only. */
	private async refreshChatEntity(chatId: number): Promise<void> {
		const response = await this.options.api.chats.getChat({ chatId: toWireId(chatId) });
		const chat = response.chat;
		if (chat === undefined) return;
		await this.queue.run(async () => {
			const w = new WriteBatch();
			this.putEntities({ users: response.users.map(toUser), chats: [toChat(chat)] }, w, newEffects());
			await this.commit(w);
		});
	}

	/**
	 * Once per start, after the first catch-up: reloads from the server the
	 * dialogs this device cannot show, i.e. with no chat stored, or a
	 * private chat whose other person is unknown, missing or wrong (a chat
	 * an older build stored from an update without its peer). Overwrites
	 * the stored chat, its dialog and its users.
	 */
	private async repairDialogs(): Promise<void> {
		try {
			const chatIds = await this.options.repo.dialogsToRepair(this.options.selfId);
			for (let i = 0; i < chatIds.length; i += REPAIR_BATCH) await this.refreshChats(chatIds.slice(i, i + REPAIR_BATCH));
		} catch (err) {
			this.report(err, "repair dialogs");
		}
	}

	/**
	 * Fetches users this device has never stored, e.g. the peer of a chat
	 * that arrived without it. Failures are reported, not thrown; a user the
	 * server does not return stays unknown.
	 */
	async fetchUsers(userIds: readonly number[]): Promise<void> {
		if (userIds.length === 0) return;
		try {
			const users = await this.getUsers(userIds);
			if (users.length === 0) return;
			await this.queue.run(async () => {
				const w = new WriteBatch();
				for (const user of users) putUser(w, user);
				await this.commit(w);
			});
		} catch (err) {
			if (classifyFailure(err) === "unauthenticated") this.options.onSessionEnded("unknown");
			else this.report(err, "fetch users");
		}
	}

	/** GetUsers in requests the server accepts; the users it returned, in order. */
	private async getUsers(userIds: readonly number[]): Promise<User[]> {
		const users: User[] = [];
		for (let i = 0; i < userIds.length; i += GET_USERS_MAX) {
			const response = await this.options.api.users.getUsers({ userIds: userIds.slice(i, i + GET_USERS_MAX).map(toWireId) });
			for (const user of response.users) users.push(toUser(user));
		}
		return users;
	}

	// ------------------------------------------------------------ gap timers

	private armGap(): void {
		if (this.gapTimer !== null || this.stopped) return;
		this.gapTimer = this.options.timers.setTimeout(() => {
			this.gapTimer = null;
			if (this.pending.size > 0 || this.pts < this.expectedPts) this.requestDifference();
		}, this.gapTimeoutMs);
	}

	private clearGap(): void {
		if (this.gapTimer !== null) this.options.timers.clearTimeout(this.gapTimer);
		this.gapTimer = null;
	}

	private armChatGap(chatId: number): void {
		if (this.chatGapTimers.has(chatId) || this.stopped) return;
		const handle = this.options.timers.setTimeout(() => {
			this.chatGapTimers.delete(chatId);
			const local = this.chatPts.get(chatId) ?? 0;
			if ((this.chatPending.get(chatId)?.size ?? 0) > 0 || local < (this.expectedChatPts.get(chatId) ?? 0)) {
				this.requestChatDifference(chatId);
			}
		}, this.gapTimeoutMs);
		this.chatGapTimers.set(chatId, handle);
	}

	private clearChatGap(chatId: number): void {
		const handle = this.chatGapTimers.get(chatId);
		if (handle !== undefined) this.options.timers.clearTimeout(handle);
		this.chatGapTimers.delete(chatId);
	}

	// ------------------------------------------------------ user difference

	/** Starts GetDifference, or runs it once more if one is in flight. */
	requestDifference(): void {
		if (this.stopped) return;
		if (this.differenceRunning) {
			this.differenceAgain = true;
			return;
		}
		if (this.differenceRetry !== null) {
			this.options.timers.clearTimeout(this.differenceRetry);
			this.differenceRetry = null;
		}
		this.clearGap();
		this.differenceRunning = true;
		void this.runDifference();
	}

	private async runDifference(): Promise<void> {
		try {
			do {
				this.differenceAgain = false;
				if (!this.hasState) {
					const response = await this.options.api.updates.getState({});
					await this.resetFromServer(toState(response.state));
				}
				let done = false;
				let tooLongInARow = 0;
				while (!done && !this.stopped) {
					const response = await this.options.api.updates.getDifference({
						pts: toWireId(this.pts),
						serverEpoch: toWireId(this.epoch),
						limit: this.differenceLimit,
					});
					const difference = toDifference(response);
					if (difference.result.kind === "too_long") {
						if (++tooLongInARow > MAX_TOO_LONG_IN_A_ROW) {
							throw new Error("GetDifference keeps answering too_long");
						}
						await this.resetFromServer(difference.state);
						continue;
					}
					tooLongInARow = 0;
					done = await this.queue.run(() => this.applyDifference(difference));
				}
			} while (this.differenceAgain && !this.stopped);
			this.differenceAttempt = 0;
			if (!this.repairStarted && !this.stopped) {
				this.repairStarted = true;
				void this.repairDialogs();
			}
		} catch (err) {
			this.differenceFailed(err);
		} finally {
			this.differenceRunning = false;
			this.releaseAccountBuffer();
		}
	}

	private differenceFailed(err: unknown): void {
		if (classifyFailure(err) === "unauthenticated") {
			this.options.onSessionEnded("unknown");
			return;
		}
		this.report(err, "GetDifference");
		if (this.stopped) return;
		const delay = backoffDelay(this.differenceAttempt++, this.backoff, this.random);
		this.differenceRetry = this.options.timers.setTimeout(() => {
			this.differenceRetry = null;
			this.requestDifference();
		}, delay);
	}

	private releaseAccountBuffer(): void {
		const buffered = this.accountBuffer;
		this.accountBuffer = [];
		for (const batch of buffered) this.enqueueIngest(batch, true);
		// Large chats whose base is still unknown after catching up start
		// from the oldest update seen for them.
		for (const chatId of [...this.chatHeld.keys()]) {
			if (!this.chatDiffRunning.has(chatId)) this.releaseHeld(chatId);
		}
	}

	private async applyDifference(difference: Difference): Promise<boolean> {
		const { state, result } = difference;
		const w = new WriteBatch();
		const effects = newEffects();
		if (result.kind === "empty" || result.kind === "too_long") {
			this.pts = Math.max(this.pts, state.pts);
			this.epoch = state.serverEpoch;
			this.expectedPts = Math.min(this.expectedPts, this.pts);
			this.drainPending(this.context(w, effects));
			putSyncState(w, this.syncState());
			await this.commit(w);
			return true;
		}
		await this.fetchMissingEntities(result.batch, w);
		this.putEntities(result.batch, w, effects);
		const ctx = this.context(w, effects);
		const updates = [...result.batch.updates].sort((a, b) => a.pts - b.pts);
		for (const update of updates) {
			if (update.pts > 0) {
				// The difference is the log itself: apply in order, no gap check.
				if (update.pts <= this.pts) continue;
				this.applyUpdate(update, ctx);
				this.pts = update.pts;
			} else {
				this.route(update, ctx);
			}
		}
		this.pts = Math.max(this.pts, state.pts);
		this.epoch = state.serverEpoch;
		if (this.expectedPts > this.pts && result.kind === "full") this.expectedPts = this.pts;
		this.drainPending(ctx);
		for (const large of result.largeChats) {
			const local = this.chatPts.get(large.chatId);
			if (local === undefined) {
				// A large chat this client has no position for: start at the
				// server's position; its history loads with GetHistory on open.
				this.setChatPts(large.chatId, large.chatPts);
				effects.refreshChats.add(large.chatId);
			} else if (large.chatPts > local) {
				effects.chatDifferences.add(large.chatId);
			}
		}
		putSyncState(w, this.syncState());
		await this.commit(w);
		this.afterCommit(effects, false);
		return result.kind === "full";
	}

	/**
	 * Account-level too_long, epoch change or first start: take the server's
	 * position, replace the dialog list with a fresh snapshot, mark every
	 * cached message stale and reload what the user is looking at.
	 */
	private async resetFromServer(state: SyncState): Promise<void> {
		const snapshot = await this.fetchDialogs();
		const settings = await this.fetchNotificationSettings();
		await this.queue.run(async () => {
			const w = new WriteBatch();
			const effects = newEffects();
			markAllStale(w);
			if (settings !== null) putNotificationSettings(w, settings);
			if (snapshot.complete) {
				const present = new Set(snapshot.dialogs.map((d) => d.chatId));
				for (const chatId of await this.options.repo.dialogChatIds()) {
					if (!present.has(chatId)) {
						purgeChat(w, chatId);
						effects.purgedChats.add(chatId);
					}
				}
			}
			this.putEntities(snapshot, w, effects);
			const topDates = new Map<number, number>();
			for (const message of snapshot.messages) {
				putMessage(w, message);
				topDates.set(message.chatId, message.date);
			}
			const chatPts = new Map<number, number>();
			const large = new Set(snapshot.chats.filter((c) => c.syncMode === "large").map((c) => c.id));
			for (const dialog of snapshot.dialogs) {
				if (effects.purgedChats.has(dialog.chatId)) continue;
				putDialog(w, dialog, topDates.get(dialog.chatId) ?? dialog.sortDate, this.options.selfId);
				// chat_pts 0 is a valid position of a chat that just became large.
				if (large.has(dialog.chatId) || dialog.chatPts > 0) {
					chatPts.set(dialog.chatId, dialog.chatPts);
					putChatPts(w, dialog.chatId, dialog.chatPts);
				}
			}
			// The first page carries the pinned chats in order (a client whose
			// server predates pins gets none and keeps every dialog unpinned).
			putPinnedOrder(
				w,
				snapshot.pinnedChatIds.filter((chatId) => !effects.purgedChats.has(chatId)),
			);
			w.add("DELETE FROM chat_sync_state WHERE chat_id NOT IN (SELECT chat_id FROM dialogs)");
			this.pts = state.pts;
			this.epoch = state.serverEpoch;
			this.expectedPts = state.pts;
			this.hasState = true;
			this.pending.clear();
			this.chatPending.clear();
			this.expectedChatPts.clear();
			this.clearGap();
			for (const chatId of [...this.chatGapTimers.keys()]) this.clearChatGap(chatId);
			this.chatPts = chatPts;
			this.dirtyChatPts.clear();
			putSyncState(w, this.syncState());
			await this.commit(w);
			for (const chatId of effects.purgedChats) this.forgetChat(chatId);
		});
		if (this.openChat.chatId !== 0) await this.reloadWindowSafely(this.openChat.chatId);
	}

	/**
	 * The user's notification settings, part of a fresh snapshot. Null when
	 * the API lacks them or the call failed (reported); the stored settings
	 * then stay until the next change or snapshot.
	 */
	async fetchNotificationSettings(): Promise<NotificationSettings | null> {
		const get = this.options.api.chats.getNotificationSettings;
		if (get === undefined) return null;
		try {
			const response = await get({});
			return response.settings === undefined ? null : toNotificationSettings(response.settings);
		} catch (err) {
			if (classifyFailure(err) === "unauthenticated") throw err;
			this.report(err, "GetNotificationSettings");
			return null;
		}
	}

	private async fetchDialogs(): Promise<DialogsPage & { complete: boolean }> {
		const all = { dialogs: [], messages: [], chats: [], users: [] } as {
			dialogs: DialogsPage["dialogs"][number][];
			messages: DialogsPage["messages"][number][];
			chats: DialogsPage["chats"][number][];
			users: DialogsPage["users"][number][];
		};
		let cursor = "";
		let pinnedChatIds: readonly number[] = [];
		for (let page = 0; page < MAX_DIALOG_PAGES; page++) {
			const response = toDialogsPage(await this.options.api.chats.getDialogs({ cursor, limit: DIALOG_PAGE_SIZE }));
			if (page === 0) pinnedChatIds = response.pinnedChatIds;
			all.dialogs.push(...response.dialogs);
			all.messages.push(...response.messages);
			all.chats.push(...response.chats);
			all.users.push(...response.users);
			if (response.nextCursor === "") return { ...all, nextCursor: "", pinnedChatIds, complete: true };
			cursor = response.nextCursor;
		}
		return { ...all, nextCursor: cursor, pinnedChatIds, complete: false };
	}

	// ------------------------------------------------------ chat difference

	requestChatDifference(chatId: number): void {
		if (this.stopped) return;
		if (this.chatDiffRunning.has(chatId)) {
			this.chatDiffAgain.add(chatId);
			return;
		}
		const retry = this.chatRetries.get(chatId);
		if (retry !== undefined) this.options.timers.clearTimeout(retry);
		this.chatRetries.delete(chatId);
		this.clearChatGap(chatId);
		this.chatDiffRunning.add(chatId);
		void this.runChatDifference(chatId);
	}

	private async runChatDifference(chatId: number): Promise<void> {
		try {
			do {
				this.chatDiffAgain.delete(chatId);
				let done = false;
				let tooLongInARow = 0;
				while (!done && !this.stopped) {
					const response = await this.options.api.updates.getChatDifference({
						chatId: toWireId(chatId),
						chatPts: toWireId(this.chatPts.get(chatId) ?? 0),
						serverEpoch: toWireId(this.epoch),
						limit: this.differenceLimit,
					});
					const difference = toChatDifference(response);
					if (difference.result.kind === "too_long") {
						if (++tooLongInARow > MAX_TOO_LONG_IN_A_ROW) {
							throw new Error("GetChatDifference keeps answering too_long");
						}
						await this.chatTooLong(chatId, difference.state);
						continue;
					}
					tooLongInARow = 0;
					done = await this.queue.run(() => this.applyChatDifference(chatId, difference));
				}
			} while (this.chatDiffAgain.has(chatId) && !this.stopped);
			this.chatAttempts.delete(chatId);
		} catch (err) {
			this.chatDifferenceFailed(chatId, err);
		} finally {
			this.chatDiffRunning.delete(chatId);
			this.releaseHeld(chatId);
		}
	}

	private chatDifferenceFailed(chatId: number, err: unknown): void {
		const kind = classifyFailure(err);
		if (kind === "unauthenticated") {
			this.options.onSessionEnded("unknown");
			return;
		}
		this.report(err, `GetChatDifference ${chatId}`);
		// A refused chat (no longer a member) is normally purged by
		// member_removed; retrying would only repeat the refusal. When that
		// update was missed, the membership check purges it.
		if (kind === "permanent" || this.stopped) {
			if (kind === "permanent" && isChatRefusal(err)) void this.confirmMembership(chatId);
			return;
		}
		const attempt = this.chatAttempts.get(chatId) ?? 0;
		this.chatAttempts.set(chatId, attempt + 1);
		const handle = this.options.timers.setTimeout(() => {
			this.chatRetries.delete(chatId);
			this.requestChatDifference(chatId);
		}, backoffDelay(attempt, this.backoff, this.random));
		this.chatRetries.set(chatId, handle);
	}

	private async applyChatDifference(chatId: number, difference: ChatDifference): Promise<boolean> {
		const { state, result } = difference;
		const w = new WriteBatch();
		const effects = newEffects();
		const ctx = this.context(w, effects);
		if (result.kind === "slice" || result.kind === "full") {
			await this.fetchMissingEntities(result.batch, w);
			this.putEntities(result.batch, w, effects);
			const updates = [...result.batch.updates].sort((a, b) => a.chatPts - b.chatPts);
			for (const update of updates) {
				if (update.chatPts > 0 && update.chatId === chatId) {
					if (update.chatPts <= (this.chatPts.get(chatId) ?? 0)) continue;
					this.applyUpdate(update, ctx);
					this.setChatPts(chatId, update.chatPts);
				} else {
					this.route(update, ctx);
				}
			}
		}
		if (!effects.purgedChats.has(chatId)) {
			this.setChatPts(chatId, Math.max(this.chatPts.get(chatId) ?? 0, state.chatPts));
			const expected = this.expectedChatPts.get(chatId) ?? 0;
			if (result.kind !== "slice" && expected > state.chatPts) this.expectedChatPts.set(chatId, state.chatPts);
			this.drainChatPending(chatId, ctx);
		}
		await this.commit(w);
		this.afterCommit(effects, false);
		return result.kind !== "slice";
	}

	/** Per-chat too_long: reload the visible window, mark the rest stale. */
	private async chatTooLong(chatId: number, state: ChatSyncState): Promise<void> {
		await this.queue.run(async () => {
			const w = new WriteBatch();
			markChatStale(w, chatId);
			this.chatPending.delete(chatId);
			this.expectedChatPts.delete(chatId);
			this.setChatPts(chatId, state.chatPts);
			await this.commit(w);
		});
		await this.reloadWindowSafely(chatId);
	}

	/** Re-routes realtime updates held while the chat's difference ran. */
	private releaseHeld(chatId: number): void {
		const held = this.chatHeld.get(chatId);
		if (held === undefined) return;
		this.chatHeld.delete(chatId);
		this.queue
			.run(async () => {
				const w = new WriteBatch();
				const effects = newEffects();
				const ctx = this.context(w, effects);
				const sorted = [...held].sort((a, b) => a.chatPts - b.chatPts);
				const first = sorted[0];
				if (!this.chatPts.has(chatId) && first !== undefined) {
					this.setChatPts(chatId, first.chatPts - first.chatPtsCount);
				}
				for (const update of sorted) this.routeChatPts(update, ctx);
				await this.commit(w);
				this.afterCommit(effects, true);
			})
			.catch((err: unknown) => {
				this.report(err, `release held updates ${chatId}`);
				this.requestChatDifference(chatId);
			});
	}

	// ------------------------------------------------------- local mutations

	/**
	 * Commits the local effect of a confirmed mutation together with its
	 * SyncAck. When the ack is the next step of a log, the position advances
	 * without waiting for the realtime echo; otherwise the echo or a
	 * difference brings the missing updates (the writes are idempotent).
	 */
	async commitMutation(chatId: number, build: (w: WriteBatch) => void, ack: SyncAck | null): Promise<void> {
		await this.queue.run(async () => {
			const w = new WriteBatch();
			const effects = newEffects();
			build(w);
			if (ack !== null) this.advanceByAck(ack, chatId, this.context(w, effects));
			await this.commit(w);
			this.afterCommit(effects, false);
		});
	}

	private advanceByAck(ack: SyncAck, chatId: number, ctx: ApplyContext): void {
		if (ack.serverEpoch !== 0 && this.hasState && ack.serverEpoch !== this.epoch) {
			this.requestDifference();
			return;
		}
		if (ack.pts > 0 && ack.pts > this.pts) {
			if (ack.pts - ack.ptsCount === this.pts) {
				this.pts = ack.pts;
				this.drainPending(ctx);
				putSyncState(ctx.w, this.syncState());
			} else {
				this.expectedPts = Math.max(this.expectedPts, ack.pts);
				this.armGap();
			}
		}
		const local = this.chatPts.get(chatId);
		if (ack.chatPts > 0 && local !== undefined && ack.chatPts > local) {
			if (ack.chatPts - ack.chatPtsCount === local) {
				this.setChatPts(chatId, ack.chatPts);
				this.drainChatPending(chatId, ctx);
			} else {
				this.expectedChatPts.set(chatId, Math.max(this.expectedChatPts.get(chatId) ?? 0, ack.chatPts));
				this.armChatGap(chatId);
			}
		}
	}

	/**
	 * Records the log positions a confirmed mutation reached without
	 * applying anything: its own update then arrives (realtime or, after the
	 * gap timeout, GetDifference) and applies like any other.
	 */
	expectAck(ack: SyncAck | null, chatId: number): void {
		if (ack === null || this.stopped) return;
		if (ack.serverEpoch !== 0 && this.hasState && ack.serverEpoch !== this.epoch) {
			this.requestDifference();
			return;
		}
		if (ack.pts > this.pts) {
			this.expectedPts = Math.max(this.expectedPts, ack.pts);
			this.armGap();
		}
		const local = this.chatPts.get(chatId);
		if (ack.chatPts > 0 && local !== undefined && ack.chatPts > local) {
			this.expectedChatPts.set(chatId, Math.max(this.expectedChatPts.get(chatId) ?? 0, ack.chatPts));
			this.armChatGap(chatId);
		}
	}

	/** Runs a local-only write (optimistic state) in order with sync writes. */
	async commitLocal(build: (w: WriteBatch) => void | Promise<void>): Promise<void> {
		await this.queue.run(async () => {
			const w = new WriteBatch();
			await build(w);
			await this.commit(w);
		});
	}

	// ---------------------------------------------------------------- history

	/** Loads a history page from the server into the cache. */
	async fetchHistory(
		chatId: number,
		direction: HistoryDirectionName,
		offsetSeq: number,
		limit: number,
	): Promise<HistoryPage> {
		const response = await this.options.api.messages.getHistory({
			chatId: toWireId(chatId),
			offsetSeq: toWireId(offsetSeq),
			direction: WIRE_DIRECTIONS[direction],
			limit,
		});
		const page = toHistoryPage(response);
		// A chat this device has no dialog for yet (opened by a link before
		// the dialog list synced): its read position comes from the server
		// first, so the page is not counted as unread from its first message.
		if (page.messages.length > 0 && (await this.options.repo.dialog(chatId)) === null) await this.refreshChats([chatId]);
		await this.queue.run(async () => {
			const w = new WriteBatch();
			for (const user of page.users) putUser(w, user);
			for (const message of page.messages) putNewMessage(w, message, this.options.selfId);
			const { lo, hi, openTop } = coveredRange(direction, offsetSeq, page);
			if (hi >= lo) {
				dropMissingInRange(
					w,
					chatId,
					lo,
					hi,
					page.messages.map((m) => m.seq),
				);
			}
			if (openTop) {
				dropStaleAbove(w, chatId, hi);
				const newest = page.messages[page.messages.length - 1];
				if (newest !== undefined) raiseTop(w, newest);
				retopDialog(w, chatId);
			}
			if (!page.hasOlder && (direction !== "newer" || page.messages.length > 0)) setHistoryStart(w, chatId);
			await this.commit(w);
		});
		return page;
	}

	private async reloadWindowSafely(chatId: number): Promise<void> {
		const anchor = this.openChat.chatId === chatId ? this.openChat.anchorSeq : 0;
		try {
			await this.fetchHistory(chatId, anchor === 0 ? "older" : "around", anchor, this.historyWindow);
		} catch (err) {
			// The stale marks stay; the next history load retries.
			if (classifyFailure(err) === "unauthenticated") this.options.onSessionEnded("unknown");
			else this.report(err, `reload history ${chatId}`);
		}
	}

	private report(err: unknown, context: string): void {
		this.options.onError?.(err, context);
	}
}
