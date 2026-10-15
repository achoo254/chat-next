// In-memory server implementing the sync contract of updates.proto,
// messages.proto, chats.proto and realtime.proto (ADR 0002) closely enough
// to test the client against it: per-user pts logs, per-chat chat_pts logs
// for sync_mode=large, server_epoch, too_long, entity attachment, random_id
// dedupe, and a realtime link that can drop and reorder frames.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Socket, SocketFactory, SocketHandlers } from "@app/platform";
import { SessionRevokeReason } from "@app/proto-ts/auth";
import {
	ChatSchema,
	ChatType,
	DialogSchema,
	GetChatOnlineCountResponseSchema,
	GetChatResponseSchema,
	GetDialogsResponseSchema,
	GetNotificationSettingsResponseSchema,
	GetPeerDialogsResponseSchema,
	NotificationSettingsSchema,
	NotificationSound,
	SetDialogUnreadMarkResponseSchema,
	SetNotificationSettingsResponseSchema,
	SyncMode,
	type Chat as WireChat,
	type Dialog as WireDialog,
	type NotificationSettings as WireNotificationSettings,
} from "@app/proto-ts/chats";
import {
	DeleteMessagesResponseSchema,
	EditMessageResponseSchema,
	GetHistoryResponseSchema,
	GetPinnedMessagesResponseSchema,
	HistoryDirection,
	MessageActionSchema,
	MessageSchema,
	ReadHistoryResponseSchema,
	ReactionCountSchema,
	SendAlbumResponseSchema,
	SendMediaResponseSchema,
	SendMessageResponseSchema,
	SyncAckSchema,
	UnpinAllMessagesResponseSchema,
	type Message as WireMessage,
	type SyncAck as WireSyncAck,
} from "@app/proto-ts/messages";
import { ClientFrameSchema, ResyncReason, ServerFrameSchema } from "@app/proto-ts/realtime";
import {
	GetChatDifferenceResponseSchema,
	GetDifferenceResponseSchema,
	GetStateResponseSchema,
	LargeChatStateSchema,
	UpdateSchema,
	type Update as WireUpdate,
} from "@app/proto-ts/updates";
import { GetSelfResponseSchema, GetUsersResponseSchema, UserSchema, type User as WireUser } from "@app/proto-ts/users";
import {
	SearchChatMessagesResponseSchema,
	SearchMessagesResponseSchema,
	SearchFilterSchema,
} from "@app/proto-ts/search";
import { matchesSubstrings } from "../../src/search/index.ts";
import { searchText } from "../../src/vifold/index.ts";
import type { RemoteApi } from "../../src/protocol/api.ts";
import type { MediaRef as WireMediaRef } from "@app/proto-ts/media";
import type { FakeMedia } from "./fake-media.ts";
import { toMessage } from "../../src/protocol/map.ts";
import type { Message } from "../../src/model/types.ts";

type UpdateKind = NonNullable<MessageInitShape<typeof UpdateSchema>["kind"]>;

interface LogEntry {
	readonly pts: number;
	readonly update: WireUpdate;
}

interface MessageRecord {
	message: WireMessage;
	/** Recalled (deleted for everyone): history shows a placeholder. */
	deleted: boolean;
	/** Per emoji, who reacted, oldest first. */
	readonly reactors: Map<string, Set<number>>;
	readonly sender: number;
	readonly randomId: number;
}

interface ChatRecord {
	readonly id: number;
	readonly type: ChatType;
	title: string;
	readonly members: Set<number>;
	syncMode: SyncMode;
	readonly messages: Map<number, MessageRecord>;
	nextSeq: number;
	/** Seqs of the pinned messages. */
	readonly pins: Set<number>;
	log: LogEntry[];
	chatPts: number;
	logMin: number;
	/** Per member: their pts when the large chat last had activity. */
	readonly activity: Map<number, number>;
	readonly peerOf: Map<number, number>;
}

interface UserRecord {
	readonly id: number;
	readonly name: string;
	pts: number;
	log: LogEntry[];
	logMin: number;
	readonly hidden: Set<string>;
	readonly reads: Map<number, { inbox: number; outbox: number }>;
	readonly sent: Map<number, { chatId: number; seq: number; ack: WireSyncAck }>;
	revoked: boolean;
	/** chat id -> muted until (unix seconds). */
	readonly mutes: Map<number, number>;
	/** Pinned chats, top first. */
	pins: number[];
	/** Chats the user marked as unread. */
	readonly unreadMarks: Set<number>;
	notify: WireNotificationSettings;
}

type NotifyChange = Partial<Omit<WireNotificationSettings, "$typeName" | "$unknown">>;

function defaultNotify(): WireNotificationSettings {
	return create(NotificationSettingsSchema, {
		privateEnabled: true,
		privatePreview: true,
		groupsEnabled: true,
		groupsPreview: true,
		channelsEnabled: true,
		channelsPreview: true,
		sound: NotificationSound.DEFAULT,
		badgeMuted: false,
	});
}

interface Session {
	readonly id: number;
	readonly userId: number;
	readonly handlers: SocketHandlers;
	open: boolean;
	openChat: number;
	visible: Set<number>;
}

/** Deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface NetworkConditions {
	lossRate: number;
	reorderRate: number;
	latencyMs: number;
}

export interface RpcFault {
	method: string;
	/** "before": fail without applying; "after": apply, then lose the response. */
	when: "before" | "after";
	code: Code;
	remaining: number;
}

const big = (n: number): bigint => BigInt(n);
const num = (n: bigint): number => Number(n);

export class FakeServer {
	epoch = 1;
	online = true;
	/** When true the server sends nothing at all (dead socket). */
	silent = false;
	readonly network: NetworkConditions = { lossRate: 0, reorderRate: 0, latencyMs: 1 };
	readonly faults: RpcFault[] = [];
	readonly calls = new Map<string, number>();
	/** Updates written for each user (both logs), for the chaos budget. */
	readonly updatesFor = new Map<number, number>();
	framesLost = 0;
	framesReordered = 0;
	heartbeatMs = 25_000;

	/** MediaService and storage; set it to give the clients media. */
	media: FakeMedia | null = null;
	private nextGroupedId = 1;

	private readonly users = new Map<number, UserRecord>();
	private readonly chats = new Map<number, ChatRecord>();
	private readonly sessions = new Set<Session>();
	private nextUserId = 1001;
	private nextChatId = 5001;
	private nextSessionId = 1;
	private readonly rng: () => number;

	constructor(seed = 1) {
		this.rng = seededRandom(seed);
	}

	private now(): number {
		return Math.floor(Date.now() / 1000);
	}

	// ------------------------------------------------------------ setup

	addUser(name: string): number {
		const id = this.nextUserId++;
		this.users.set(id, {
			id,
			name,
			pts: 0,
			log: [],
			logMin: 0,
			hidden: new Set(),
			reads: new Map(),
			sent: new Map(),
			revoked: false,
			mutes: new Map(),
			pins: [],
			unreadMarks: new Set(),
			notify: defaultNotify(),
		});
		return id;
	}

	createChat(type: ChatType, title: string, members: readonly number[]): number {
		const id = this.nextChatId++;
		const chat: ChatRecord = {
			id,
			type,
			title,
			members: new Set(members),
			syncMode: SyncMode.SMALL,
			messages: new Map(),
			nextSeq: 1,
			pins: new Set(),
			log: [],
			chatPts: 0,
			logMin: 0,
			activity: new Map(),
			peerOf: new Map(),
		};
		if (type === ChatType.PRIVATE && members.length === 2) {
			const [a = 0, b = 0] = members;
			chat.peerOf.set(a, b);
			chat.peerOf.set(b, a);
		}
		this.chats.set(id, chat);
		for (const member of members) this.reads(member, id);
		return id;
	}

	private user(id: number): UserRecord {
		const user = this.users.get(id);
		if (user === undefined) throw new ConnectError(`user ${id}`, Code.NotFound);
		return user;
	}

	private chat(id: number): ChatRecord {
		const chat = this.chats.get(id);
		if (chat === undefined) throw new ConnectError(`chat ${id}`, Code.NotFound);
		return chat;
	}

	private reads(userId: number, chatId: number): { inbox: number; outbox: number } {
		const user = this.user(userId);
		let read = user.reads.get(chatId);
		if (read === undefined) {
			read = { inbox: 0, outbox: 0 };
			user.reads.set(chatId, read);
		}
		return read;
	}

	// ------------------------------------------------------------ views

	wireUser(id: number, viewer: number): WireUser {
		const user = this.user(id);
		return create(UserSchema, { id: big(id), name: user.name, username: `u${id}`, isSelf: id === viewer });
	}

	wireChat(id: number, viewer: number): WireChat {
		const chat = this.chat(id);
		return create(ChatSchema, {
			id: big(id),
			type: chat.type,
			title: chat.title,
			peerUserId: big(chat.peerOf.get(viewer) ?? 0),
			syncMode: chat.syncMode,
			memberCount: chat.members.size,
			pinnedSeq: big(this.pinnedSeq(id)),
			left: !chat.members.has(viewer),
		});
	}

	/** In the viewer's history: not hidden for them (a recalled one shows as its placeholder). */
	private visible(record: MessageRecord, viewer: number): boolean {
		return !this.user(viewer).hidden.has(`${num(record.message.chatId)}:${num(record.message.seq)}`);
	}

	/** The message as `viewer` sees it (random_id only for its sender, chosen per viewer). */
	private view(record: MessageRecord, viewer: number): WireMessage {
		const { message } = record;
		if (record.deleted) {
			return create(MessageSchema, {
				chatId: message.chatId,
				seq: message.seq,
				fromId: message.fromId,
				date: message.date,
				topicId: message.topicId,
				editVersion: message.editVersion,
				randomId: big(viewer === record.sender ? record.randomId : 0),
				recalled: true,
			});
		}
		const reactions = [...record.reactors.entries()]
			.filter(([, users]) => users.size > 0)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([emoji, users]) =>
				create(ReactionCountSchema, {
					emoji,
					count: users.size,
					chosen: users.has(viewer),
					recentUserIds: [...users].slice(-3).reverse().map(big),
				}),
			);
		return create(MessageSchema, {
			...record.message,
			randomId: big(viewer === record.sender ? record.randomId : 0),
			reactions,
		});
	}

	private visibleMessages(chatId: number, viewer: number): MessageRecord[] {
		return [...this.chat(chatId).messages.values()]
			.filter((record) => this.visible(record, viewer))
			.sort((a, b) => num(a.message.seq) - num(b.message.seq));
	}

	/**
	 * SearchService over the visible messages, by the server's rule: every
	 * query token inside the search text, or, when every token is short,
	 * every token a word and the last one possibly cut short; newest first;
	 * the cursor is an offset.
	 */
	private searchPage(
		viewer: number,
		chatId: number,
		query: string,
		cursor: string,
		limit: number,
		filter?: Omit<MessageInitShape<typeof SearchFilterSchema>, "$typeName">,
	) {
		const tokens = searchText(query).split(" ").filter((token) => token !== "");
		const fromId = num(filter?.fromId ?? 0n);
		const minDate = num(filter?.minDate ?? 0n);
		const maxDate = num(filter?.maxDate ?? 0n);
		const kind = filter?.mediaKind ?? 0;
		const filtered = fromId !== 0 || minDate !== 0 || maxDate !== 0 || kind !== 0 || filter?.hasLink === true;
		const chats = chatId === 0 ? [...this.chats.values()].filter((chat) => chat.members.has(viewer)).map((chat) => chat.id) : [chatId];
		const hits = chats
			.flatMap((id) => this.visibleMessages(id, viewer))
			.filter((record) => {
				const m = record.message;
				if (record.deleted || m.action !== undefined || (tokens.length === 0 && !filtered)) return false;
				if (fromId !== 0 && num(m.fromId) !== fromId) return false;
				if (kind !== 0 && m.media?.kind !== kind) return false;
				if (minDate !== 0 && num(m.date) < minDate) return false;
				if (maxDate !== 0 && num(m.date) > maxDate) return false;
				if (filter?.hasLink === true && m.linkPreview === undefined && !/https?:\/\//i.test(m.text)) return false;
				if (tokens.length === 0) return m.text !== "" || m.media !== undefined;
				const text = searchText(`${m.text}\n${m.media?.fileName ?? ""}`);
				if (matchesSubstrings(tokens)) return tokens.every((token) => text.includes(token));
				const words = text.split(" ");
				return tokens.every((token, index) =>
					index === tokens.length - 1 ? words.some((word) => word.startsWith(token)) : words.includes(token),
				);
			})
			.sort(
				(a, b) =>
					num(b.message.date) - num(a.message.date) ||
					num(b.message.chatId) - num(a.message.chatId) ||
					num(b.message.seq) - num(a.message.seq),
			);
		const offset = cursor === "" ? 0 : Number(cursor);
		const page = hits.slice(offset, offset + (limit > 0 ? limit : 20));
		const end = offset + page.length;
		return {
			messages: page.map((record) => this.view(record, viewer)),
			users: this.senders(page, viewer),
			chats: [...new Set(page.map((record) => num(record.message.chatId)))].map((id) => this.wireChat(id, viewer)),
			nextCursor: end < hits.length ? String(end) : "",
		};
	}

	/** Expected client view of a chat's messages, for assertions. */
	expectedMessages(chatId: number, viewer: number): Message[] {
		return this.visibleMessages(chatId, viewer).map((record) => toMessage(this.view(record, viewer)));
	}

	dialog(chatId: number, viewer: number): WireDialog {
		const chat = this.chat(chatId);
		const messages = this.visibleMessages(chatId, viewer);
		const read = this.reads(viewer, chatId);
		const unread = messages.filter((r) => !r.deleted && r.sender !== viewer && num(r.message.seq) > read.inbox).length;
		const pinned = messages.filter((r) => !r.deleted && chat.pins.has(num(r.message.seq)));
		return create(DialogSchema, {
			chatId: big(chatId),
			topSeq: big(messages.length === 0 ? 0 : num(messages[messages.length - 1]?.message.seq ?? 0n)),
			readInboxMaxSeq: big(read.inbox),
			readOutboxMaxSeq: big(read.outbox),
			unreadCount: unread,
			chatPts: big(chat.syncMode === SyncMode.LARGE ? chat.chatPts : 0),
			muteUntil: big(this.user(viewer).mutes.get(chatId) ?? 0),
			pinned: this.user(viewer).pins.includes(chatId),
			pinnedMessageCount: pinned.length,
			pinnedMessageSeq: pinned[pinned.length - 1]?.message.seq ?? 0n,
			unreadMark: this.user(viewer).unreadMarks.has(chatId),
		});
	}

	memberChats(viewer: number): number[] {
		return [...this.chats.values()].filter((c) => c.members.has(viewer)).map((c) => c.id);
	}

	/** Newest pinned message of the chat (0 = none). */
	pinnedSeq(chatId: number): number {
		return Math.max(0, ...this.chat(chatId).pins);
	}

	userPts(userId: number): number {
		return this.user(userId).pts;
	}

	chatPtsOf(chatId: number): number {
		return this.chat(chatId).chatPts;
	}

	messageSeqs(chatId: number): number[] {
		return [...this.chat(chatId).messages.values()].filter((r) => !r.deleted).map((r) => num(r.message.seq));
	}

	// ------------------------------------------------------- update logs

	private countFor(userId: number): void {
		this.updatesFor.set(userId, (this.updatesFor.get(userId) ?? 0) + 1);
	}

	/** Appends to a user's own log and pushes it to their sockets. */
	private pushUser(userId: number, kind: UpdateKind, chatIdForEntities: number): void {
		const user = this.user(userId);
		user.pts += 1;
		const update = create(UpdateSchema, {
			pts: big(user.pts),
			ptsCount: 1,
			serverEpoch: big(this.epoch),
			date: big(this.now()),
			kind,
		});
		user.log.push({ pts: user.pts, update });
		this.countFor(userId);
		for (const session of this.sessions) {
			if (session.userId === userId) this.sendUpdates(session, [update], chatIdForEntities, true);
		}
	}

	/** Writes one event of a chat: per member (small) or into the chat log (large). */
	private pushChat(chatId: number, build: (viewer: number) => UpdateKind): void {
		const chat = this.chat(chatId);
		if (chat.syncMode === SyncMode.SMALL) {
			for (const member of chat.members) this.pushUser(member, build(member), chatId);
			return;
		}
		chat.chatPts += 1;
		const update = create(UpdateSchema, {
			chatPts: big(chat.chatPts),
			chatPtsCount: 1,
			chatId: big(chatId),
			serverEpoch: big(this.epoch),
			date: big(this.now()),
			kind: build(0),
		});
		chat.log.push({ pts: chat.chatPts, update });
		for (const member of chat.members) {
			chat.activity.set(member, this.user(member).pts);
			this.countFor(member);
		}
		const topSeq = chat.nextSeq - 1;
		for (const session of this.sessions) {
			if (!chat.members.has(session.userId)) continue;
			if (session.openChat === chatId || session.visible.has(chatId)) {
				this.sendUpdates(session, [update], chatId, true);
			} else {
				const hint = create(UpdateSchema, {
					chatId: big(chatId),
					serverEpoch: big(this.epoch),
					kind: {
						case: "chatActivity",
						value: { chatId: big(chatId), chatPts: big(chat.chatPts), topSeq: big(topSeq) },
					},
				});
				this.sendUpdates(session, [hint], chatId, true);
			}
		}
	}

	// ---------------------------------------------------------- mutations

	sendMessage(
		from: number,
		chatId: number,
		text: string,
		randomId = 0,
		extra: { readonly media?: WireMediaRef; readonly groupedId?: bigint; readonly replyToSeq?: bigint } = {},
	): { seq: number; ack: WireSyncAck } {
		const chat = this.chat(chatId);
		if (!chat.members.has(from)) throw new ConnectError("not a member", Code.PermissionDenied);
		const sender = this.user(from);
		if (randomId !== 0) {
			const previous = sender.sent.get(randomId);
			if (previous !== undefined) return { seq: previous.seq, ack: previous.ack };
		}
		const seq = chat.nextSeq++;
		const record: MessageRecord = {
			message: create(MessageSchema, {
				chatId: big(chatId),
				seq: big(seq),
				fromId: big(from),
				date: big(this.now()),
				text,
				...extra,
			}),
			deleted: false,
			reactors: new Map(),
			sender: from,
			randomId,
		};
		chat.messages.set(seq, record);
		this.pushChat(chatId, (viewer) => ({ case: "messageNew", value: { message: this.view(record, viewer) } }));
		const ack = this.ackFor(from, chatId);
		if (randomId !== 0) sender.sent.set(randomId, { chatId, seq, ack });
		return { seq, ack };
	}

	/** An incoming webhook message: from_id 0 under its label, optionally silent with URL buttons. */
	postIntegration(
		chatId: number,
		label: string,
		text: string,
		options: { silent?: boolean; buttons?: readonly (readonly { text: string; url: string }[])[] } = {},
	): number {
		const chat = this.chat(chatId);
		const seq = chat.nextSeq++;
		const rows = (options.buttons ?? []).map((row) => ({
			buttons: row.map((b) => ({ text: b.text, action: { case: "url" as const, value: b.url } })),
		}));
		const record: MessageRecord = {
			message: create(MessageSchema, {
				chatId: big(chatId),
				seq: big(seq),
				date: big(this.now()),
				text,
				integrationLabel: label,
				silent: options.silent ?? false,
				replyMarkup: rows.length === 0 ? undefined : { kind: { case: "inlineKeyboard", value: { rows } } },
			}),
			deleted: false,
			reactors: new Map(),
			sender: 0,
			randomId: 0,
		};
		chat.messages.set(seq, record);
		this.pushChat(chatId, (viewer) => ({ case: "messageNew", value: { message: this.view(record, viewer) } }));
		return seq;
	}

	/** A service message (system line) in the chat from `from`; 0 for the server itself. */
	postService(chatId: number, from: number, action: MessageInitShape<typeof MessageActionSchema>): number {
		const chat = this.chat(chatId);
		const seq = chat.nextSeq++;
		const record: MessageRecord = {
			message: create(MessageSchema, { chatId: big(chatId), seq: big(seq), fromId: big(from), date: big(this.now()), action }),
			deleted: false,
			reactors: new Map(),
			sender: from,
			randomId: 0,
		};
		chat.messages.set(seq, record);
		this.pushChat(chatId, (viewer) => ({ case: "messageNew", value: { message: this.view(record, viewer) } }));
		return seq;
	}

	/** Updates an integration alert in place; notify when its state changed. */
	editIntegration(chatId: number, seq: number, text: string, notify: boolean): void {
		const record = this.record(chatId, seq);
		record.message = create(MessageSchema, {
			...record.message,
			text,
			editVersion: record.message.editVersion + 1,
			editDate: big(this.now()),
		});
		this.pushChat(chatId, (viewer) => ({ case: "messageEdit", value: { message: this.view(record, viewer), notify } }));
	}

	private ackFor(userId: number, chatId: number): WireSyncAck {
		const chat = this.chat(chatId);
		if (chat.syncMode === SyncMode.LARGE) {
			return create(SyncAckSchema, { chatPts: big(chat.chatPts), chatPtsCount: 1, serverEpoch: big(this.epoch) });
		}
		return create(SyncAckSchema, { pts: big(this.user(userId).pts), ptsCount: 1, serverEpoch: big(this.epoch) });
	}

	private record(chatId: number, seq: number): MessageRecord {
		const record = this.chat(chatId).messages.get(seq);
		if (record === undefined || record.deleted) throw new ConnectError(`message ${chatId}/${seq}`, Code.NotFound);
		return record;
	}

	editMessage(userId: number, chatId: number, seq: number, text: string): WireSyncAck {
		const record = this.record(chatId, seq);
		if (record.sender !== userId) throw new ConnectError("not the author", Code.PermissionDenied);
		record.message = create(MessageSchema, {
			...record.message,
			text,
			editVersion: record.message.editVersion + 1,
			editDate: big(this.now()),
		});
		this.pushChat(chatId, (viewer) => ({ case: "messageEdit", value: { message: this.view(record, viewer) } }));
		return this.ackFor(userId, chatId);
	}

	/** Recalls messages: they stay as placeholders; their pins go. */
	deleteMessages(userId: number, chatId: number, seqs: readonly number[]): WireSyncAck {
		const chat = this.chat(chatId);
		for (const seq of seqs) {
			const record = this.record(chatId, seq);
			record.deleted = true;
			record.reactors.clear();
		}
		this.pushChat(chatId, () => ({
			case: "messageDelete",
			value: { chatId: big(chatId), seqs: seqs.map(big), recalled: true },
		}));
		const ack = this.ackFor(userId, chatId);
		for (const seq of seqs) {
			if (chat.pins.delete(seq)) {
				this.pushChat(chatId, () => ({ case: "pin", value: { chatId: big(chatId), seq: big(seq), pinned: false } }));
			}
		}
		return ack;
	}

	hideMessages(userId: number, chatId: number, seqs: readonly number[]): WireSyncAck {
		const user = this.user(userId);
		for (const seq of seqs) user.hidden.add(`${chatId}:${seq}`);
		this.pushUser(userId, { case: "messageHidden", value: { chatId: big(chatId), seqs: seqs.map(big) } }, chatId);
		return create(SyncAckSchema, { pts: big(user.pts), ptsCount: 1, serverEpoch: big(this.epoch) });
	}

	react(userId: number, chatId: number, seq: number, emoji: string): void {
		const record = this.record(chatId, seq);
		for (const users of record.reactors.values()) users.delete(userId);
		let users = record.reactors.get(emoji);
		if (users === undefined) {
			users = new Set();
			record.reactors.set(emoji, users);
		}
		users.add(userId);
		this.pushChat(chatId, (viewer) => ({
			case: "reaction",
			value: { chatId: big(chatId), seq: big(seq), reactions: this.view(record, viewer).reactions },
		}));
	}

	readHistory(userId: number, chatId: number, maxSeq: number): WireSyncAck {
		const chat = this.chat(chatId);
		const read = this.reads(userId, chatId);
		read.inbox = Math.max(read.inbox, maxSeq);
		// Reading clears a "marked as unread".
		if (this.user(userId).unreadMarks.has(chatId)) this.markUnread(userId, chatId, false);
		const unread = this.visibleMessages(chatId, userId).filter(
			(r) => !r.deleted && r.sender !== userId && num(r.message.seq) > read.inbox,
		).length;
		this.pushUser(
			userId,
			{
				case: "read",
				value: {
					chatId: big(chatId),
					maxSeq: big(read.inbox),
					outbox: false,
					unreadCount: unread,
					// The count covers every message up to the chat's newest seq,
					// with the large chat's log at chatPts.
					topSeq: big(chat.nextSeq - 1),
					chatPts: big(chat.syncMode === SyncMode.LARGE ? chat.chatPts : 0),
				},
			},
			chatId,
		);
		const ack = create(SyncAckSchema, { pts: big(this.user(userId).pts), ptsCount: 1, serverEpoch: big(this.epoch) });
		if (chat.syncMode === SyncMode.SMALL) {
			for (const member of chat.members) {
				if (member === userId) continue;
				const theirs = this.reads(member, chatId);
				if (theirs.outbox >= maxSeq) continue;
				theirs.outbox = maxSeq;
				this.pushUser(
					member,
					{ case: "read", value: { chatId: big(chatId), maxSeq: big(maxSeq), outbox: true } },
					chatId,
				);
			}
		}
		return ack;
	}

	/** Pins one more message, or unpins one. */
	pin(chatId: number, seq: number, pinned: boolean): void {
		const chat = this.chat(chatId);
		if (pinned) chat.pins.add(seq);
		else chat.pins.delete(seq);
		this.pushChat(chatId, () => ({ case: "pin", value: { chatId: big(chatId), seq: big(seq), pinned } }));
	}

	/** Unpins every pinned message of the chat with one update. */
	unpinAll(chatId: number): void {
		const chat = this.chat(chatId);
		const seqs = [...chat.pins].sort((a, b) => a - b);
		if (seqs.length === 0) return;
		chat.pins.clear();
		this.pushChat(chatId, () => ({ case: "pin", value: { chatId: big(chatId), seqs: seqs.map(big), pinned: false } }));
	}

	/** The user marked a chat as unread (or cleared the mark) on some session. */
	markUnread(userId: number, chatId: number, unread: boolean): void {
		const user = this.user(userId);
		if (unread) user.unreadMarks.add(chatId);
		else user.unreadMarks.delete(chatId);
		this.pushUser(userId, { case: "dialogUnreadMark", value: { chatId: big(chatId), unread } }, chatId);
	}

	/** The user changed notification settings on some session. */
	setNotify(userId: number, change: NotifyChange): WireNotificationSettings {
		const user = this.user(userId);
		user.notify = create(NotificationSettingsSchema, { ...user.notify, ...change });
		this.pushUser(userId, { case: "notificationSettings", value: { settings: user.notify } }, 0);
		return user.notify;
	}

	notifySettings(userId: number): WireNotificationSettings {
		return this.user(userId).notify;
	}

	addMember(chatId: number, userId: number, inviter: number): void {
		const chat = this.chat(chatId);
		chat.members.add(userId);
		this.reads(userId, chatId);
		this.pushChat(chatId, () => ({
			case: "memberAdded",
			value: { chatId: big(chatId), userIds: [big(userId)], inviterId: big(inviter) },
		}));
		if (chat.syncMode === SyncMode.LARGE) {
			this.pushUser(
				userId,
				{ case: "memberAdded", value: { chatId: big(chatId), userIds: [big(userId)], inviterId: big(inviter) } },
				chatId,
			);
		}
	}

	removeMember(chatId: number, userId: number, actor: number): void {
		const chat = this.chat(chatId);
		const kind: UpdateKind = {
			case: "memberRemoved",
			value: { chatId: big(chatId), userId: big(userId), actorId: big(actor) },
		};
		if (chat.syncMode === SyncMode.LARGE) this.pushUser(userId, kind, chatId);
		this.pushChat(chatId, () => kind);
		chat.members.delete(userId);
	}

	/** Ends a membership without writing member_removed anywhere (an update the client missed). */
	dropMemberSilently(chatId: number, userId: number): void {
		this.chat(chatId).members.delete(userId);
	}

	/** The user muted (until > 0) or unmuted a chat on another session. */
	muteDialog(userId: number, chatId: number, until: number): void {
		const user = this.user(userId);
		if (until > 0) user.mutes.set(chatId, until);
		else user.mutes.delete(chatId);
		this.pushUser(userId, { case: "dialogMute", value: { chatId: big(chatId), muteUntil: big(until) } }, chatId);
	}

	/** The user's pinned chats changed on another session. */
	pinDialogs(userId: number, chatIds: readonly number[]): void {
		this.user(userId).pins = [...chatIds];
		this.pushUser(userId, { case: "pinnedDialogs", value: { chatIds: chatIds.map(big) } }, 0);
	}

	/** The owner deleted the chat for every member. */
	deleteChat(chatId: number): void {
		const chat = this.chat(chatId);
		for (const member of chat.members) {
			this.pushUser(member, { case: "chatDeleted", value: { chatId: big(chatId), forEveryone: true } }, 0);
		}
		this.chats.delete(chatId);
	}

	/** One-way switch to sync_mode=large (ADR 0002). */
	switchToLarge(chatId: number): void {
		const chat = this.chat(chatId);
		chat.syncMode = SyncMode.LARGE;
		for (const member of chat.members) {
			this.pushUser(
				member,
				{
					case: "chatModeChanged",
					value: { chatId: big(chatId), syncMode: SyncMode.LARGE, chatPts: big(chat.chatPts) },
				},
				chatId,
			);
		}
	}

	/** Log retention passed: every older position answers too_long. */
	truncateLogs(): void {
		for (const user of this.users.values()) {
			user.log = [];
			user.logMin = user.pts;
		}
		for (const chat of this.chats.values()) {
			chat.log = [];
			chat.logMin = chat.chatPts;
		}
	}

	/**
	 * Database restored from backup: the newest `lostMessages` messages of
	 * `chatId` are gone, seqs and pts rewind, server_epoch increases and
	 * every socket gets ResyncFrame(EPOCH_CHANGED).
	 */
	restoreWithNewEpoch(chatId: number, lostMessages: number): void {
		const chat = this.chat(chatId);
		for (let i = 0; i < lostMessages; i++) {
			const seq = chat.nextSeq - 1;
			chat.messages.delete(seq);
			chat.nextSeq = seq;
		}
		this.epoch += 1;
		for (const user of this.users.values()) {
			user.pts = Math.max(0, user.pts - lostMessages);
			user.log = [];
			user.logMin = user.pts;
		}
		for (const session of [...this.sessions]) {
			this.sendFrame(session, { case: "resync", value: { reason: ResyncReason.EPOCH_CHANGED } }, false);
			this.closeSession(session);
		}
	}

	revokeSessions(userId: number): void {
		this.user(userId).revoked = true;
		for (const session of [...this.sessions]) {
			if (session.userId !== userId) continue;
			this.sendFrame(
				session,
				{ case: "sessionRevoked", value: { reason: SessionRevokeReason.REVOKED_BY_USER } },
				false,
			);
			this.closeSession(session);
		}
	}

	/** Cuts every socket (network blip). */
	dropConnections(): void {
		for (const session of [...this.sessions]) this.closeSession(session);
	}

	// ----------------------------------------------------------- realtime

	socketFactory(userId: number): SocketFactory {
		return (_url, handlers) => {
			const session: Session = {
				id: this.nextSessionId++,
				userId,
				handlers,
				open: true,
				openChat: 0,
				visible: new Set(),
			};
			const socket: Socket = {
				send: (data) => {
					if (session.open) this.receive(session, data);
				},
				close: () => {
					if (!session.open) return;
					this.closeSession(session);
				},
			};
			setTimeout(() => {
				if (!session.open) return;
				if (!this.online || this.user(userId).revoked) {
					this.closeSession(session);
					return;
				}
				this.sessions.add(session);
				handlers.onOpen();
			}, this.network.latencyMs);
			return socket;
		};
	}

	sessionCount(userId: number): number {
		return [...this.sessions].filter((s) => s.userId === userId).length;
	}

	private closeSession(session: Session): void {
		if (!session.open) return;
		session.open = false;
		this.sessions.delete(session);
		setTimeout(() => session.handlers.onClose(1006, ""), this.network.latencyMs);
	}

	private receive(session: Session, data: Uint8Array): void {
		const frame = fromBinary(ClientFrameSchema, data).frame;
		switch (frame.case) {
			case "hello":
				this.sendFrame(
					session,
					{
						case: "hello",
						value: {
							userId: big(session.userId),
							sessionId: big(session.id),
							serverEpoch: big(this.epoch),
							heartbeatIntervalMs: this.heartbeatMs,
							serverTime: big(this.now()),
						},
					},
					false,
				);
				return;
			case "ping":
				this.sendFrame(session, { case: "pong", value: { requestId: 0n } }, false);
				return;
			case "openChat":
				session.openChat = num(frame.value.chatId);
				session.visible = new Set(frame.value.visibleChatIds.map(num));
				return;
			default:
				return;
		}
	}

	/**
	 * Sends updates with the entities of `chatId`; 0 (or a chat that is gone)
	 * for per-user updates that name no chat, which carry the user only.
	 */
	private sendUpdates(session: Session, updates: WireUpdate[], chatId: number, lossy: boolean): void {
		const entities = this.entitiesForChats(session.userId, chatId === 0 ? [] : [chatId]);
		this.sendFrame(session, { case: "update", value: { updates, ...entities } }, lossy);
	}

	private sendFrame(
		session: Session,
		frame: NonNullable<MessageInitShape<typeof ServerFrameSchema>["frame"]>,
		lossy: boolean,
	): void {
		if (!session.open || this.silent) return;
		const bytes = toBinary(ServerFrameSchema, create(ServerFrameSchema, { frame }));
		if (lossy && this.rng() < this.network.lossRate) {
			this.framesLost++;
			return;
		}
		let delay = this.network.latencyMs;
		if (lossy && this.rng() < this.network.reorderRate) {
			// Held back so frames sent after it overtake it.
			this.framesReordered++;
			delay += 5 + Math.floor(this.rng() * 30);
		}
		// Frames already on the wire still arrive when the socket closes right
		// after (SessionRevoked, Resync); the close event is queued behind them.
		setTimeout(() => session.handlers.onMessage(bytes), delay);
	}

	// --------------------------------------------------------------- RPC

	private async rpc<T>(userId: number, method: string, run: () => T): Promise<T> {
		await Promise.resolve();
		this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
		if (!this.online) throw new ConnectError("offline", Code.Unavailable);
		if (this.user(userId).revoked) throw new ConnectError("session revoked", Code.Unauthenticated);
		const fault = this.faults.find((f) => f.method === method && f.remaining > 0);
		if (fault !== undefined) fault.remaining--;
		if (fault?.when === "before") throw new ConnectError(`injected ${method}`, fault.code);
		const result = run();
		if (fault?.when === "after") throw new ConnectError(`injected lost response ${method}`, fault.code);
		return result;
	}

	/**
	 * The authors of a page of messages, as the server lists them: messages of
	 * incoming webhooks and server service messages come from user 0, which is
	 * never listed.
	 */
	private senders(page: readonly MessageRecord[], viewer: number): WireUser[] {
		const ids = new Set(page.map((r) => r.sender));
		ids.delete(0);
		return [...ids].map((id) => this.wireUser(id, viewer));
	}

	private entities(viewer: number, updates: readonly WireUpdate[]): { users: WireUser[]; chats: WireChat[] } {
		const chatIds = new Set<number>();
		for (const update of updates) {
			const k = update.kind;
			if (k.case === "messageNew" || k.case === "messageEdit") chatIds.add(num(k.value.message?.chatId ?? 0n));
			else if (k.value !== undefined && "chatId" in k.value) chatIds.add(num(k.value.chatId));
		}
		chatIds.delete(0);
		return this.entitiesForChats(viewer, chatIds);
	}

	private entitiesForChats(viewer: number, chatIds: Iterable<number>): { users: WireUser[]; chats: WireChat[] } {
		const ids = [...new Set(chatIds)].filter((id) => this.chats.has(id));
		const userIds = new Set<number>([viewer]);
		for (const chatId of ids) {
			const chat = this.chats.get(chatId);
			if (chat === undefined) continue;
			for (const member of chat.members) userIds.add(member);
			// Incoming webhook messages have no sender (from_id 0).
			for (const record of chat.messages.values()) if (record.sender !== 0) userIds.add(record.sender);
		}
		return {
			users: [...userIds].map((id) => this.wireUser(id, viewer)),
			chats: ids.map((id) => this.wireChat(id, viewer)),
		};
	}

	apiFor(userId: number): RemoteApi {
		const state = (): MessageInitShape<typeof GetStateResponseSchema>["state"] => ({
			pts: big(this.user(userId).pts),
			serverEpoch: big(this.epoch),
			date: big(this.now()),
		});
		return {
			updates: {
				getState: () => this.rpc(userId, "getState", () => create(GetStateResponseSchema, { state: state() })),
				getDifference: (request) =>
					this.rpc(userId, "getDifference", () => {
						const user = this.user(userId);
						const pts = num(request.pts ?? 0n);
						if (num(request.serverEpoch ?? 0n) !== this.epoch || pts < user.logMin || pts > user.pts) {
							return create(GetDifferenceResponseSchema, { state: state(), result: { case: "tooLong", value: {} } });
						}
						const limit = request.limit !== undefined && request.limit > 0 ? request.limit : 1000;
						const entries = user.log.filter((e) => e.pts > pts);
						const page = entries.slice(0, limit);
						const largeChats = [...this.chats.values()]
							.filter((c) => c.members.has(userId) && c.syncMode === SyncMode.LARGE && (c.activity.get(userId) ?? -1) >= pts)
							.map((c) =>
								create(LargeChatStateSchema, { chatId: big(c.id), chatPts: big(c.chatPts), topSeq: big(c.nextSeq - 1) }),
							);
						if (page.length === 0 && largeChats.length === 0) {
							return create(GetDifferenceResponseSchema, { state: state(), result: { case: "empty", value: {} } });
						}
						const slice = entries.length > limit;
						const updates = page.map((e) => e.update);
						const last = page[page.length - 1]?.pts ?? user.pts;
						return create(GetDifferenceResponseSchema, {
							state: { ...state(), pts: big(slice ? last : user.pts) },
							result: {
								case: slice ? "slice" : "full",
								value: { updates, ...this.entities(userId, updates), largeChats },
							},
						});
					}),
				getChatDifference: (request) =>
					this.rpc(userId, "getChatDifference", () => {
						const chatId = num(request.chatId ?? 0n);
						const chat = this.chat(chatId);
						if (!chat.members.has(userId)) throw new ConnectError("not a member", Code.PermissionDenied);
						const chatState = { chatId: big(chatId), chatPts: big(chat.chatPts), serverEpoch: big(this.epoch) };
						const from = num(request.chatPts ?? 0n);
						if (num(request.serverEpoch ?? 0n) !== this.epoch || from < chat.logMin || from > chat.chatPts) {
							return create(GetChatDifferenceResponseSchema, { state: chatState, result: { case: "tooLong", value: {} } });
						}
						const limit = request.limit !== undefined && request.limit > 0 ? request.limit : 1000;
						const entries = chat.log.filter((e) => e.pts > from);
						if (entries.length === 0) {
							return create(GetChatDifferenceResponseSchema, { state: chatState, result: { case: "empty", value: {} } });
						}
						const page = entries.slice(0, limit);
						const slice = entries.length > limit;
						const updates = page.map((e) => e.update);
						return create(GetChatDifferenceResponseSchema, {
							state: { ...chatState, chatPts: big(slice ? (page[page.length - 1]?.pts ?? 0) : chat.chatPts) },
							result: { case: slice ? "slice" : "full", value: { updates, ...this.entities(userId, updates) } },
						});
					}),
			},
			chats: {
				getDialogs: (request) =>
					this.rpc(userId, "getDialogs", () => {
						const ids = this.memberChats(userId);
						const dialogs = ids.map((id) => this.dialog(id, userId));
						dialogs.sort((a, b) => num(b.topSeq) - num(a.topSeq) || num(b.chatId) - num(a.chatId));
						const offset = request.cursor === undefined || request.cursor === "" ? 0 : Number(request.cursor);
						const limit = request.limit !== undefined && request.limit > 0 ? request.limit : 100;
						const page = dialogs.slice(offset, offset + limit);
						const messages = page.flatMap((d) => {
							const record = this.chat(num(d.chatId)).messages.get(num(d.topSeq));
							return record === undefined || num(d.topSeq) === 0 ? [] : [this.view(record, userId)];
						});
						const entities = this.entitiesForChats(
							userId,
							page.map((d) => num(d.chatId)),
						);
						return create(GetDialogsResponseSchema, {
							dialogs: page,
							messages,
							...entities,
							nextCursor: offset + limit < dialogs.length ? String(offset + limit) : "",
							pinnedChatIds: offset === 0 ? this.user(userId).pins.map(big) : [],
						});
					}),
				getPeerDialogs: (request) =>
					this.rpc(userId, "getPeerDialogs", () => {
						const ids = (request.chatIds ?? []).map(num).filter((id) => this.chats.get(id)?.members.has(userId) === true);
						const dialogs = ids.map((id) => this.dialog(id, userId));
						const messages = dialogs.flatMap((d) => {
							const record = this.chat(num(d.chatId)).messages.get(num(d.topSeq));
							return record === undefined || num(d.topSeq) === 0 ? [] : [this.view(record, userId)];
						});
						return create(GetPeerDialogsResponseSchema, { dialogs, messages, ...this.entitiesForChats(userId, ids) });
					}),
				getChat: (request) =>
					this.rpc(userId, "getChat", () =>
						create(GetChatResponseSchema, {
							chat: this.wireChat(num(request.chatId ?? 0n), userId),
							users: [...this.chat(num(request.chatId ?? 0n)).members].map((id) => this.wireUser(id, userId)),
								}),
							),
						setDialogUnreadMark: (request) =>
							this.rpc(userId, "setDialogUnreadMark", () => {
								const chatId = num(request.chatId ?? 0n);
								if (!this.chat(chatId).members.has(userId)) throw new ConnectError("not a member", Code.NotFound);
								const unread = request.unread === true;
								if (this.user(userId).unreadMarks.has(chatId) === unread) {
									return create(SetDialogUnreadMarkResponseSchema, { ack: { serverEpoch: big(this.epoch) } });
								}
								this.markUnread(userId, chatId, unread);
								return create(SetDialogUnreadMarkResponseSchema, {
									ack: { pts: big(this.user(userId).pts), ptsCount: 1, serverEpoch: big(this.epoch) },
								});
							}),
						getChatOnlineCount: (request) =>
							this.rpc(userId, "getChatOnlineCount", () => {
								const chat = this.chat(num(request.chatId ?? 0n));
								if (!chat.members.has(userId)) throw new ConnectError("not a member", Code.NotFound);
								const online = new Set([...this.sessions].map((s) => s.userId).filter((id) => chat.members.has(id)));
								return create(GetChatOnlineCountResponseSchema, { onlineCount: online.size });
							}),
						getNotificationSettings: () =>
							this.rpc(userId, "getNotificationSettings", () =>
								create(GetNotificationSettingsResponseSchema, { settings: this.user(userId).notify }),
							),
						setNotificationSettings: (request) =>
							this.rpc(userId, "setNotificationSettings", () => {
								const change: NotifyChange = {};
								for (const key of [
									"privateEnabled",
									"privatePreview",
									"groupsEnabled",
									"groupsPreview",
									"channelsEnabled",
									"channelsPreview",
									"badgeMuted",
								] as const) {
									const value = request[key];
									if (value !== undefined) change[key] = value;
								}
								if (request.sound !== undefined) change.sound = request.sound;
								const settings = this.setNotify(userId, change);
								return create(SetNotificationSettingsResponseSchema, {
									settings,
									ack: { pts: big(this.user(userId).pts), ptsCount: 1, serverEpoch: big(this.epoch) },
								});
							}),
					},
			...(this.media === null ? {} : { media: this.media.apiFor(userId) }),
			messages: {
				sendMedia: (request) =>
					this.rpc(userId, "sendMedia", () => {
						const media = this.media;
						if (media === null) throw new ConnectError("no media", Code.Unimplemented);
						const chatId = num(request.chatId ?? 0n);
						const file = media.file(request.fileId ?? "");
						const { seq, ack } = this.sendMessage(userId, chatId, request.text ?? "", num(request.randomId ?? 0n), {
							media: file,
							replyToSeq: request.replyToSeq ?? 0n,
						});
						return create(SendMediaResponseSchema, { message: this.view(this.record(chatId, seq), userId), ack });
					}),
				sendAlbum: (request) =>
					this.rpc(userId, "sendAlbum", () => {
						const media = this.media;
						if (media === null) throw new ConnectError("no media", Code.Unimplemented);
						const chatId = num(request.chatId ?? 0n);
						const items = request.items ?? [];
						if (items.length < 2) throw new ConnectError("album too small", Code.InvalidArgument);
						const files = items.map((item) => media.file(item.fileId ?? ""));
						const groupedId = big(this.nextGroupedId++);
						let ack: WireSyncAck | undefined;
						const seqs = items.map((item, index) => {
							const file = files[index];
							const sent = this.sendMessage(userId, chatId, item.text ?? "", num(item.randomId ?? 0n), {
								...(file === undefined ? {} : { media: file }),
								groupedId,
							});
							ack = sent.ack;
							return sent.seq;
						});
						return create(SendAlbumResponseSchema, {
							messages: seqs.map((seq) => this.view(this.record(chatId, seq), userId)),
							...(ack === undefined ? {} : { ack }),
						});
					}),
				sendMessage: (request) =>
					this.rpc(userId, "sendMessage", () => {
						const chatId = num(request.chatId ?? 0n);
						const { seq, ack } = this.sendMessage(userId, chatId, request.text ?? "", num(request.randomId ?? 0n));
						return create(SendMessageResponseSchema, {
							message: this.view(this.record(chatId, seq), userId),
							ack,
						});
					}),
				editMessage: (request) =>
					this.rpc(userId, "editMessage", () => {
						const chatId = num(request.chatId ?? 0n);
						const seq = num(request.seq ?? 0n);
						const ack = this.editMessage(userId, chatId, seq, request.text ?? "");
						return create(EditMessageResponseSchema, { message: this.view(this.record(chatId, seq), userId), ack });
					}),
				deleteMessages: (request) =>
					this.rpc(userId, "deleteMessages", () => {
						const chatId = num(request.chatId ?? 0n);
						const seqs = (request.seqs ?? []).map(num);
						const ack =
							request.forEveryone === true
								? this.deleteMessages(userId, chatId, seqs)
								: this.hideMessages(userId, chatId, seqs);
						return create(DeleteMessagesResponseSchema, { ack });
					}),
				readHistory: (request) =>
					this.rpc(userId, "readHistory", () =>
						create(ReadHistoryResponseSchema, {
							ack: this.readHistory(userId, num(request.chatId ?? 0n), num(request.maxSeq ?? 0n)),
						}),
					),
				getHistory: (request) =>
					this.rpc(userId, "getHistory", () => {
						const chatId = num(request.chatId ?? 0n);
						if (!this.chat(chatId).members.has(userId)) throw new ConnectError("not a member", Code.PermissionDenied);
						const all = this.visibleMessages(chatId, userId);
						const offset = num(request.offsetSeq ?? 0n);
						const limit = request.limit !== undefined && request.limit > 0 ? request.limit : 50;
						let page: MessageRecord[];
						switch (request.direction) {
							case HistoryDirection.NEWER:
								page = all.filter((r) => num(r.message.seq) > offset).slice(0, limit);
								break;
							case HistoryDirection.AROUND: {
								const half = Math.ceil(limit / 2);
								const before = all.filter((r) => num(r.message.seq) <= offset).slice(-half);
								const after = all.filter((r) => num(r.message.seq) > offset).slice(0, limit - half);
								page = [...before, ...after];
								break;
							}
							default:
								page = all.filter((r) => offset === 0 || num(r.message.seq) < offset).slice(-limit);
						}
						const first = page[0] === undefined ? undefined : num(page[0].message.seq);
						const last = page.length === 0 ? undefined : num(page[page.length - 1]?.message.seq ?? 0n);
						const seqs = all.map((r) => num(r.message.seq));
						const pivot = first ?? (request.direction === HistoryDirection.NEWER ? offset + 1 : offset);
						return create(GetHistoryResponseSchema, {
							messages: page.map((r) => this.view(r, userId)),
							users: this.senders(page, userId),
							hasOlder: seqs.some((s) => s < pivot),
							hasNewer: seqs.some((s) => s > (last ?? (offset === 0 ? Number.MAX_SAFE_INTEGER : offset - 1))),
						});
					}),
				getPinnedMessages: (request) =>
					this.rpc(userId, "getPinnedMessages", () => {
						const chatId = num(request.chatId ?? 0n);
						const chat = this.chat(chatId);
						if (!chat.members.has(userId)) throw new ConnectError("not a member", Code.NotFound);
						const pinned = this.visibleMessages(chatId, userId)
							.filter((r) => !r.deleted && chat.pins.has(num(r.message.seq)))
							.reverse();
						const offset = num(request.offsetSeq ?? 0n);
						const limit = request.limit !== undefined && request.limit > 0 ? request.limit : 50;
						const after = pinned.filter((r) => offset === 0 || num(r.message.seq) < offset);
						const page = after.slice(0, limit);
						return create(GetPinnedMessagesResponseSchema, {
							messages: page.map((r) => this.view(r, userId)),
							users: this.senders(page, userId),
							count: pinned.length,
							hasMore: after.length > limit,
						});
					}),
				unpinAllMessages: (request) =>
					this.rpc(userId, "unpinAllMessages", () => {
						const chatId = num(request.chatId ?? 0n);
						if (!this.chat(chatId).members.has(userId)) throw new ConnectError("not a member", Code.NotFound);
						const before = this.chat(chatId).pins.size;
						this.unpinAll(chatId);
						return create(UnpinAllMessagesResponseSchema, {
							ack: before === 0 ? { serverEpoch: big(this.epoch) } : this.ackFor(userId, chatId),
						});
					}),
			},
			search: {
				searchMessages: (request) =>
					this.rpc(userId, "searchMessages", () =>
						create(
							SearchMessagesResponseSchema,
							this.searchPage(userId, 0, request.query ?? "", request.cursor ?? "", request.limit ?? 0, request.filter),
						),
					),
				searchChatMessages: (request) =>
					this.rpc(userId, "searchChatMessages", () => {
						const chatId = num(request.chatId ?? 0n);
						if (!this.chat(chatId).members.has(userId)) throw new ConnectError("not a member", Code.PermissionDenied);
						return create(
							SearchChatMessagesResponseSchema,
							this.searchPage(userId, chatId, request.query ?? "", request.cursor ?? "", request.limit ?? 0, request.filter),
						);
					}),
			},
			users: {
				getSelf: () => this.rpc(userId, "getSelf", () => create(GetSelfResponseSchema, { user: this.wireUser(userId, userId) })),
				getUsers: (request) =>
					this.rpc(userId, "getUsers", () =>
						create(GetUsersResponseSchema, {
							users: (request.userIds ?? []).map(num).filter((id) => this.users.has(id)).map((id) => this.wireUser(id, userId)),
						}),
					),
			},
		};
	}
}
