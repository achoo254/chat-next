// UI state of the messaging screens, kept outside React (phase 6): the dialog
// list, the open chat's message window, users and the connection state.
// Components subscribe to narrow keys with useSyncExternalStore, so a new
// message re-renders its own item and its dialog row, not the whole screen.
import {
	DEFAULT_NOTIFICATION_SETTINGS,
	EventKeys,
	isMuted,
	MUTE_FOREVER,
	type Chat,
	type ConnectionState,
	type DialogView,
	type FailureKind,
	type HistoryRequest,
	type MediaLimits,
	type NotificationSettings,
	type PendingMessage,
	type ScreenSnapshot,
	type StoredMessage,
	type User,
} from "@app/core";
import { chatKind, FOLDERS, inFolder, isSavedChat, type ChatKind, type Folder } from "./format.ts";
import type { ChatSource } from "./source.ts";

export type WindowItem =
	| { readonly kind: "message"; readonly message: StoredMessage }
	| { readonly kind: "pending"; readonly pending: PendingMessage };

export interface ChatWindow {
	readonly chatId: number;
	/** Render keys, oldest first. */
	readonly keys: readonly string[];
	readonly status: "loading" | "ready";
	readonly failure: FailureKind | null;
	readonly hasOlder: boolean;
	readonly hasNewer: boolean;
	/** The window ends at the newest message, so new ones append. */
	readonly live: boolean;
	readonly loadingOlder: boolean;
	/** First unread incoming seq when the chat was opened; 0 when none. */
	readonly unreadFromSeq: number;
	/** Message to scroll to (jump from search or the pinned bar); 0 when none. */
	readonly focusSeq: number;
	/** Bumps on every jump so the list scrolls even to the same seq. */
	readonly focusToken: number;
	/** Messages of this chat still in the outbox (the offline banner counts them). */
	readonly pendingCount: number;
}

export type ListStatus = "loading" | "ready";

/** What the chat list needs of a dialog to filter, count and size its row. */
export interface ListEntry {
	readonly chatId: number;
	readonly kind: ChatKind;
	/** The user's chat with themselves ("Cloud của tôi"). */
	readonly saved: boolean;
	readonly forum: boolean;
	/** Unread messages or mentions, or marked as unread ("Đánh dấu chưa đọc", synced). */
	readonly unread: boolean;
	readonly muted: boolean;
	readonly pinned: boolean;
}

export interface UnreadTotals {
	readonly messages: number;
	readonly chats: number;
}

/** Earlier builds kept "marked as unread" in this browser only; the mark is synced now. */
function dropLegacyUnreadMarks(selfId: number): void {
	try {
		window.localStorage.removeItem(`chat:unread-marks:${selfId}`);
	} catch {
		// Storage off: nothing was kept.
	}
}

const MAX_WINDOW = 120;
const PAGE = 40;
const FIRST_PAGE = 60;
const DIALOG_LIMIT = 1000;
const KEPT_WINDOWS = 6;

type Listener = () => void;

/** Render key that survives the pending → confirmed transition (same random_id). */
export function messageKey(message: StoredMessage): string {
	return message.randomId !== 0 ? `r${message.randomId}` : `s${message.seq}`;
}

export function pendingKey(pending: PendingMessage): string {
	return `r${pending.randomId}`;
}

function messageSignature(message: StoredMessage): string {
	const reactions = message.reactions.map((r) => `${r.emoji}:${r.count}:${r.chosen ? 1 : 0}:${r.recentUserIds.join("/")}`).join(",");
	// The server fills in media (poster, waveform) and link preview photos with edits that keep edit_version.
	const media = message.media === undefined ? "" : `${message.media.fileId}:${message.media.sizes.length}:${message.media.waveform.length}:${message.media.inlineThumb.length}`;
	const preview = message.linkPreview === null ? "" : `${message.linkPreview.title}:${message.linkPreview.photo?.fileId ?? ""}`;
	const keyboard = message.keyboard?.kind === "keyboard" && message.keyboard.hidden ? 1 : 0;
	return `${message.seq}|${message.editVersion}|${message.stale ? 1 : 0}|${message.recalled ? 1 : 0}|${keyboard}|${reactions}|${media}|${preview}|${message.text}`;
}

function itemSignature(item: WindowItem): string {
	return item.kind === "message"
		? `m${messageSignature(item.message)}`
		: `p${item.pending.outboxId}|${item.pending.failure ?? ""}|${item.pending.albumId ?? 0}|${item.pending.text}`;
}

function sameKeys<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Runs `task` at most once at a time; calls made meanwhile collapse into one rerun. */
class Coalescer {
	private running = false;
	private again = false;

	constructor(private readonly task: () => Promise<void>) {}

	run(): void {
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		void this.task()
			.catch(() => undefined)
			.finally(() => {
				this.running = false;
				if (this.again) {
					this.again = false;
					this.run();
				}
			});
	}
}

interface WindowState {
	window: ChatWindow;
	items: Map<string, WindowItem>;
	signatures: Map<string, string>;
	generation: number;
	refresh: Coalescer;
}

export interface StoreOptions {
	readonly selfId: number;
	readonly onError?: (error: unknown, context: string) => void;
}

export class ChatStore {
	private readonly listeners = new Map<string, Set<Listener>>();
	private readonly dialogs = new Map<number, DialogView>();
	private readonly dialogJson = new Map<number, string>();
	private order: readonly number[] = [];
	private entries: readonly ListEntry[] = [];
	private readonly entryById = new Map<number, ListEntry>();
	private folderUnread: Readonly<Record<Folder, number>> = { all: 0, private: 0, group: 0, bot: 0, unread: 0 };
	private settings: NotificationSettings = DEFAULT_NOTIFICATION_SETTINGS;
	private totals: UnreadTotals = { messages: 0, chats: 0 };
	private readonly settingsRefresh = new Coalescer(() => this.loadSettings());
	private readonly totalsRefresh = new Coalescer(() => this.loadTotals());
	private muteTimer: ReturnType<typeof setTimeout> | undefined;
	private listStatus: ListStatus = "loading";
	private readonly users = new Map<number, User>();
	private readonly chats = new Map<number, Chat | null>();
	private readonly windows = new Map<number, WindowState>();
	private readonly lookups = new Map<string, StoredMessage | null>();
	private readonly lookupsInFlight = new Set<string>();
	private connection: ConnectionState = "connecting";
	/** AppConfig media limits; null until read once. */
	private limits: MediaLimits | null = null;
	private readonly limitsRefresh = new Coalescer(() => this.loadLimits());
	private readonly wantedUsers = new Set<number>();
	private usersScheduled = false;
	private readonly dialogRefresh = new Coalescer(() => this.loadDialogs());
	private readyWaiters: (() => void)[] = [];
	/**
	 * Windows whose unread divider still follows the dialog's read position:
	 * during a sync the read state can land after the messages. Tracking ends
	 * when this client marks the chat read (settleUnread).
	 */
	private readonly unreadTracking = new Set<number>();
	private readonly unsubscribe: () => void;
	private disposed = false;

	readonly selfId: number;

	constructor(
		readonly source: ChatSource,
		private readonly options: StoreOptions,
		snapshot: ScreenSnapshot | null = null,
	) {
		this.selfId = options.selfId;
		dropLegacyUnreadMarks(options.selfId);
		if (snapshot !== null && snapshot.userId === options.selfId && snapshot.dialogs.length > 0) {
			this.applyDialogs(snapshot.dialogs.map((d) => ({ ...d, topMessage: d.topMessage === null ? null : { ...d.topMessage, stale: true } })));
			for (const user of snapshot.users) this.users.set(user.id, user);
		}
		this.unsubscribe = source.events.subscribeBatches((keys) => this.onKeys(keys));
		this.dialogRefresh.run();
		this.settingsRefresh.run();
		this.limitsRefresh.run();
		this.refreshConnection();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.muteTimer);
		this.unsubscribe();
		this.listeners.clear();
	}

	// ------------------------------------------------------------- subscriptions

	subscribe(key: string, listener: Listener): () => void {
		let set = this.listeners.get(key);
		if (set === undefined) {
			set = new Set();
			this.listeners.set(key, set);
		}
		set.add(listener);
		return () => {
			const current = this.listeners.get(key);
			current?.delete(listener);
			if (current?.size === 0) this.listeners.delete(key);
		};
	}

	private emit(key: string): void {
		const set = this.listeners.get(key);
		if (set === undefined) return;
		for (const listener of [...set]) listener();
	}

	/** Reports a failure of a background load (also used by caches built on the store). */
	reportError(error: unknown, context: string): void {
		if (!this.disposed) this.options.onError?.(error, context);
	}

	private onKeys(keys: readonly string[]): void {
		if (this.disposed) return;
		let dialogs = false;
		const histories = new Set<number>();
		for (const key of keys) {
			if (key === "dialogs" || key.startsWith("dialog:")) dialogs = true;
			else if (key.startsWith("chat:")) {
				dialogs = true;
				const id = Number(key.slice(5));
				if (this.chats.has(id)) void this.loadChat(id);
			} else if (key.startsWith("user:")) {
				dialogs = true;
				const id = Number(key.slice(5));
				if (this.users.has(id)) this.wantUser(id, true);
			} else if (key.startsWith("history:")) histories.add(Number(key.slice(8)));
			else if (key.startsWith("message:")) histories.add(Number(key.split(":")[1]));
			else if (key === "outbox") for (const id of this.windows.keys()) histories.add(id);
			else if (key === "connection") this.refreshConnection();
			else if (key === EventKeys.notificationSettings) this.settingsRefresh.run();
		}
		if (dialogs) this.dialogRefresh.run();
		for (const chatId of histories) {
			this.windows.get(chatId)?.refresh.run();
			this.dropLookups(chatId);
		}
	}

	// ------------------------------------------------------------- dialogs

	listSnapshot(): readonly number[] {
		return this.order;
	}

	listState(): ListStatus {
		return this.listStatus;
	}

	dialog(chatId: number): DialogView | undefined {
		return this.dialogs.get(chatId);
	}

	refreshDialogs(): void {
		this.dialogRefresh.run();
	}

	private async loadDialogs(): Promise<void> {
		try {
			const views = await this.source.dialogs(DIALOG_LIMIT);
			if (this.disposed) return;
			this.applyDialogs(views);
		} catch (err) {
			this.reportError(err, "load dialogs");
		} finally {
			if (!this.disposed && this.listStatus === "loading") this.markListReady();
		}
	}

	private markListReady(): void {
		this.listStatus = "ready";
		this.emit("list");
		const waiters = this.readyWaiters;
		this.readyWaiters = [];
		for (const resolve of waiters) resolve();
	}

	private lateUnread(chatId: number, view: DialogView): void {
		const state = this.windows.get(chatId);
		if (state === undefined) return;
		const unreadFromSeq = view.dialog.unreadCount === 0 ? 0 : view.dialog.readInboxMaxSeq + 1;
		this.setWindow(state, { ...state.window, unreadFromSeq });
	}

	/** Freezes the unread divider (the reader is about to mark the chat read). */
	settleUnread(chatId: number): void {
		this.unreadTracking.delete(chatId);
	}

	/** Resolves once the dialog list (local database or snapshot) has been read. */
	private whenListReady(): Promise<void> {
		if (this.listStatus === "ready") return Promise.resolve();
		return new Promise((resolve) => this.readyWaiters.push(resolve));
	}

	private applyDialogs(views: readonly DialogView[]): void {
		const seen = new Set<number>();
		let changed = false;
		for (const view of views) {
			const id = view.dialog.chatId;
			seen.add(id);
			const json = JSON.stringify(view);
			if (this.dialogJson.get(id) !== json) {
				changed = true;
				this.dialogJson.set(id, json);
				this.dialogs.set(id, view);
				if (view.chat !== null) this.chats.set(id, view.chat);
				if (view.peer !== null) this.users.set(view.peer.id, view.peer);
				if (this.unreadTracking.has(id)) this.lateUnread(id, view);
				const from = view.topMessage?.fromId ?? 0;
				if (from !== 0 && from !== this.selfId) this.wantUser(from);
				this.emit(`dialog:${id}`);
			}
		}
		for (const id of [...this.dialogs.keys()]) {
			if (!seen.has(id)) {
				changed = true;
				this.dialogs.delete(id);
				this.dialogJson.delete(id);
				this.emit(`dialog:${id}`);
			}
		}
		const order = views.map((view) => view.dialog.chatId);
		if (!sameKeys(order, this.order)) {
			this.order = order;
			this.emit("list");
		}
		this.refreshEntries();
		if (changed) this.totalsRefresh.run();
		if (views.length > 0 && this.listStatus === "loading") this.markListReady();
	}

	/** The list as the chat list filters it, in list order (pinned chats first). */
	listEntries(): readonly ListEntry[] {
		return this.entries;
	}

	/** Chats with unread messages per built-in folder (the folder badges); muted chats count only when the user chose so. */
	folderCounts(): Readonly<Record<Folder, number>> {
		return this.folderUnread;
	}

	/** The list entry of one chat (muted, pinned, unread), for its row and menus. */
	listEntry(chatId: number): ListEntry | undefined {
		return this.entryById.get(chatId);
	}

	// ------------------------------------------------------------- notification settings and badge

	/** The user's notification settings (the defaults until they load). */
	notificationSettings(): NotificationSettings {
		return this.settings;
	}

	/** Changes notification settings on the server; the store follows the saved result. */
	async setNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationSettings> {
		const saved = await this.source.setNotificationSettings(change);
		if (!this.disposed) this.applySettings(saved);
		return saved;
	}

	/** Unread messages and chats of the app badge (core unreadTotals, muted chats per the settings). */
	unreadTotals(): UnreadTotals {
		return this.totals;
	}

	/** Reads the settings again (the settings screen waits for them); rejects when they cannot be read. */
	async loadNotificationSettings(): Promise<NotificationSettings> {
		const settings = await this.source.notificationSettings();
		if (!this.disposed) this.applySettings(settings);
		return settings;
	}

	private async loadSettings(): Promise<void> {
		try {
			await this.loadNotificationSettings();
		} catch (err) {
			this.reportError(err, "notification settings");
		}
	}

	private applySettings(settings: NotificationSettings): void {
		const same = (Object.keys(settings) as (keyof NotificationSettings)[]).every((key) => settings[key] === this.settings[key]);
		if (same) return;
		const badgeChanged = settings.badgeMuted !== this.settings.badgeMuted;
		this.settings = settings;
		this.emit("settings");
		if (badgeChanged) {
			this.refreshEntries();
			this.totalsRefresh.run();
		}
	}

	private async loadTotals(): Promise<void> {
		try {
			const totals = await this.source.unreadTotals();
			if (this.disposed || (totals.messages === this.totals.messages && totals.chats === this.totals.chats)) return;
			this.totals = totals;
			this.emit("totals");
		} catch (err) {
			this.reportError(err, "unread totals");
		}
	}

	/** Rebuilds the list entries and folder counts; listeners hear only of real changes. */
	private refreshEntries(): void {
		const now = Math.floor(Date.now() / 1000);
		let nextMuteEnd = 0;
		const entries: ListEntry[] = [];
		const counts: Record<Folder, number> = { all: 0, private: 0, group: 0, bot: 0, unread: 0 };
		const changed: number[] = [];
		const seen = new Set<number>();
		for (const chatId of this.order) {
			const view = this.dialogs.get(chatId);
			if (view === undefined) continue;
			const { dialog } = view;
			const muted = isMuted(dialog, now);
			if (muted && dialog.muteUntil !== MUTE_FOREVER && (nextMuteEnd === 0 || dialog.muteUntil < nextMuteEnd)) nextMuteEnd = dialog.muteUntil;
			const forum = view.chat?.forum === true;
			const fresh: ListEntry = {
				chatId,
				kind: chatKind(view.chat, view.peer, forum),
				saved: isSavedChat(view.chat, view.peer),
				forum,
				unread: dialog.unreadCount > 0 || dialog.unreadMentionsCount > 0 || dialog.unreadMark,
				muted,
				pinned: dialog.pinned,
			};
			const previous = this.entryById.get(chatId);
			const same =
				previous !== undefined &&
				previous.kind === fresh.kind &&
				previous.saved === fresh.saved &&
				previous.forum === fresh.forum &&
				previous.unread === fresh.unread &&
				previous.muted === fresh.muted &&
				previous.pinned === fresh.pinned;
			const entry = same ? previous : fresh;
			if (!same) {
				this.entryById.set(chatId, entry);
				changed.push(chatId);
			}
			seen.add(chatId);
			entries.push(entry);
			if (!entry.unread || (muted && !this.settings.badgeMuted)) continue;
			for (const folder of FOLDERS) if (inFolder(entry.kind, folder, true)) counts[folder]++;
		}
		for (const chatId of [...this.entryById.keys()]) {
			if (seen.has(chatId)) continue;
			this.entryById.delete(chatId);
			changed.push(chatId);
		}
		if (changed.length > 0 || !sameKeys(entries, this.entries)) {
			this.entries = entries;
			this.emit("entries");
			for (const chatId of changed) this.emit(`entry:${chatId}`);
		}
		if (FOLDERS.some((folder) => counts[folder] !== this.folderUnread[folder])) {
			this.folderUnread = counts;
			this.emit("folders");
		}
		// A mute that ends while the app is open: unmute the row then.
		clearTimeout(this.muteTimer);
		if (nextMuteEnd !== 0 && !this.disposed) {
			this.muteTimer = setTimeout(() => this.refreshEntries(), Math.min((nextMuteEnd - now) * 1000 + 500, 2_147_000_000));
		}
	}

	// ------------------------------------------------------------- chats and users

	chat(chatId: number): Chat | null | undefined {
		return this.dialogs.get(chatId)?.chat ?? this.chats.get(chatId);
	}

	ensureChat(chatId: number): void {
		if (!this.chats.has(chatId) && this.dialogs.get(chatId)?.chat == null) void this.loadChat(chatId);
	}

	private async loadChat(chatId: number): Promise<void> {
		try {
			const chat = await this.source.chat(chatId);
			if (this.disposed) return;
			this.chats.set(chatId, chat);
			this.emit(`chat:${chatId}`);
		} catch (err) {
			this.reportError(err, `chat ${chatId}`);
		}
	}

	user(userId: number): User | undefined {
		return this.users.get(userId);
	}

	/** Asks for users not cached yet; they arrive in one batch. */
	wantUser(userId: number, force = false): void {
		if (userId === 0 || (!force && (this.users.has(userId) || this.wantedUsers.has(userId)))) return;
		this.wantedUsers.add(userId);
		if (this.usersScheduled) return;
		this.usersScheduled = true;
		queueMicrotask(() => void this.loadUsers());
	}

	private async loadUsers(): Promise<void> {
		this.usersScheduled = false;
		const ids = [...this.wantedUsers];
		this.wantedUsers.clear();
		if (ids.length === 0) return;
		try {
			const users = await this.source.users(ids);
			if (this.disposed) return;
			for (const user of users) {
				this.users.set(user.id, user);
				this.emit(`user:${user.id}`);
			}
		} catch (err) {
			this.reportError(err, "load users");
		}
	}

	// ------------------------------------------------------------- connection

	connectionState(): ConnectionState {
		return this.connection;
	}

	private refreshConnection(): void {
		this.source.connectionState().then(
			(state) => {
				if (this.disposed || state === this.connection) return;
				this.connection = state;
				this.emit("connection");
				// Limits read offline are the defaults: ask the server again once connected.
				if (state === "connected" && this.limits?.fromServer !== true) this.limitsRefresh.run();
			},
			(err: unknown) => this.reportError(err, "connection state"),
		);
	}

	// ------------------------------------------------------------- media limits

	/** Upload limits (AppConfig); null until read. uploadSizeMax 0: media is off on this server. */
	mediaLimits(): MediaLimits | null {
		return this.limits;
	}

	private async loadLimits(): Promise<void> {
		try {
			const limits = await this.source.mediaLimits();
			if (this.disposed) return;
			const previous = this.limits;
			if (previous !== null && previous.uploadSizeMax === limits.uploadSizeMax && previous.albumSizeMax === limits.albumSizeMax && previous.fromServer === limits.fromServer) {
				return;
			}
			this.limits = limits;
			this.emit("mediaLimits");
		} catch (err) {
			this.reportError(err, "media limits");
		}
	}

	// ------------------------------------------------------------- message windows

	window(chatId: number): ChatWindow | undefined {
		return this.windows.get(chatId)?.window;
	}

	item(chatId: number, key: string): WindowItem | undefined {
		return this.windows.get(chatId)?.items.get(key);
	}

	/** Items of the window in order (for scans such as pending counts and topic filters). */
	items(chatId: number): WindowItem[] {
		const state = this.windows.get(chatId);
		if (state === undefined) return [];
		return state.window.keys.flatMap((key) => {
			const item = state.items.get(key);
			return item === undefined ? [] : [item];
		});
	}

	/**
	 * Opens (or reuses) the message window of a chat. `focusSeq` jumps to a
	 * message: the window is loaded around it instead of at the newest one.
	 */
	openWindow(chatId: number, focusSeq = 0): void {
		const existing = this.windows.get(chatId);
		if (existing !== undefined && focusSeq === 0) {
			// Most recently used last, so the oldest cached window is dropped first.
			this.windows.delete(chatId);
			this.windows.set(chatId, existing);
			existing.refresh.run();
			return;
		}
		const state: WindowState = existing ?? {
			window: {
				chatId,
				keys: [],
				status: "loading",
				failure: null,
				hasOlder: false,
				hasNewer: false,
				live: true,
				loadingOlder: false,
				unreadFromSeq: 0,
				focusSeq: 0,
				focusToken: 0,
				pendingCount: 0,
			},
			items: new Map(),
			signatures: new Map(),
			generation: 0,
			refresh: new Coalescer(() => this.reloadWindow(chatId)),
		};
		this.windows.set(chatId, state);
		while (this.windows.size > KEPT_WINDOWS) {
			const oldest = this.windows.keys().next().value;
			if (oldest === undefined || oldest === chatId) break;
			this.windows.delete(oldest);
		}
		// The unread divider needs the read position, which comes with the dialog list.
		void this.whenListReady().then(() => {
			if (this.disposed || this.windows.get(chatId) !== state) return;
			const dialog = this.dialogs.get(chatId)?.dialog;
			if (existing === undefined) this.unreadTracking.add(chatId);
			const unreadFromSeq = existing === undefined && dialog !== undefined && dialog.unreadCount > 0 ? dialog.readInboxMaxSeq + 1 : state.window.unreadFromSeq;
			if (unreadFromSeq !== state.window.unreadFromSeq) state.window = { ...state.window, unreadFromSeq };
			const anchor = focusSeq !== 0 ? focusSeq : unreadFromSeq;
			if (anchor !== 0) {
				void this.load(chatId, { direction: "around", offsetSeq: anchor, limit: FIRST_PAGE }, "replace", focusSeq);
			} else {
				void this.load(chatId, { direction: "older", offsetSeq: 0, limit: FIRST_PAGE }, "replace", 0);
			}
		});
	}

	loadOlder(chatId: number): void {
		const state = this.windows.get(chatId);
		if (state === undefined || !state.window.hasOlder || state.window.loadingOlder) return;
		const first = this.firstSeq(state);
		if (first === 0) return;
		this.setWindow(state, { ...state.window, loadingOlder: true });
		void this.load(chatId, { direction: "older", offsetSeq: first, limit: PAGE }, "prepend", 0);
	}

	loadNewer(chatId: number): void {
		const state = this.windows.get(chatId);
		if (state === undefined || !state.window.hasNewer) return;
		const last = this.lastSeq(state);
		void this.load(chatId, { direction: "newer", offsetSeq: last, limit: PAGE }, "append", 0);
	}

	/** Back to the newest messages (the "to bottom" button). */
	jumpToNewest(chatId: number): void {
		const state = this.windows.get(chatId);
		if (state === undefined) return;
		if (state.window.live) return;
		void this.load(chatId, { direction: "older", offsetSeq: 0, limit: FIRST_PAGE }, "replace", 0);
	}

	private firstSeq(state: WindowState): number {
		for (const key of state.window.keys) {
			const item = state.items.get(key);
			if (item?.kind === "message") return item.message.seq;
		}
		return 0;
	}

	private lastSeq(state: WindowState): number {
		for (let i = state.window.keys.length - 1; i >= 0; i--) {
			const item = state.items.get(state.window.keys[i] ?? "");
			if (item?.kind === "message") return item.message.seq;
		}
		return 0;
	}

	private async reloadWindow(chatId: number): Promise<void> {
		const state = this.windows.get(chatId);
		if (state === undefined || state.window.status === "loading") return;
		if (state.window.live) {
			const count = state.window.keys.length;
			const limit = Math.min(MAX_WINDOW, Math.max(FIRST_PAGE, count + 1));
			await this.load(chatId, { direction: "older", offsetSeq: 0, limit }, "replace", 0);
		} else {
			const first = this.firstSeq(state);
			const limit = Math.min(MAX_WINDOW, Math.max(PAGE, state.window.keys.length));
			await this.load(chatId, { direction: "newer", offsetSeq: Math.max(0, first - 1), limit }, "keep", 0);
		}
	}

	private async load(
		chatId: number,
		request: HistoryRequest,
		mode: "replace" | "prepend" | "append" | "keep",
		focusSeq: number,
	): Promise<void> {
		const state = this.windows.get(chatId);
		if (state === undefined) return;
		const generation = ++state.generation;
		let view;
		try {
			view = await this.source.history(chatId, request);
		} catch (err) {
			this.reportError(err, `history ${chatId}`);
			if (this.windows.get(chatId) === state && generation === state.generation) {
				this.setWindow(state, { ...state.window, status: "ready", failure: "retryable", loadingOlder: false });
			}
			return;
		}
		if (this.disposed || this.windows.get(chatId) !== state || generation !== state.generation) return;

		const incoming: WindowItem[] = [
			...view.messages.map((message): WindowItem => ({ kind: "message", message })),
			...view.pending.map((pending): WindowItem => ({ kind: "pending", pending })),
		];
		const keyOf = (item: WindowItem): string =>
			item.kind === "message" ? messageKey(item.message) : pendingKey(item.pending);
		let keys: string[];
		let hasOlder = view.hasOlder;
		let hasNewer = view.hasNewer;
		const previous = state.window.keys;
		if (mode === "prepend") {
			const fresh = incoming.filter((item) => item.kind === "message").map(keyOf);
			const known = new Set(previous);
			keys = [...fresh.filter((key) => !known.has(key)), ...previous];
			hasNewer = state.window.hasNewer;
			if (keys.length > MAX_WINDOW) {
				keys = keys.slice(0, MAX_WINDOW);
				hasNewer = true;
			}
		} else if (mode === "append") {
			const known = new Set(previous);
			keys = [...previous, ...incoming.map(keyOf).filter((key) => !known.has(key))];
			hasOlder = state.window.hasOlder || keys.length > MAX_WINDOW;
			if (keys.length > MAX_WINDOW) keys = keys.slice(keys.length - MAX_WINDOW);
		} else {
			keys = incoming.map(keyOf);
			if (mode === "keep") hasOlder = state.window.hasOlder;
		}

		const items = new Map(state.items);
		const changed: string[] = [];
		for (const item of incoming) {
			const key = keyOf(item);
			items.set(key, item);
			const signature = itemSignature(item);
			if (state.signatures.get(key) !== signature) {
				state.signatures.set(key, signature);
				changed.push(key);
			}
		}
		const keep = new Set(keys);
		for (const key of [...items.keys()]) {
			if (!keep.has(key)) {
				items.delete(key);
				state.signatures.delete(key);
			}
		}
		state.items = items;
		for (const item of incoming) {
			if (item.kind === "message" && item.message.fromId !== this.selfId) this.wantUser(item.message.fromId);
			if (item.kind === "message" && item.message.forward !== null) this.wantUser(item.message.forward.fromUserId);
		}

		const next: ChatWindow = {
			...state.window,
			keys: sameKeys(keys, previous) ? previous : keys,
			status: "ready",
			failure: view.failure,
			hasOlder,
			hasNewer,
			live: !hasNewer,
			loadingOlder: mode === "prepend" ? false : state.window.loadingOlder,
			focusSeq: mode === "replace" && focusSeq !== 0 ? focusSeq : state.window.focusSeq,
			focusToken: mode === "replace" && focusSeq !== 0 ? state.window.focusToken + 1 : state.window.focusToken,
			pendingCount: view.pending.length,
		};
		this.setWindow(state, next);
		for (const key of changed) this.emit(`item:${chatId}:${key}`);
	}

	private setWindow(state: WindowState, next: ChatWindow): void {
		const prev = state.window;
		const changed = (Object.keys(next) as (keyof ChatWindow)[]).some((key) => next[key] !== prev[key]);
		if (!changed) return;
		state.window = next;
		this.emit(`window:${next.chatId}`);
	}

	// ------------------------------------------------------------- single messages

	/** A message by seq: from the open window, else from a lookup cache. */
	message(chatId: number, seq: number): StoredMessage | null | undefined {
		const state = this.windows.get(chatId);
		if (state !== undefined) {
			for (const item of state.items.values()) {
				if (item.kind === "message" && item.message.seq === seq) return item.message;
			}
		}
		return this.lookups.get(`${chatId}:${seq}`);
	}

	/** Loads a message outside the window (reply quote, pinned bar). */
	wantMessage(chatId: number, seq: number): void {
		const key = `${chatId}:${seq}`;
		if (seq === 0 || this.lookups.has(key) || this.lookupsInFlight.has(key)) return;
		if (this.message(chatId, seq) !== undefined) return;
		this.lookupsInFlight.add(key);
		this.source
			.history(chatId, { direction: "around", offsetSeq: seq, limit: 1 })
			.then(
				(view) => {
					if (this.disposed) return;
					const found = view.messages.find((m) => m.seq === seq) ?? null;
					this.lookups.set(key, found);
					if (found !== null && found.fromId !== this.selfId) this.wantUser(found.fromId);
					this.emit(`lookup:${key}`);
				},
				(err: unknown) => this.reportError(err, `message ${key}`),
			)
			.finally(() => this.lookupsInFlight.delete(key));
	}

	private dropLookups(chatId: number): void {
		const prefix = `${chatId}:`;
		for (const key of [...this.lookups.keys()]) {
			if (key.startsWith(prefix)) {
				this.lookups.delete(key);
				this.emit(`lookup:${key}`);
			}
		}
	}
}
