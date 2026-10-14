// Test and visual-harness wiring of the messaging UI: the real client core
// (startApp) against the core's in-memory protocol server, plus the Connect
// routes the UI calls directly and a fixture for the backend features that do
// not exist yet. The production ServerBackend runs on these routes; only the
// features with no RPC yet come from fixture data. Never imported by
// production code.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { startApp, type ChatCore } from "@app/core";
import { systemTimers, type NotificationRequest, type Platform, type SqlDriverFactory } from "@app/platform";
import { ChatSchema, ChatsService, ChatType, HistoryVisibility, MemberRole, type Chat as WireChat, type Dialog as WireDialog } from "@app/proto-ts/chats";
import type { InviteLink } from "@app/proto-ts/chats";
import { ConfigService } from "@app/proto-ts/config";
import { MessageSchema, MessagesService, type Message as WireMessage } from "@app/proto-ts/messages";
import { ServerFrameSchema } from "@app/proto-ts/realtime";
import type { Update as WireUpdate } from "@app/proto-ts/updates";
import { PrivacyAudience, UsersService, UserSchema, UserStatusKind, type User as WireUser } from "@app/proto-ts/users";
import { FakeServer } from "../../../../packages/core/test/support/fake-server.ts";
import type { RemoteApi } from "../../../../packages/core/src/protocol/api.ts";
import type { MessagingClient, MessagingConnector } from "../../src/messaging/data/connector.ts";
import type { BlockedUser, ModerationDetail, ModerationRow, PendingFeature } from "../../src/messaging/data/pending-backend.ts";
import type { Remote } from "../../src/messaging/data/remote.ts";
import { ServerBackend } from "../../src/messaging/data/server-backend.ts";
import type { ChatSource } from "../../src/messaging/data/source.ts";

type MessageInit = Exclude<MessageInitShape<typeof MessageSchema>, { $typeName: string }>;
type MessageExtras = Pick<
	MessageInit,
	"entities" | "replyToSeq" | "forwardFrom" | "editDate" | "editVersion" | "action" | "integrationLabel" | "topicId" | "linkPreview"
>;
type UserExtras = { isBot?: boolean; username?: string; bio?: string };
type ChatExtras = {
	myRole?: MemberRole;
	myPermissions?: number;
	defaultPermissions?: number;
	about?: string;
	historyVisibility?: HistoryVisibility;
	forum?: boolean;
};

/** Server-side state of a forum topic in the fixture. */
export interface FixtureTopic {
	id: number;
	title: string;
	iconColor: number;
	creatorId: number;
	pinned: boolean;
	closed: boolean;
	hidden: boolean;
	unreadCount: number;
}

export interface FixturePreview {
	readonly url: string;
	readonly siteName: string;
	readonly title: string;
	readonly description: string;
}

const num = (value: bigint): number => Number(value);

/** Copies the fields of `patch` onto `target` (protobuf-es messages are plain objects). */
function assign(target: object, patch: object): void {
	// Both sides are protobuf-es message objects of the same schema; field-wise copy.
	Object.assign(target as Record<string, unknown>, patch as Record<string, unknown>);
}

export class ChatFixture {
	readonly server = new FakeServer(7);
	readonly selfId: number;
	readonly selfName: string;
	readonly selfUsername: string;
	readonly names = new Map<number, string>();
	readonly members = new Map<number, number[]>();
	readonly roles = new Map<string, MemberRole>();
	readonly notifications: NotificationRequest[] = [];
	private readonly messageExtras = new Map<string, MessageExtras>();
	private readonly userExtras = new Map<number, UserExtras>();
	private readonly chatExtras = new Map<number, ChatExtras>();
	private readonly dialogExtras = new Map<number, { unreadMentionsCount: number }>();
	readonly blocked = new Set<number>();
	readonly reactions: { chatId: number; seq: number; emoji: string }[] = [];
	readonly pins: { chatId: number; seq: number; pinned: boolean }[] = [];
	readonly forwards: { from: number; seqs: number[]; to: number }[] = [];
	readonly invites: { chatId: number; expiresAt: number; usageLimit: number }[] = [];
	/** SendMessage requests from the client (the server keeps only the text). */
	readonly sent: { chatId: number; text: string; replyToSeq: number; topicId: number }[] = [];
	readonly topics = new Map<number, FixtureTopic[]>();
	private readonly messageTopics = new Map<string, number>();
	readonly previews: FixturePreview[] = [];
	readonly inviteChecks = new Map<string, { title: string; type: ChatType; memberCount: number; memberOf: number }>();
	readonly inviteLinks = new Map<number, InviteLink[]>();
	readonly readers = new Map<string, number[]>();
	readonly reports: { target: string; reason: number; comment: string }[] = [];
	/** Users whose privacy refuses being added to groups by this user. */
	readonly refusesGroups = new Set<number>();

	constructor(selfName = "Đức Thắng", selfUsername = "ductrung") {
		this.selfName = selfName;
		this.selfUsername = selfUsername;
		this.selfId = this.addUser(selfName, { username: selfUsername });
	}

	addUser(name: string, extras: UserExtras = {}): number {
		const id = this.server.addUser(name);
		this.names.set(id, name);
		this.userExtras.set(id, { username: name.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/đ/g, "d").replace(/\s+/g, ""), ...extras });
		return id;
	}

	createChat(type: ChatType, title: string, members: readonly number[], extras: ChatExtras = {}): number {
		const id = this.server.createChat(type, title, members);
		this.members.set(id, [...members]);
		this.chatExtras.set(id, { myRole: MemberRole.MEMBER, myPermissions: 0x1f, defaultPermissions: 0x1d, historyVisibility: HistoryVisibility.SHARED, ...extras });
		return id;
	}

	setRole(chatId: number, userId: number, role: MemberRole): void {
		this.roles.set(`${chatId}:${userId}`, role);
	}

	send(from: number, chatId: number, text: string, extras: MessageExtras = {}): number {
		const seq = this.peekSeq(chatId);
		if (Object.keys(extras).length > 0) this.messageExtras.set(`${chatId}:${seq}`, extras);
		if (extras.topicId !== undefined) this.messageTopics.set(`${chatId}:${seq}`, Number(extras.topicId));
		const sent = this.server.sendMessage(from, chatId, text).seq;
		if (sent !== seq) throw new Error(`fixture expected seq ${seq}, server gave ${sent}`);
		return sent;
	}

	private peekSeq(chatId: number): number {
		return Math.max(0, ...this.server.messageSeqs(chatId)) + 1;
	}

	/** Newest seq of a topic (General also holds messages sent without a topic). */
	topicTop(chatId: number, topicId: number): number {
		let top = 0;
		for (const seq of this.server.messageSeqs(chatId)) {
			const topic = this.messageTopics.get(`${chatId}:${seq}`) ?? 1;
			if (topic === topicId) top = Math.max(top, seq);
		}
		return top;
	}

	mentions(chatId: number, count: number): void {
		this.dialogExtras.set(chatId, { unreadMentionsCount: count });
	}

	// ------------------------------------------------------------- patching

	patchMessage(message: WireMessage): void {
		const extras = this.messageExtras.get(`${num(message.chatId)}:${num(message.seq)}`);
		if (extras === undefined) return;
		// create() fills every field with its default: copy only the patched ones.
		const full = create(MessageSchema, extras) as unknown as Record<string, unknown>;
		const target = message as unknown as Record<string, unknown>;
		for (const key of Object.keys(extras)) target[key] = full[key];
	}

	patchUser(user: WireUser): void {
		const extras = this.userExtras.get(num(user.id));
		if (extras !== undefined) assign(user, create(UserSchema, { ...user, ...extras, isBlocked: this.blocked.has(num(user.id)) }));
	}

	patchChat(chat: WireChat): void {
		const extras = this.chatExtras.get(num(chat.id));
		if (extras !== undefined) assign(chat, create(ChatSchema, { ...chat, ...extras }));
	}

	patchDialog(dialog: WireDialog): void {
		const extras = this.dialogExtras.get(num(dialog.chatId));
		if (extras !== undefined && dialog.unreadCount > 0) dialog.unreadMentionsCount = extras.unreadMentionsCount;
	}

	private patchUpdates(updates: readonly WireUpdate[]): void {
		for (const update of updates) {
			if (update.kind.case === "messageNew" || update.kind.case === "messageEdit") {
				const message = update.kind.value.message;
				if (message !== undefined) this.patchMessage(message);
			}
			if (update.kind.case === "chatUpdated" && update.kind.value.chat !== undefined) this.patchChat(update.kind.value.chat);
		}
	}

	/** The core's API with fixture fields (entities, replies, bot flags, roles) added. */
	api(): RemoteApi {
		const base = this.server.apiFor(this.selfId);
		const users = (list: readonly WireUser[]) => list.forEach((u) => this.patchUser(u));
		const chats = (list: readonly WireChat[]) => list.forEach((c) => this.patchChat(c));
		return {
			updates: {
				getState: (request) => base.updates.getState(request),
				getDifference: async (request) => {
					const response = await base.updates.getDifference(request);
					const result = response.result;
					if (result.case === "slice" || result.case === "full") {
						this.patchUpdates(result.value.updates);
						users(result.value.users);
						chats(result.value.chats);
					}
					return response;
				},
				getChatDifference: async (request) => {
					const response = await base.updates.getChatDifference(request);
					const result = response.result;
					if (result.case === "slice" || result.case === "full") {
						this.patchUpdates(result.value.updates);
						users(result.value.users);
						chats(result.value.chats);
					}
					return response;
				},
			},
			chats: {
				getDialogs: async (request) => {
					const response = await base.chats.getDialogs(request);
					response.messages.forEach((m) => this.patchMessage(m));
					response.dialogs.forEach((d) => this.patchDialog(d));
					users(response.users);
					chats(response.chats);
					return response;
				},
				getChat: async (request) => {
					const response = await base.chats.getChat(request);
					if (response.chat !== undefined) this.patchChat(response.chat);
					users(response.users);
					return response;
				},
			},
			messages: {
				sendMessage: (request) => {
					this.sent.push({ chatId: num(request.chatId ?? 0n), text: request.text ?? "", replyToSeq: num(request.replyToSeq ?? 0n), topicId: 0 });
					return base.messages.sendMessage(request);
				},
				editMessage: (request) => base.messages.editMessage(request),
				deleteMessages: (request) => base.messages.deleteMessages(request),
				readHistory: (request) => base.messages.readHistory(request),
				getHistory: async (request) => {
					const response = await base.messages.getHistory(request);
					response.messages.forEach((m) => this.patchMessage(m));
					users(response.users);
					return response;
				},
			},
			users: {
				getSelf: async (request) => {
					const response = await base.users.getSelf(request);
					if (response.user !== undefined) this.patchUser(response.user);
					return response;
				},
				getUsers: async (request) => {
					const response = await base.users.getUsers(request);
					users(response.users);
					return response;
				},
			},
		};
	}

	/** Realtime frames get the same fixture fields as RPC responses. */
	socket(): Platform["socket"] {
		const factory = this.server.socketFactory(this.selfId);
		return (url, handlers) =>
			factory(url, {
				...handlers,
				onMessage: (data) => {
					const frame = fromBinary(ServerFrameSchema, data);
					if (frame.frame.case === "update") {
						this.patchUpdates(frame.frame.value.updates);
						frame.frame.value.users.forEach((u) => this.patchUser(u));
						frame.frame.value.chats.forEach((c) => this.patchChat(c));
						handlers.onMessage(toBinary(ServerFrameSchema, frame));
						return;
					}
					handlers.onMessage(data);
				},
			});
	}

	wireUser(id: number): WireUser {
		const user = this.server.wireUser(id, this.selfId);
		this.patchUser(user);
		user.status = create(UserSchema, { status: { kind: id % 3 === 0 ? UserStatusKind.ONLINE : UserStatusKind.RECENTLY } }).status;
		return user;
	}

	// ------------------------------------------------------------- core

	async startCore(sql: SqlDriverFactory): Promise<ChatCore> {
		let nextRandom = 1;
		const platform: Platform = {
			sql,
			lifecycle: {
				isForeground: () => true,
				onForegroundChange: () => () => undefined,
				onOnline: () => () => undefined,
			},
			notify: {
				show: (request) => this.notifications.push(request),
				clear: () => undefined,
			},
			socket: this.socket(),
			timers: systemTimers,
			frame: (callback) => setTimeout(callback, 0),
			randomId: () => this.selfId * 1_000_000 + nextRandom++,
		};
		const result = await startApp(platform, {
			api: this.api(),
			realtimeUrl: "wss://chat.example.test/ws",
			appVersion: "test",
			client: "web",
			tenant: "chat.example.test",
			userIdHint: this.selfId,
		});
		if (result.status !== "active") throw new Error(`core did not start: ${result.reason}`);
		return result.core;
	}

	/** Connect routes for the calls the UI makes outside the core. */
	routes(router: ConnectRouter): void {
		const self = () => this.wireUser(this.selfId);
		router.service(UsersService, {
			getSelf: () => ({ user: self() }),
			getUsers: (req) => ({ users: req.userIds.map((id) => this.wireUser(num(id))) }),
			searchUsers: (req) => {
				const q = req.query.toLowerCase();
				const ids = [...this.names.keys()].filter((id) => id !== this.selfId);
				const hits = ids.filter((id) => {
					const user = this.wireUser(id);
					return q.includes("@") ? `${user.username}@hoandat.com` === q : user.username.startsWith(q.replace(/^@/, ""));
				});
				return { users: hits.map((id) => this.wireUser(id)) };
			},
			block: (req) => {
				this.blocked.add(num(req.userId));
				return {};
			},
			unblock: (req) => {
				this.blocked.delete(num(req.userId));
				return {};
			},
			report: (req) => {
				const target = req.target.case === "messages" ? `messages:${num(req.target.value.chatId)}:${req.target.value.seqs.map(num).join(",")}` : `${req.target.case ?? ""}:${String(req.target.value ?? "")}`;
				this.reports.push({ target, reason: req.reason, comment: req.comment });
				return {};
			},
			getPrivacy: () => ({
				settings: {
					lastSeen: PrivacyAudience.CONTACTS,
					profilePhoto: PrivacyAudience.EVERYONE,
					findByEmail: PrivacyAudience.NOBODY,
					findByUsername: PrivacyAudience.EVERYONE,
					addToGroups: PrivacyAudience.CONTACTS,
					sendMessages: PrivacyAudience.EVERYONE,
					notificationPreview: true,
				},
			}),
			setPrivacy: (req) => ({
				settings: {
					lastSeen: req.lastSeen ?? PrivacyAudience.CONTACTS,
					profilePhoto: req.profilePhoto ?? PrivacyAudience.EVERYONE,
					findByEmail: req.findByEmail ?? PrivacyAudience.NOBODY,
					findByUsername: req.findByUsername ?? PrivacyAudience.EVERYONE,
					addToGroups: req.addToGroups ?? PrivacyAudience.CONTACTS,
					sendMessages: req.sendMessages ?? PrivacyAudience.EVERYONE,
					notificationPreview: req.notificationPreview ?? true,
				},
			}),
		});
		router.service(ConfigService, {
			getAppConfig: () => ({ result: { case: "config", value: { hash: "t", messageLengthMax: 4096, editTimeLimitSeconds: 172_800 } } }),
		});
		router.service(MessagesService, {
			sendMessage: (req) => {
				const chatId = num(req.chatId);
				this.sent.push({ chatId, text: req.text, replyToSeq: num(req.replyToSeq), topicId: num(req.topicId) });
				this.send(this.selfId, chatId, req.text, { topicId: req.topicId === 0n ? 1n : req.topicId, replyToSeq: req.replyToSeq });
				return {};
			},
			readHistory: (req) => {
				const chatId = num(req.chatId);
				const topic = this.topics.get(chatId)?.find((t) => t.id === num(req.topicId));
				if (topic !== undefined) topic.unreadCount = 0;
				this.server.readHistory(this.selfId, chatId, num(req.maxSeq));
				return {};
			},
			getLinkPreview: (req) => {
				const preview = this.previews.find((p) => p.url === req.url);
				return preview === undefined ? {} : { preview };
			},
			getMessageReaders: (req) => {
				const ids = this.readers.get(`${num(req.chatId)}:${num(req.seq)}`);
				if (ids === undefined) throw new ConnectError("readers not available", Code.FailedPrecondition);
				return { userIds: ids.map(BigInt), users: ids.map((id) => this.wireUser(id)) };
			},
			setReaction: (req) => {
				const chatId = num(req.chatId);
				const seq = num(req.seq);
				this.reactions.push({ chatId, seq, emoji: req.emoji });
				if (req.emoji !== "") this.server.react(this.selfId, chatId, seq, req.emoji);
				return {};
			},
			pinMessage: (req) => {
				this.pins.push({ chatId: num(req.chatId), seq: num(req.seq), pinned: true });
				this.server.pin(num(req.chatId), num(req.seq), true);
				return {};
			},
			unpinMessage: (req) => {
				this.pins.push({ chatId: num(req.chatId), seq: num(req.seq), pinned: false });
				this.server.pin(num(req.chatId), num(req.seq), false);
				return {};
			},
			forwardMessages: (req) => {
				this.forwards.push({ from: num(req.fromChatId), seqs: req.seqs.map(num), to: num(req.toChatId) });
				return {};
			},
		});
		router.service(ChatsService, {
			createPrivate: (req) => {
				const userId = num(req.userId);
				const existing = [...this.members.entries()].find(
					([id, list]) => this.server.wireChat(id, this.selfId).type === ChatType.PRIVATE && list.includes(userId),
				);
				const chatId = existing?.[0] ?? this.createChat(ChatType.PRIVATE, "", [this.selfId, userId]);
				return { chat: this.server.wireChat(chatId, this.selfId) };
			},
			createGroup: (req) => {
				const chatId = this.createChat(ChatType.GROUP, req.title, [this.selfId, ...req.userIds.map(num)], { myRole: MemberRole.OWNER });
				this.send(this.selfId, chatId, "", { action: { kind: { case: "chatCreated", value: { title: req.title } } } });
				return { chat: this.server.wireChat(chatId, this.selfId), failedUserIds: [] };
			},
			createChannel: (req) => {
				const chatId = this.createChat(ChatType.CHANNEL, req.title, [this.selfId], { myRole: MemberRole.OWNER, about: req.about });
				this.send(this.selfId, chatId, "", { action: { kind: { case: "chatCreated", value: { title: req.title } } } });
				return { chat: this.server.wireChat(chatId, this.selfId) };
			},
			getMembers: (req) => {
				const chatId = num(req.chatId);
				const ids = (this.members.get(chatId) ?? []).filter((id) => {
					const q = req.query.toLowerCase();
					return q === "" || (this.names.get(id) ?? "").toLowerCase().includes(q);
				});
				return {
					members: ids.map((id) => ({
						userId: BigInt(id),
						role: this.roles.get(`${chatId}:${id}`) ?? MemberRole.MEMBER,
						permissions: 0x1f,
						joinedAt: 1_760_000_000n,
						inviterId: BigInt(ids[0] ?? 0),
					})),
					users: ids.map((id) => this.wireUser(id)),
					nextCursor: "",
				};
			},
			addMembers: (req) => {
				const chatId = num(req.chatId);
				const failed: bigint[] = [];
				for (const id of req.userIds.map(num)) {
					if (this.refusesGroups.has(id)) {
						failed.push(BigInt(id));
						continue;
					}
					this.server.addMember(chatId, id, this.selfId);
					this.members.get(chatId)?.push(id);
				}
				return { failedUserIds: failed };
			},
			leaveChat: () => ({}),
			setAdmin: (req) => {
				this.setRole(num(req.chatId), num(req.userId), req.admin ? MemberRole.ADMIN : MemberRole.MEMBER);
				return {};
			},
			updateChatInfo: (req) => ({ chat: this.server.wireChat(num(req.chatId), this.selfId) }),
			setHistoryVisibility: () => ({}),
			exportInviteLink: (req) => {
				const chatId = num(req.chatId);
				this.invites.push({ chatId, expiresAt: num(req.expiresAt), usageLimit: req.usageLimit });
				const invite = {
					$typeName: "app.v1.InviteLink" as const,
					link: `https://chat.example.test/+q7XrN2bT${this.invites.length}`,
					creatorId: BigInt(this.selfId),
					expiresAt: req.expiresAt,
					usageLimit: req.usageLimit,
					usageCount: 0,
					revoked: false,
				};
				this.inviteLinks.set(chatId, [invite, ...(this.inviteLinks.get(chatId) ?? [])]);
				return { invite };
			},
			getInviteLinks: (req) => ({ invites: this.inviteLinks.get(num(req.chatId)) ?? [] }),
			revokeInviteLink: (req) => {
				const invite = this.inviteLinks.get(num(req.chatId))?.find((i) => i.link === req.link);
				if (invite === undefined) throw new ConnectError("no such link", Code.NotFound);
				invite.revoked = true;
				return { invite };
			},
			checkInvite: (req) => {
				const token = req.link.replace(/^.*\+/, "");
				const found = this.inviteChecks.get(token);
				if (found === undefined) throw new ConnectError("invite expired", Code.NotFound);
				return {
					title: found.title,
					type: found.type,
					memberCount: found.memberCount,
					...(found.memberOf === 0 ? {} : { chat: this.server.wireChat(found.memberOf, this.selfId) }),
				};
			},
			getForumTopics: (req) => {
				const chatId = num(req.chatId);
				const list = this.topics.get(chatId) ?? [];
				const messages = this.server.expectedMessages(chatId, this.selfId);
				const sorted = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || this.topicTop(chatId, b.id) - this.topicTop(chatId, a.id));
				const tops = sorted.map((t) => messages.find((m) => m.seq === this.topicTop(chatId, t.id))).filter((m) => m !== undefined);
				return {
					topics: sorted.map((t) => ({
						chatId: BigInt(chatId),
						id: BigInt(t.id),
						title: t.title,
						iconColor: t.iconColor,
						creatorId: BigInt(t.creatorId),
						createdAt: 1_756_771_200n,
						pinned: t.pinned,
						closed: t.closed,
						hidden: t.hidden,
						topSeq: BigInt(this.topicTop(chatId, t.id)),
						readInboxMaxSeq: 0n,
						unreadCount: t.unreadCount,
					})),
					messages: tops.map((m) => ({ chatId: BigInt(chatId), seq: BigInt(m.seq), fromId: BigInt(m.fromId), date: BigInt(m.date), text: m.text })),
					users: [],
				};
			},
			editForumTopic: (req) => {
				const topic = this.topics.get(num(req.chatId))?.find((t) => t.id === num(req.topicId));
				if (topic !== undefined && req.pinned !== undefined) topic.pinned = req.pinned;
				return {};
			},
			closeForumTopic: (req) => {
				const topic = this.topics.get(num(req.chatId))?.find((t) => t.id === num(req.topicId));
				if (topic !== undefined) topic.closed = req.closed;
				return {};
			},
			hideForumTopic: (req) => {
				const topic = this.topics.get(num(req.chatId))?.find((t) => t.id === num(req.topicId));
				if (topic !== undefined) topic.hidden = req.hidden;
				return {};
			},
			joinByInvite: (req) => {
				if (req.link.includes("expired")) throw new ConnectError("invite expired", Code.NotFound);
				const chatId = [...this.members.keys()][0] ?? 0;
				return { chat: this.server.wireChat(chatId, this.selfId) };
			},
		});
	}
}

/** The in-process core seen through the same interface as the worker client. */
export function toSource(core: ChatCore): ChatSource {
	return {
		events: core.events,
		dialogs: (limit) => core.dialogs(limit),
		history: (chatId, request) => core.history(chatId, request),
		users: (ids) => core.users(ids),
		chat: (chatId) => core.chat(chatId),
		sendText: (chatId, text, options) => core.sendText(chatId, text, options),
		editText: (chatId, seq, text, entities) => core.editText(chatId, seq, text, entities),
		deleteMessages: (chatId, seqs, forEveryone) => core.deleteMessages(chatId, seqs, forEveryone),
		markRead: (chatId, maxSeq) => core.markRead(chatId, maxSeq),
		retryOutbox: (id) => core.retryOutbox(id),
		discardOutbox: (id) => core.discardOutbox(id),
		search: (query, options) => core.search(query, options),
		openChat: async (chatId, anchorSeq, visible) => core.openChat(chatId, anchorSeq, visible),
		connectionState: async () => core.connectionState(),
	};
}

/** Fixture data for the features that have no RPC yet. */
export interface FixtureBackendData {
	readonly reactors?: ReadonlyMap<string, readonly number[]>;
	readonly muted?: ReadonlySet<number>;
	readonly pinnedDialogs?: ReadonlySet<number>;
	readonly blocked?: readonly BlockedUser[];
	readonly moderation?: { readonly scope: string; readonly rows: readonly ModerationRow[]; readonly details: ReadonlyMap<string, ModerationDetail> };
}

/** The production ServerBackend plus fixture data for the features with no RPC yet. */
export class FixtureBackend extends ServerBackend {
	override readonly features = new Set<PendingFeature>([
		"topics",
		"linkPreview",
		"report",
		"invitePreview",
		"reactors",
		"mute",
		"pinnedDialogs",
		"blockedList",
		"moderation",
	]);
	private readonly muted: Set<number>;

	constructor(
		remote: Remote,
		source: ChatSource,
		private readonly data: FixtureBackendData,
	) {
		super(remote, source, "https://chat.example.test");
		this.muted = new Set(data.muted ?? []);
	}

	override reactors(chatId: number, seq: number, emoji: string): readonly number[] | null {
		return this.data.reactors?.get(`${chatId}:${seq}:${emoji}`) ?? null;
	}

	override isMuted(chatId: number): boolean {
		return this.muted.has(chatId);
	}

	override async setMuted(chatId: number, muted: boolean): Promise<void> {
		if (muted) this.muted.add(chatId);
		else this.muted.delete(chatId);
		this.emit();
	}

	override isPinnedDialog(chatId: number): boolean {
		return this.data.pinnedDialogs?.has(chatId) ?? false;
	}

	override async blockedUsers(): Promise<readonly BlockedUser[]> {
		return this.data.blocked ?? [];
	}

	override async moderationScope(): Promise<string | null> {
		return this.data.moderation?.scope ?? null;
	}

	override async moderationQueue(): Promise<readonly ModerationRow[]> {
		return this.data.moderation?.rows ?? [];
	}

	override async moderationDetail(id: string): Promise<ModerationDetail | null> {
		return this.data.moderation?.details.get(id) ?? null;
	}

	override async claimReport(): Promise<void> {}

	override async decideReport(): Promise<void> {}
}

/**
 * Connector for <App messagingConnector>: the real core on the fixture
 * server. With `data` the backend also fakes the features that have no RPC.
 */
export function fixtureConnector(fixture: ChatFixture, sql: () => Promise<SqlDriverFactory>, data?: FixtureBackendData): MessagingConnector {
	return async () => {
		const core = await fixture.startCore(await sql());
		const client: MessagingClient = {
			source: toSource(core),
			createBackend: (remote, source) =>
				data === undefined ? new ServerBackend(remote, source, "https://chat.example.test") : new FixtureBackend(remote, source, data),
			coldSnapshot: () => null,
			saveSnapshot: async () => undefined,
			signOutAndLeave: () => core.signOut(),
			dispose: () => void core.close(),
		};
		return client;
	};
}
