// Online-only actions of the core: per-user settings, pinned messages and
// online counts. Each one is a direct server call (no offline outbox): the
// result is written locally right away where the UI shows it, and the
// update the server writes for it reaches every session through sync
// (expectAck makes a lost realtime echo come back through GetDifference).
import { DEFAULT_NOTIFICATION_SETTINGS, unreadTotals } from "../model/types.ts";
import type { NotificationSettings, PinnedMessagesPage } from "../model/types.ts";
import { assertSafeId } from "../ids/index.ts";
import type { RemoteApi } from "../protocol/api.ts";
import { toNotificationSettings, toPinnedMessagesPage, toSyncAck, toWireId, toWireSound } from "../protocol/map.ts";
import type { Repository } from "../repo/repository.ts";
import { putNotificationSettings, putUnreadMark, putUser } from "../repo/writes.ts";
import type { SyncEngine } from "../sync/engine.ts";

export interface PinnedMessagesRequest {
	/** Forum groups: only the pins of this topic; 0 = the whole chat. */
	readonly topicId?: number;
	/** Pinned messages with seq < offsetSeq; 0 = from the newest. */
	readonly offsetSeq?: number;
	/** Default 50, at most 100. */
	readonly limit?: number;
}

export interface DirectActionsOptions {
	readonly api: RemoteApi;
	readonly repo: Repository;
	readonly engine: SyncEngine;
	readonly now: () => number;
}

/** Thrown when the server API in use lacks a method (an older server or a test double). */
export class UnsupportedApiError extends Error {
	constructor(method: string) {
		super(`the server API does not offer ${method}`);
		this.name = "UnsupportedApiError";
	}
}

function required<T>(method: T | undefined, name: string): T {
	if (method === undefined) throw new UnsupportedApiError(name);
	return method;
}

export class DirectActions {
	constructor(private readonly options: DirectActionsOptions) {}

	/** Marks a chat as unread or clears the mark, on every session of the user. */
	async setDialogUnreadMark(chatId: number, unread: boolean): Promise<void> {
		const { api, engine } = this.options;
		const call = required(api.chats.setDialogUnreadMark, "SetDialogUnreadMark");
		const response = await call({ chatId: toWireId(chatId), unread });
		await engine.commitLocal((w) => putUnreadMark(w, chatId, unread));
		engine.expectAck(toSyncAck(response.ack), chatId);
	}

	/**
	 * The user's notification settings: the synced copy, fetched from the
	 * server when there is none yet; the defaults when it cannot be asked.
	 */
	async notificationSettings(): Promise<NotificationSettings> {
		const { repo, engine } = this.options;
		const stored = await repo.notificationSettings();
		if (stored !== null) return stored;
		const fetched = await engine.fetchNotificationSettings();
		if (fetched === null) return DEFAULT_NOTIFICATION_SETTINGS;
		await engine.commitLocal(async (w) => {
			// A change synced meanwhile is newer than this read.
			if ((await repo.notificationSettings()) === null) putNotificationSettings(w, fetched);
		});
		return (await repo.notificationSettings()) ?? fetched;
	}

	/** Changes the given settings; returns all of them after the change. */
	async setNotificationSettings(change: Partial<NotificationSettings>): Promise<NotificationSettings> {
		const { api, engine } = this.options;
		const call = required(api.chats.setNotificationSettings, "SetNotificationSettings");
		const response = await call({
			...(change.privateEnabled === undefined ? {} : { privateEnabled: change.privateEnabled }),
			...(change.privatePreview === undefined ? {} : { privatePreview: change.privatePreview }),
			...(change.groupsEnabled === undefined ? {} : { groupsEnabled: change.groupsEnabled }),
			...(change.groupsPreview === undefined ? {} : { groupsPreview: change.groupsPreview }),
			...(change.channelsEnabled === undefined ? {} : { channelsEnabled: change.channelsEnabled }),
			...(change.channelsPreview === undefined ? {} : { channelsPreview: change.channelsPreview }),
			...(change.sound === undefined ? {} : { sound: toWireSound(change.sound) }),
			...(change.badgeMuted === undefined ? {} : { badgeMuted: change.badgeMuted }),
		});
		if (response.settings === undefined) throw new Error("SetNotificationSettings returned no settings");
		const settings = toNotificationSettings(response.settings);
		await engine.commitLocal((w) => putNotificationSettings(w, settings));
		engine.expectAck(toSyncAck(response.ack), 0);
		return settings;
	}

	/** A page of the chat's pinned messages the user can see, newest first. */
	async pinnedMessages(chatId: number, request: PinnedMessagesRequest = {}): Promise<PinnedMessagesPage> {
		const { api, engine } = this.options;
		const call = required(api.messages.getPinnedMessages, "GetPinnedMessages");
		const response = await call({
			chatId: toWireId(chatId),
			topicId: toWireId(request.topicId ?? 0),
			offsetSeq: toWireId(request.offsetSeq ?? 0),
			limit: Math.max(1, Math.min(request.limit ?? 50, 100)),
		});
		const page = toPinnedMessagesPage(response);
		// Pinned messages are not written into the cached history: they are
		// sparse, and the history cache assumes contiguous ranges.
		if (page.users.length > 0) {
			await engine.commitLocal((w) => {
				for (const user of page.users) putUser(w, user);
			});
		}
		return page;
	}

	/** Unpins every pinned message of the chat, or of one forum topic. */
	async unpinAllMessages(chatId: number, topicId = 0): Promise<void> {
		const { api, engine } = this.options;
		const call = required(api.messages.unpinAllMessages, "UnpinAllMessages");
		const response = await call({ chatId: toWireId(chatId), topicId: toWireId(assertSafeId(topicId)) });
		// The pin update (with the unpinned seqs) applies through sync.
		engine.expectAck(toSyncAck(response.ack), chatId);
	}

	/** Members of a group online now (server-side count, approximate). */
	async onlineCount(chatId: number): Promise<number> {
		const call = required(this.options.api.chats.getChatOnlineCount, "GetChatOnlineCount");
		const response = await call({ chatId: toWireId(chatId) });
		return response.onlineCount;
	}

	/** The app badge totals, with muted chats counted as the user chose. */
	async unreadTotals(): Promise<{ readonly messages: number; readonly chats: number }> {
		const { repo, now } = this.options;
		const [dialogs, settings] = await Promise.all([repo.badgeDialogs(), this.notificationSettings()]);
		return unreadTotals(dialogs, Math.floor(now() / 1000), settings.badgeMuted);
	}
}
