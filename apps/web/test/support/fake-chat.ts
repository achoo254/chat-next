// Test and visual-harness wiring of the messaging UI: the real client core
// (startApp) against the core's in-memory protocol server, plus the Connect
// routes the UI calls directly (chats, messages, users, moderation). The
// production ServerBackend and Remote run on these routes. Never imported by
// production code.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { startApp, type ChatCore } from "@app/core";
import { systemTimers, type NotificationRequest, type Platform, type SqlDriverFactory } from "@app/platform";
import {
	AddMemberFailureReason,
	ChatSchema,
	ChatsService,
	GetChatOnlineCountResponseSchema,
	ChatType,
	HistoryVisibility,
	MemberRole,
	type Chat as WireChat,
	type Dialog as WireDialog,
} from "@app/proto-ts/chats";
import type { InviteLink } from "@app/proto-ts/chats";
import { ConfigService } from "@app/proto-ts/config";
import { FeedbackService } from "@app/proto-ts/feedback";
import { EntityType, MessageSchema, MessagesService, type Message as WireMessage } from "@app/proto-ts/messages";
import { ServerFrameSchema } from "@app/proto-ts/realtime";
import type { Update as WireUpdate } from "@app/proto-ts/updates";
import {
	AnnouncementState,
	FeedbackKind,
	FeedbackSource,
	FeedbackStatus,
	ModerationAction,
	ModerationService,
	ReportStatus,
	ReportTargetKind,
} from "@app/proto-ts/moderation";
import { BotTier } from "@app/proto-ts/bot_admin";
import { PrivacyAudience, ReportReason, UsersService, UserSchema, UserStatusKind, type User as WireUser } from "@app/proto-ts/users";
import { FakeServer } from "../../../../packages/core/test/support/fake-server.ts";
import { FakeMedia, MemoryBlobs } from "../../../../packages/core/test/support/fake-media.ts";
import { MediaKind, MediaRefSchema, MediaSizeType, type MediaRef as WireMediaRef } from "@app/proto-ts/media";
import type { RemoteApi } from "../../../../packages/core/src/protocol/api.ts";
import { FakeBots } from "./fake-bots.ts";
import { FakeIntegrations } from "./fake-integrations.ts";
import { FakePush } from "./fake-push.ts";
import { FakePrivacy } from "./fake-privacy.ts";
import type { MessagingClient, MessagingConnector } from "../../src/messaging/data/connector.ts";
import { ServerBackend } from "../../src/messaging/data/server-backend.ts";
import type { ChatSource } from "../../src/messaging/data/source.ts";

type MessageInit = Exclude<MessageInitShape<typeof MessageSchema>, { $typeName: string }>;
type MessageExtras = Pick<
	MessageInit,
	| "entities"
	| "replyToSeq"
	| "forwardFrom"
	| "editDate"
	| "editVersion"
	| "action"
	| "integrationLabel"
	| "topicId"
	| "linkPreview"
	| "replyMarkup"
	| "viaBotId"
>;
type UserExtras = { isBot?: boolean; username?: string; bio?: string; name?: string; deleted?: boolean; botInlinePlaceholder?: string };
type ChatExtras = {
	myRole?: MemberRole;
	myPermissions?: number;
	defaultPermissions?: number;
	about?: string;
	historyVisibility?: HistoryVisibility;
	forum?: boolean;
	title?: string;
	photo?: WireMediaRef;
};

function photoRef(fileId: string): WireMediaRef {
	return create(MediaRefSchema, { fileId, kind: MediaKind.PHOTO });
}

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
	icon?: string;
	messageCount?: number;
	unreadMentions?: number;
}

export interface FixturePreview {
	readonly url: string;
	readonly siteName: string;
	readonly title: string;
	readonly description: string;
}

const num = (value: bigint): number => Number(value);

/** A report in the fixture's moderation queue (ModerationService). */
export interface FixtureReport {
	id: number;
	kind: ReportTargetKind;
	reporterId: number;
	targetUserId: number;
	targetChatId: number;
	seqs: number[];
	reason: ReportReason;
	comment: string;
	status: ReportStatus;
	createdAt: number;
	actions: ModerationAction[];
	note: string;
}

/** One entry of the moderation log; operatorId 0 is an automatic rule. */
export interface FixtureLogEntry {
	id: number;
	operatorId: number;
	action: ModerationAction;
	targetUserId: number;
	targetChatId: number;
	note: string;
	createdAt: number;
}

/** A bot under review (ModerationService.GetBotReview). */
export interface FixtureBotReview {
	botId: number;
	ownerId: number;
	tier: BotTier;
	verified: boolean;
	restrictedAt: number;
	restrictedReason: string;
	reviewed: boolean;
	users: number;
	blockedPermille: number;
}

/** Feedback a user sent the assistant bot (ModerationService.GetFeedback). */
export interface FixtureFeedback {
	id: number;
	userId: number;
	kind: FeedbackKind;
	text: string;
	status: FeedbackStatus;
	createdAt: number;
	handledBy: number;
	replyText: string;
	/** Settings › Góp ý or the assistant bot (default). */
	source?: FeedbackSource;
}

/** A method FakeServer always offers (optional in RemoteApi only for older doubles). */
function offered<T>(method: T | undefined, name: string): T {
	if (method === undefined) throw new Error(`FakeServer lacks ${name}`);
	return method;
}

/** Copies the fields of `patch` onto `target` (protobuf-es messages are plain objects). */
function assign(target: object, patch: object): void {
	// Both sides are protobuf-es message objects of the same schema; field-wise copy.
	Object.assign(target as Record<string, unknown>, patch as Record<string, unknown>);
}

/** A file another user sends in the fixture (MediaService keeps its bytes). */
export interface FixtureFile {
	readonly kind: "photo" | "video" | "voice" | "document" | "audio";
	readonly name?: string;
	readonly mimeType: string;
	readonly bytes: Uint8Array;
	readonly width?: number;
	readonly height?: number;
	/** Milliseconds. */
	readonly duration?: number;
	readonly inlineThumb?: Uint8Array;
	readonly waveform?: Uint8Array;
	/** Renditions the server made (photos: "s", "m", "x"). */
	readonly sizes?: readonly ("s" | "m" | "x")[];
}

const WIRE_KINDS: Record<FixtureFile["kind"], MediaKind> = {
	photo: MediaKind.PHOTO,
	video: MediaKind.VIDEO,
	voice: MediaKind.VOICE,
	document: MediaKind.DOCUMENT,
	audio: MediaKind.AUDIO,
};
const WIRE_SIZES = { s: MediaSizeType.S, m: MediaSizeType.M, x: MediaSizeType.X } as const;

/** AppConfig of a server with media off (upload_size_max 0): the composer hides attaching. */
const MEDIA_OFF_CONFIG = new FakeMedia().configApi(0, { size: 0, large: 0, ageSeconds: 0 });

export class ChatFixture {
	readonly server = new FakeServer(7);
	/** Pending upload files and the media cache of the signed-in user's client. */
	readonly blobs = new MemoryBlobs();
	/** CreateUpload requests of the signed-in user's client (the fake storage keeps no duration or waveform). */
	readonly uploadRequests: { kind: number; fileName: string; mimeType: string; duration: number; waveform: number }[] = [];
	private nextFile = 1;
	readonly selfId: number;
	readonly selfName: string;
	readonly selfUsername: string;
	readonly names = new Map<number, string>();
	readonly members = new Map<number, number[]>();
	private readonly chatTypes = new Map<number, ChatType>();
	readonly roles = new Map<string, MemberRole>();
	readonly notifications: NotificationRequest[] = [];
	private readonly messageExtras = new Map<string, MessageExtras>();
	private readonly userExtras = new Map<number, UserExtras>();
	private readonly chatExtras = new Map<number, ChatExtras>();
	private readonly dialogExtras = new Map<number, { unreadMentionsCount?: number; unreadCount?: number }>();
	readonly blocked = new Set<number>();
	readonly reactions: { chatId: number; seq: number; emoji: string }[] = [];
	readonly pins: { chatId: number; seq: number; pinned: boolean }[] = [];
	readonly forwards: { from: number; seqs: number[]; to: number }[] = [];
	readonly invites: { chatId: number; expiresAt: number; usageLimit: number }[] = [];
	/** SendMessage requests from the client (the server keeps only the text). */
	readonly sent: { chatId: number; text: string; replyToSeq: number; topicId: number }[] = [];
	readonly topics = new Map<number, FixtureTopic[]>();
	/** UpdateChatInfo calls, in order (forum: what the call asked for). */
	readonly updatedChats: { chatId: number; forum: boolean | undefined; title?: string; about?: string; photoFileId?: string }[] = [];
	private readonly messageTopics = new Map<string, number>();
	readonly previews: FixturePreview[] = [];
	readonly inviteChecks = new Map<
		string,
		{ title: string; type: ChatType; memberCount: number; memberOf: number; members?: number[]; history?: HistoryVisibility; banned?: boolean }
	>();
	readonly inviteLinks = new Map<number, InviteLink[]>();
	readonly readers = new Map<string, number[]>();
	readonly reports: { target: string; reason: number; comment: string }[] = [];
	/** Users whose privacy refuses being added to groups by this user. */
	readonly refusesGroups = new Set<number>();
	/** Users whose privacy refuses a new private chat with this user ("message me": contacts). */
	readonly refusesMessages = new Set<number>();
	/** The anti-spam refusal (server message prefix) CreatePrivate answers, when set. */
	strangerRefusal: "stranger_chat_limit" | "stranger_chat_paused" | null = null;
	/** Texts of SendMessage requests that asked for no link preview. */
	readonly sentWithoutPreview: string[] = [];
	/** Server message searches the core made (query, chat; 0 = global). */
	readonly searchRequests: { query: string; chatId: number; cursor: string }[] = [];
	/** Set: the server's message search answers with this error code. */
	searchFailure: Code | null = null;
	/** The signed-in user's contact list (AddContact/DeleteContact/GetContacts). */
	readonly contacts = new Set<number>();
	/** Users their own find_by_username/email settings hide from this user. */
	readonly hiddenFromSearch = new Set<number>();
	/** Contacts per GetContacts page. */
	contactsPageSize = 500;
	/** Bans per chat (RemoveMember with ban, GetBannedMembers, UnbanMember). */
	readonly bans = new Map<number, { userId: number; by: number; at: number }[]>();
	readonly removals: { chatId: number; userId: number; ban: boolean }[] = [];
	/** Chats whose owner (this user) may not leave until another admin exists. */
	readonly ownerNeedsAdmin = new Set<number>();
	/** Topics per GetForumTopics page. */
	topicPageSize = 100;
	/** Read dates per reader, by `${chatId}:${seq}`; readers without one have none. */
	readonly readDates = new Map<string, Map<number, number>>();
	/** Who reacted with what, by `${chatId}:${seq}` (GetMessageReactions), newest first. */
	readonly reactors = new Map<string, { userId: number; emoji: string; date: number }[]>();
	/** When each contact was added (GetContacts.contacts). */
	readonly contactDates = new Map<number, number>();
	/** When each blocked user was blocked (GetBlockedUsers). */
	readonly blockedAt = new Map<number, number>();
	/** Chats that reached their member limit (AddMembers: TOO_MANY). */
	readonly fullChats = new Set<number>();
	/** LeaveChat requests: the chat and the admin the owner picked (0 for none). */
	readonly leaves: { chatId: number; newOwnerId: number }[] = [];
	/** PinMessage requests that asked to pin quietly (silent). */
	readonly silentPins: number[] = [];
	/** Deleted chats (DeleteChat). */
	readonly deletedChats: number[] = [];
	/** SetDialogMute requests. */
	readonly mutes: { chatId: number; durationSeconds: number; forever: boolean }[] = [];
	/** GetPinnedMessages requests (chat and topic). */
	readonly pinnedRequests: { chatId: number; topicId: number }[] = [];
	/** Chats whose reactions come without the latest reactors (channels, for non-admins). */
	readonly anonymousReactions = new Set<number>();
	/** GetChatOnlineCount per chat; chats not listed count the sessions online on the fake server. */
	readonly onlineCounts = new Map<number, number>();
	/** GetSelf.is_operator: may use the moderation queue. */
	operator = false;
	readonly reportQueue: FixtureReport[] = [];
	readonly feedbackQueue: FixtureFeedback[] = [];
	/** FeedbackService.SendFeedback answers resource_exhausted while set. */
	feedbackRateLimited = false;
	/** SendAnnouncement texts as sent, and the users who started the assistant. */
	readonly announcements: { id: number; text: string; state: AnnouncementState; sent: number }[] = [];
	announceAudience = 3;
	/** Users restricted by moderation, with the end (0: until lifted). */
	readonly restrictions = new Map<number, number>();
	readonly lifted: number[] = [];
	/** ResolveReport requests: actions and whether the people were told. */
	readonly resolutions: { reportIds: number[]; actions: ModerationAction[]; notify: boolean }[] = [];
	/** GetReport's hooks of webhook reports, by report id. */
	readonly reportHooks = new Map<number, { id: string; name: string; disabled: boolean }[]>();
	/** The moderation log (GetModerationLog), newest first. */
	readonly moderationLog: FixtureLogEntry[] = [];
	/** Bots as the operators review them (GetBotReview, GetBotReviews). */
	readonly botReviews = new Map<number, FixtureBotReview>();
	private pinnedChats: number[] = [];
	/** Incoming webhooks of the fixture's chats (IntegrationsService). */
	readonly integrations: FakeIntegrations;
	/** The signed-in user's bots and starting bots (BotAdminService, BotsService). */
	readonly bots: FakeBots;
	/** PushService: this session's Web Push registration. */
	readonly push = new FakePush();
	/** PrivacyService: data export and account deletion. */
	readonly privacy = new FakePrivacy();

	constructor(selfName = "Đức Thắng", selfUsername = "ductrung") {
		this.selfName = selfName;
		this.selfUsername = selfUsername;
		this.selfId = this.addUser(selfName, { username: selfUsername });
		this.privacy.username = selfUsername;
		this.integrations = new FakeIntegrations({
			selfId: this.selfId,
			roleOf: (chatId) => (this.members.get(chatId)?.includes(this.selfId) === true ? (this.chatExtras.get(chatId)?.myRole ?? MemberRole.MEMBER) : null),
			isAdmin: (chatId, userId) => {
				const role = userId === this.selfId ? this.chatExtras.get(chatId)?.myRole : this.roles.get(`${chatId}:${userId}`);
				return role === MemberRole.ADMIN || role === MemberRole.OWNER;
			},
			wireUsers: (ids) => ids.filter((id) => this.names.has(id)).map((id) => this.wireUser(id)),
			// Like the server: a service message in groups only, from the admin or (0) the server.
			hookStopped: (chatId, actorId, hookName, reason) => {
				if (this.chatTypes.get(chatId) !== ChatType.GROUP) return;
				this.server.postService(chatId, actorId, { kind: { case: "incomingHookStopped", value: { hookName, reason } } });
			},
		});
		this.bots = new FakeBots({
			selfId: this.selfId,
			addBotUser: (name, username) => this.addUser(name, { username, isBot: true }),
			rename: (userId, name) => {
				this.names.set(userId, name);
				this.userExtras.set(userId, { ...this.userExtras.get(userId), name });
			},
			setPhoto: (userId, fileId) => this.setPhoto(userId, fileId),
			usernameTaken: (username) => [...this.names.keys()].some((id) => this.wireUser(id).username === username),
			wireUser: (id) => this.wireUser(id),
			privateChat: (userId) => this.privateChatWith(userId),
			wireChat: (chatId) => this.server.wireChat(chatId, this.selfId),
			sendAsSelf: (chatId, text) => {
				this.send(this.selfId, chatId, text);
			},
			sendMiniAppData: (chatId, data, buttonText) => {
				this.send(this.selfId, chatId, "", { action: { kind: { case: "miniAppData", value: { data, buttonText } } } });
			},
		});
	}

	/** Turns media on (MediaService, uploads, downloads) with this per-file limit. */
	enableMedia(uploadSizeMax = 2000 * 2 ** 20): FakeMedia {
		const media = new FakeMedia();
		media.partSize = 64 * 1024;
		media.putDelayMs = 0;
		this.server.media = media;
		this.mediaConfig = media.configApi(uploadSizeMax, { size: 2 ** 30, large: 2 ** 29, ageSeconds: 30 * 86_400 });
		return media;
	}

	private mediaConfig: NonNullable<RemoteApi["config"]> = MEDIA_OFF_CONFIG;

	/** Stores a file on the fake server and returns its MediaRef (as the server would after CompleteUpload). */
	addFile(owner: number, file: FixtureFile): WireMediaRef {
		const media = this.server.media;
		if (media === null) throw new Error("enableMedia() first");
		const fileId = `fx${this.nextFile++}`;
		const ref = create(MediaRefSchema, {
			fileId,
			fileHash: fileId,
			kind: WIRE_KINDS[file.kind],
			mimeType: file.mimeType,
			size: BigInt(file.bytes.length),
			fileName: file.name ?? "",
			width: file.width ?? 0,
			height: file.height ?? 0,
			duration: file.duration ?? 0,
			inlineThumb: file.inlineThumb ?? new Uint8Array(),
			waveform: file.waveform ?? new Uint8Array(),
			sizes: (file.sizes ?? []).map((type) => ({ type: WIRE_SIZES[type], width: file.width ?? 0, height: file.height ?? 0, size: BigInt(file.bytes.length) })),
		});
		media.files.set(fileId, { ref, bytes: file.bytes, owner });
		return ref;
	}

	/** A message with a file (and caption) from `from`; `groupedId` puts it in an album. */
	sendFile(from: number, chatId: number, file: FixtureFile, caption = "", groupedId = 0): number {
		const seq = this.peekSeq(chatId);
		const sent = this.server.sendMessage(from, chatId, caption, 0, {
			media: this.addFile(from, file),
			...(groupedId === 0 ? {} : { groupedId: BigInt(groupedId) }),
		}).seq;
		if (sent !== seq) throw new Error(`fixture expected seq ${seq}, server gave ${sent}`);
		return sent;
	}

	/** Turns a bot's inline mode on (User.bot_inline_placeholder). */
	setInlinePlaceholder(userId: number, placeholder: string): void {
		this.userExtras.set(userId, { ...this.userExtras.get(userId), botInlinePlaceholder: placeholder });
	}

	addUser(name: string, extras: UserExtras = {}): number {
		const id = this.server.addUser(name);
		this.names.set(id, name);
		this.userExtras.set(id, { username: name.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "").replace(/đ/g, "d").replace(/\s+/g, ""), ...extras });
		return id;
	}

	createChat(type: ChatType, title: string, members: readonly number[], extras: ChatExtras = {}): number {
		const id = this.server.createChat(type, title, members);
		this.chatTypes.set(id, type);
		this.members.set(id, [...members]);
		this.chatExtras.set(id, { myRole: MemberRole.MEMBER, myPermissions: 0x1f, defaultPermissions: 0x1d, historyVisibility: HistoryVisibility.SHARED, ...extras });
		return id;
	}

	/** The "General" topic a forum starts with, named as the server names it (topic 1, created when topics are turned on). */
	private generalTopic(): FixtureTopic {
		return { id: 1, title: "General", iconColor: 0x8e8e93, creatorId: this.selfId, pinned: false, closed: false, hidden: false, unreadCount: 0 };
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

	/** A message of an incoming webhook (from_id 0 under its label), with entities, URL buttons or silent. */
	postIntegration(
		chatId: number,
		label: string,
		text: string,
		options: { entities?: MessageExtras["entities"]; silent?: boolean; buttons?: readonly (readonly { text: string; url: string }[])[] } = {},
	): number {
		const seq = this.peekSeq(chatId);
		if (options.entities !== undefined) this.messageExtras.set(`${chatId}:${seq}`, { entities: options.entities });
		const posted = this.server.postIntegration(chatId, label, text, { silent: options.silent ?? false, buttons: options.buttons ?? [] });
		if (posted !== seq) throw new Error(`fixture expected seq ${seq}, server gave ${posted}`);
		return posted;
	}

	/** The webhook updates its alert in place (same group key); `notify` when its state changed. */
	editIntegration(chatId: number, seq: number, text: string, notify: boolean, entities?: MessageExtras["entities"]): void {
		const key = `${chatId}:${seq}`;
		if (entities === undefined) this.messageExtras.delete(key);
		else this.messageExtras.set(key, { entities });
		this.server.editIntegration(chatId, seq, text, notify);
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

	/** A reaction the server knows who set (GetMessageReactions lists it). */
	react(userId: number, chatId: number, seq: number, emoji: string): void {
		this.server.react(userId, chatId, seq, emoji);
		const key = `${chatId}:${seq}`;
		this.reactors.set(key, [{ userId, emoji, date: 1_760_400_000 + (this.reactors.get(key)?.length ?? 0) }, ...(this.reactors.get(key) ?? [])]);
	}

	/** Mutes a chat for the signed-in user until `until` (0 unmutes), as another session would. */
	mute(chatId: number, until: number): void {
		this.server.muteDialog(this.selfId, chatId, until);
	}

	/** Pins chats for the signed-in user, top first, as another session would. */
	pinChats(chatIds: readonly number[]): void {
		this.pinnedChats = [...chatIds];
		this.server.pinDialogs(this.selfId, chatIds);
	}

	mentions(chatId: number, count: number): void {
		this.dialogExtras.set(chatId, { ...this.dialogExtras.get(chatId), unreadMentionsCount: count });
	}

	/** The server's (capped) unread count for a chat, as GetDialogs reports it. */
	unread(chatId: number, count: number): void {
		this.dialogExtras.set(chatId, { ...this.dialogExtras.get(chatId), unreadCount: count });
	}

	// ------------------------------------------------------------- patching

	patchMessage(message: WireMessage): void {
		if (this.anonymousReactions.has(num(message.chatId))) for (const reaction of message.reactions) reaction.recentUserIds = [];
		// A recalled message is a placeholder: the fixture's extras are gone with its content.
		if (message.recalled) return;
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
		const photo = this.photos.get(num(user.id));
		user.photo = photo === undefined ? undefined : create(MediaRefSchema, { fileId: photo, kind: MediaKind.PHOTO });
	}

	patchChat(chat: WireChat): void {
		const extras = this.chatExtras.get(num(chat.id));
		if (extras !== undefined) assign(chat, create(ChatSchema, { ...chat, ...extras }));
	}

	patchDialog(dialog: WireDialog): void {
		const extras = this.dialogExtras.get(num(dialog.chatId));
		if (extras?.unreadCount !== undefined) dialog.unreadCount = extras.unreadCount;
		if (extras?.unreadMentionsCount !== undefined && dialog.unreadCount > 0) dialog.unreadMentionsCount = extras.unreadMentionsCount;
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
				getPeerDialogs: async (request) => {
					const response = await offered(base.chats.getPeerDialogs, "getPeerDialogs")(request);
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
				setDialogUnreadMark: (request) => offered(base.chats.setDialogUnreadMark, "setDialogUnreadMark")(request),
				getNotificationSettings: (request) => offered(base.chats.getNotificationSettings, "getNotificationSettings")(request),
				setNotificationSettings: (request) => offered(base.chats.setNotificationSettings, "setNotificationSettings")(request),
				getChatOnlineCount: async (request) => {
					const override = this.onlineCounts.get(num(request.chatId ?? 0n));
					if (override !== undefined) return create(GetChatOnlineCountResponseSchema, { onlineCount: override });
					return offered(base.chats.getChatOnlineCount, "getChatOnlineCount")(request);
				},
			},
			messages: {
				sendMessage: (request) => {
					this.sent.push({ chatId: num(request.chatId ?? 0n), text: request.text ?? "", replyToSeq: num(request.replyToSeq ?? 0n), topicId: 0 });
					if (request.noLinkPreview === true) this.sentWithoutPreview.push(request.text ?? "");
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
				getPinnedMessages: async (request) => {
					this.pinnedRequests.push({ chatId: num(request.chatId ?? 0n), topicId: num(request.topicId ?? 0n) });
					const response = await offered(base.messages.getPinnedMessages, "getPinnedMessages")(request);
					response.messages.forEach((m) => this.patchMessage(m));
					users(response.users);
					return response;
				},
				unpinAllMessages: (request) => offered(base.messages.unpinAllMessages, "unpinAllMessages")(request),
				sendMedia: (request) => offered(base.messages.sendMedia, "sendMedia")(request),
				sendAlbum: (request) => offered(base.messages.sendAlbum, "sendAlbum")(request),
			},
			search: {
				searchMessages: async (request) => {
					this.searchRequests.push({ query: request.query ?? "", chatId: 0, cursor: request.cursor ?? "" });
					if (this.searchFailure !== null) throw new ConnectError("search unavailable", this.searchFailure);
					const response = await offered(base.search?.searchMessages, "searchMessages")(request);
					response.messages.forEach((m) => this.patchMessage(m));
					users(response.users);
					chats(response.chats);
					return response;
				},
				searchChatMessages: async (request) => {
					this.searchRequests.push({ query: request.query ?? "", chatId: num(request.chatId ?? 0n), cursor: request.cursor ?? "" });
					if (this.searchFailure !== null) throw new ConnectError("search unavailable", this.searchFailure);
					const response = await offered(base.search?.searchChatMessages, "searchChatMessages")(request);
					response.messages.forEach((m) => this.patchMessage(m));
					users(response.users);
					chats(response.chats);
					return response;
				},
			},
			config: this.mediaConfig,
			...(base.media === undefined
				? {}
				: {
						media: {
							...base.media,
							createUpload: (request) => {
								this.uploadRequests.push({ kind: request.kind ?? 0, fileName: request.fileName ?? "", mimeType: request.mimeType ?? "", duration: request.duration ?? 0, waveform: request.waveform?.length ?? 0 });
								return base.media?.createUpload(request) ?? Promise.reject(new Error("no media"));
							},
						},
					}),
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

	/** Profile photos by user (bots' photos set in the Developer Console). */
	readonly photos = new Map<number, string>();

	/** Sets (or with "" removes) a group's or channel's photo, downloadable with the chat_photo_of context. */
	setChatPhoto(chatId: number, fileId: string): void {
		const next: ChatExtras = { ...(this.chatExtras.get(chatId) ?? {}) };
		if (fileId === "") delete next.photo;
		else next.photo = photoRef(fileId);
		this.chatExtras.set(chatId, next);
		const media = this.server.media;
		if (media !== null && fileId === "") media.chatPhotos.delete(chatId);
		else if (media !== null) media.chatPhotos.set(chatId, fileId);
	}

	/** Sets (or with "" removes) a user's profile photo, downloadable with the user_photo_of context. */
	setPhoto(userId: number, fileId: string): void {
		if (fileId === "") this.photos.delete(userId);
		else this.photos.set(userId, fileId);
		const media = this.server.media;
		if (media !== null) {
			if (fileId === "") media.photos.delete(userId);
			else media.photos.set(userId, fileId);
		}
	}

	wireUser(id: number): WireUser {
		const user = this.server.wireUser(id, this.selfId);
		this.patchUser(user);
		user.status = create(UserSchema, { status: { kind: id % 3 === 0 ? UserStatusKind.ONLINE : UserStatusKind.RECENTLY } }).status;
		return user;
	}

	// ------------------------------------------------------------- core

	/** `filter`: the app's notification filter (null drops one); notifications holds what it let through. */
	async startCore(sql: SqlDriverFactory, filter?: (request: NotificationRequest) => NotificationRequest | null): Promise<ChatCore> {
		let nextRandom = 1;
		const platform: Platform = {
			sql,
			lifecycle: {
				isForeground: () => true,
				onForegroundChange: () => () => undefined,
				onOnline: () => () => undefined,
			},
			notify: {
				show: (request) => {
					const shown = filter === undefined ? request : filter(request);
					if (shown !== null) this.notifications.push(shown);
				},
				clear: () => undefined,
			},
			socket: this.socket(),
			timers: systemTimers,
			frame: (callback) => setTimeout(callback, 0),
			randomId: () => this.selfId * 1_000_000 + nextRandom++,
			...(this.server.media === null ? {} : { http: this.server.media.http, blobs: this.blobs }),
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
		this.userRoutes(router);
		this.chatRoutes(router);
		this.integrations.routes(router);
		this.bots.routes(router);
		this.push.routes(router);
		this.privacy.routes(router);
	}

	/** The private chat of the signed-in user with `userId`, created when missing. */
	privateChatWith(userId: number): number {
		const existing = [...this.members.entries()].find(
			([id, list]) => this.server.wireChat(id, this.selfId).type === ChatType.PRIVATE && list.includes(userId) && list.includes(this.selfId),
		);
		return existing?.[0] ?? this.createChat(ChatType.PRIVATE, "", [this.selfId, userId]);
	}

	/** UsersService only: tests of the account screens bring their own. */
	userRoutes(router: ConnectRouter): void {
		const self = () => this.wireUser(this.selfId);
		router.service(UsersService, {
			getSelf: () => ({ user: self(), isOperator: this.operator }),
			getUsers: (req) => ({ users: req.userIds.map((id) => this.wireUser(num(id))) }),
			resolveUsername: (req) => {
				const name = req.username.replace(/^@/, "").toLowerCase();
				const id = [...this.names.keys()].find((userId) => this.wireUser(userId).username === name);
				if (id === undefined) throw new ConnectError("user not found", Code.NotFound);
				return { user: this.wireUser(id) };
			},
			searchUsers: (req) => {
				const q = req.query.toLowerCase();
				const ids = [...this.names.keys()].filter((id) => id !== this.selfId);
				const hits = ids.filter((id) => {
					const user = this.wireUser(id);
					if (this.hiddenFromSearch.has(id)) return false;
					return q.includes("@") ? `${user.username}@hoandat.com` === q : user.username.startsWith(q.replace(/^@/, ""));
				});
				return { users: hits.map((id) => this.wireUser(id)) };
			},
			block: (req) => {
				this.blocked.add(num(req.userId));
				this.blockedAt.set(num(req.userId), 1_760_500_000);
				return {};
			},
			unblock: (req) => {
				this.blocked.delete(num(req.userId));
				this.blockedAt.delete(num(req.userId));
				return {};
			},
			getBlockedUsers: () => {
				const ids = [...this.blocked].sort((a, b) => (this.blockedAt.get(b) ?? 0) - (this.blockedAt.get(a) ?? 0));
				return {
					blocked: ids.map((id) => ({ userId: BigInt(id), blockedAt: BigInt(this.blockedAt.get(id) ?? 0) })),
					users: ids.map((id) => this.wireUser(id)),
					nextCursor: "",
				};
			},
			addContact: (req) => {
				const target = req.target;
				let id = 0;
				if (target.case === "userId") id = num(target.value);
				else if (target.case === "username") {
					const name = target.value.replace(/^@/, "").toLowerCase();
					id = [...this.names.keys()].find((userId) => this.wireUser(userId).username === name) ?? 0;
				} else if (target.case === "email") {
					id = [...this.names.keys()].find((userId) => `${this.wireUser(userId).username}@hoandat.com` === target.value.toLowerCase()) ?? 0;
				}
				if (id === 0 || id === this.selfId || (target.case !== "userId" && this.hiddenFromSearch.has(id))) {
					throw new ConnectError("user not found", Code.NotFound);
				}
				this.contacts.add(id);
				this.contactDates.set(id, 1_760_500_000);
				return { user: this.wireUser(id) };
			},
			deleteContact: (req) => {
				this.contacts.delete(num(req.userId));
				return {};
			},
			getContacts: (req) => {
				const ids = [...this.contacts].sort((a, b) => a - b);
				const after = req.cursor === "" ? 0 : Number(req.cursor);
				const page = ids.filter((id) => id > after).slice(0, this.contactsPageSize);
				const last = page.at(-1) ?? 0;
				return {
					users: page.map((id) => this.wireUser(id)),
					contacts: page.map((id) => ({ userId: BigInt(id), addedAt: BigInt(this.contactDates.get(id) ?? 1_757_000_000) })),
					nextCursor: ids.some((id) => id > last) && page.length > 0 ? String(last) : "",
				};
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
	}

	/** Every service except UsersService. */
	chatRoutes(router: ConnectRouter): void {
		router.service(ConfigService, {
			getAppConfig: () => ({ result: { case: "config", value: { hash: "t", messageLengthMax: 4096, editTimeLimitSeconds: 172_800 } } }),
		});
		router.service(MessagesService, {
			sendMessage: (req) => {
				const chatId = num(req.chatId);
				this.sent.push({ chatId, text: req.text, replyToSeq: num(req.replyToSeq), topicId: num(req.topicId) });
				if (req.noLinkPreview) this.sentWithoutPreview.push(req.text);
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
			sendInlineResult: (req) => {
				const result = this.bots.inlineAnswers.get(req.queryId)?.find((r) => r.id === req.resultId);
				if (result === undefined) throw new ConnectError("inline result not found", Code.NotFound);
				this.send(this.selfId, num(req.chatId), result.text, { viaBotId: BigInt(result.botId) });
				return {};
			},
			pressInlineButton: async (req) => {
				const answer = await this.bots.press(num(req.chatId), num(req.seq), new TextDecoder().decode(req.callbackData));
				return { text: answer.text ?? "", showAlert: answer.showAlert ?? false, url: answer.url ?? "", timedOut: answer.timedOut ?? false };
			},
			getLinkPreview: (req) => {
				const preview = this.previews.find((p) => p.url === req.url);
				return preview === undefined ? {} : { preview };
			},
			getMessageReaders: (req) => {
				const ids = this.readers.get(`${num(req.chatId)}:${num(req.seq)}`);
				if (ids === undefined) throw new ConnectError("readers not available", Code.FailedPrecondition);
				const dates = this.readDates.get(`${num(req.chatId)}:${num(req.seq)}`);
				return {
					userIds: ids.map(BigInt),
					users: ids.map((id) => this.wireUser(id)),
					readers: dates === undefined ? [] : ids.map((id) => ({ userId: BigInt(id), readAt: BigInt(dates.get(id) ?? 0) })),
				};
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
				if (req.silent) this.silentPins.push(num(req.seq));
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
			getMessageReactions: (req) => {
				const all = this.reactors.get(`${num(req.chatId)}:${num(req.seq)}`) ?? [];
				const list = req.emoji === "" ? all : all.filter((reactor) => reactor.emoji === req.emoji);
				return {
					reactors: list.map((reactor) => ({ userId: BigInt(reactor.userId), emoji: reactor.emoji, date: BigInt(reactor.date) })),
					users: [...new Set(list.map((reactor) => reactor.userId))].map((id) => this.wireUser(id)),
					nextCursor: "",
				};
			},
		});
		this.moderationRoutes(router);
		router.service(ChatsService, {
			createPrivate: (req) => {
				const userId = num(req.userId);
				if (this.refusesMessages.has(userId)) throw new ConnectError("the user only takes messages from contacts", Code.PermissionDenied);
				if (this.strangerRefusal !== null) throw new ConnectError(`${this.strangerRefusal}: anti-spam`, Code.ResourceExhausted);
				const existing = [...this.members.entries()].find(
					([id, list]) => this.server.wireChat(id, this.selfId).type === ChatType.PRIVATE && list.includes(userId),
				);
				const chatId = existing?.[0] ?? this.createChat(ChatType.PRIVATE, "", [this.selfId, userId]);
				return { chat: this.server.wireChat(chatId, this.selfId) };
			},
			createGroup: (req) => {
				const refused = req.userIds.map(num).filter((id) => this.refusesGroups.has(id));
				const added = req.userIds.map(num).filter((id) => !this.refusesGroups.has(id));
				const chatId = this.createChat(ChatType.GROUP, req.title, [this.selfId, ...added], { myRole: MemberRole.OWNER, forum: req.forum });
				this.setRole(chatId, this.selfId, MemberRole.OWNER);
				if (req.forum) this.topics.set(chatId, [this.generalTopic()]);
				this.send(this.selfId, chatId, "", { action: { kind: { case: "chatCreated", value: { title: req.title } } } });
				return {
					chat: this.server.wireChat(chatId, this.selfId),
					failedUserIds: refused.map(BigInt),
					failures: refused.map((id) => ({ userId: BigInt(id), reason: AddMemberFailureReason.PRIVACY_ADD_TO_GROUPS })),
				};
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
				const failures: { userId: bigint; reason: AddMemberFailureReason }[] = [];
				for (const id of req.userIds.map(num)) {
					const reason = !this.names.has(id)
						? AddMemberFailureReason.NOT_FOUND
						: (this.members.get(chatId) ?? []).includes(id)
							? AddMemberFailureReason.ALREADY_MEMBER
							: (this.bans.get(chatId) ?? []).some((ban) => ban.userId === id)
								? AddMemberFailureReason.BANNED
								: this.refusesGroups.has(id)
									? AddMemberFailureReason.PRIVACY_ADD_TO_GROUPS
									: this.fullChats.has(chatId)
										? AddMemberFailureReason.TOO_MANY
										: AddMemberFailureReason.UNSPECIFIED;
					if (reason !== AddMemberFailureReason.UNSPECIFIED) {
						failures.push({ userId: BigInt(id), reason });
						continue;
					}
					this.server.addMember(chatId, id, this.selfId);
					this.members.get(chatId)?.push(id);
				}
				return {
					failedUserIds: failures.filter((failure) => failure.reason !== AddMemberFailureReason.ALREADY_MEMBER).map((failure) => failure.userId),
					failures,
				};
			},
			removeMember: (req) => {
				const chatId = num(req.chatId);
				const userId = num(req.userId);
				const ban = req.ban ?? true;
				this.removals.push({ chatId, userId, ban });
				this.server.removeMember(chatId, userId, this.selfId);
				this.members.set(chatId, (this.members.get(chatId) ?? []).filter((id) => id !== userId));
				if (ban) this.bans.set(chatId, [...(this.bans.get(chatId) ?? []), { userId, by: this.selfId, at: 1_760_400_000 }]);
				return {};
			},
			unbanMember: (req) => {
				const chatId = num(req.chatId);
				this.bans.set(chatId, (this.bans.get(chatId) ?? []).filter((ban) => ban.userId !== num(req.userId)));
				return {};
			},
			getBannedMembers: (req) => {
				const list = this.bans.get(num(req.chatId)) ?? [];
				const ids = [...new Set(list.flatMap((ban) => [ban.userId, ban.by]))];
				return {
					members: list.map((ban) => ({ userId: BigInt(ban.userId), bannedBy: BigInt(ban.by), bannedAt: BigInt(ban.at) })),
					users: ids.map((id) => this.wireUser(id)),
					nextCursor: "",
				};
			},
			leaveChat: (req) => {
				if (this.ownerNeedsAdmin.has(num(req.chatId))) {
					throw new ConnectError("owner_needs_admin: appoint an admin before leaving", Code.FailedPrecondition);
				}
				this.leaves.push({ chatId: num(req.chatId), newOwnerId: num(req.newOwnerId) });
				return {};
			},
			setDialogMute: (req) => {
				const chatId = num(req.chatId);
				this.mutes.push({ chatId, durationSeconds: req.durationSeconds, forever: req.forever });
				const until = req.forever ? 2_147_483_647 : req.durationSeconds > 0 ? Math.floor(Date.now() / 1000) + req.durationSeconds : 0;
				this.server.muteDialog(this.selfId, chatId, until);
				return { muteUntil: BigInt(until) };
			},
			setDialogPinned: (req) => {
				const chatId = num(req.chatId);
				const rest = this.pinnedChats.filter((id) => id !== chatId);
				if (req.pinned && rest.length >= 5) throw new ConnectError("pinned_dialogs_limit: unpin a chat first", Code.FailedPrecondition);
				this.pinChats(req.pinned ? [chatId, ...rest] : rest);
				return { pinnedChatIds: this.pinnedChats.map(BigInt) };
			},
			deleteChat: (req) => {
				const chatId = num(req.chatId);
				this.deletedChats.push(chatId);
				// "Cloud của tôi" is cleared, not deleted: the server keeps the chat and its pin.
				const members = this.members.get(chatId) ?? [];
				if (members.length === 1 && members[0] === this.selfId) {
					this.server.clearSavedChat(this.selfId, chatId);
					return {};
				}
				this.server.deleteChat(chatId);
				this.members.delete(chatId);
				return {};
			},
			getCommonChats: (req) => {
				const userId = num(req.userId);
				const ids = [...this.members.entries()]
					.filter(([chatId, list]) => {
						const type = this.server.wireChat(chatId, this.selfId).type;
						return (type === ChatType.GROUP || type === ChatType.CHANNEL) && list.includes(userId) && list.includes(this.selfId);
					})
					.map(([chatId]) => chatId)
					.sort((a, b) => a - b);
				return { chats: ids.map((chatId) => this.server.wireChat(chatId, this.selfId)), count: ids.length, nextCursor: "" };
			},
			setAdmin: (req) => {
				this.setRole(num(req.chatId), num(req.userId), req.admin ? MemberRole.ADMIN : MemberRole.MEMBER);
				if (req.admin) this.ownerNeedsAdmin.delete(num(req.chatId));
				return {};
			},
			updateChatInfo: (req) => {
				const chatId = num(req.chatId);
				const extras = this.chatExtras.get(chatId);
				if (req.forum === true && extras !== undefined && extras.forum !== true) {
					this.chatExtras.set(chatId, { ...extras, forum: true });
					this.topics.set(chatId, [this.generalTopic()]);
					this.server.announceChat(chatId);
				}
				const info = {
					...(req.title === undefined ? {} : { title: req.title }),
					...(req.about === undefined ? {} : { about: req.about }),
					...(req.photoFileId === undefined ? {} : { photoFileId: req.photoFileId }),
				};
				this.updatedChats.push({ chatId, forum: req.forum, ...info });
				if (Object.keys(info).length > 0) {
					const { photoFileId, ...text } = info;
					this.chatExtras.set(chatId, { ...(this.chatExtras.get(chatId) ?? {}), ...text });
					if (photoFileId !== undefined) this.setChatPhoto(chatId, photoFileId);
					this.server.announceChat(chatId);
				}
				return { chat: this.server.wireChat(chatId, this.selfId) };
			},
			setHistoryVisibility: () => ({}),
			exportInviteLink: (req) => {
				const chatId = num(req.chatId);
				this.invites.push({ chatId, expiresAt: num(req.expiresAt), usageLimit: req.usageLimit });
				const invite = {
					$typeName: "app.v1.InviteLink" as const,
					link: `https://chat.example.test/join/q7XrN2bTk4RbZ9wLc1Np${this.invites.length}`,
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
				const token = req.link.replace(/^.*[/+]/, "");
				const found = this.inviteChecks.get(token);
				if (found === undefined) throw new ConnectError("invite expired", Code.NotFound);
				if (found.banned === true) throw new ConnectError("you were removed from this chat by an admin", Code.PermissionDenied);
				const members = found.members ?? [];
				return {
					title: found.title,
					type: found.type,
					memberCount: found.memberCount,
					...(found.memberOf === 0 ? {} : { chat: this.server.wireChat(found.memberOf, this.selfId) }),
					memberIds: members.map(BigInt),
					users: members.map((id) => this.wireUser(id)),
					historyVisibility: found.history ?? HistoryVisibility.UNSPECIFIED,
				};
			},
			getForumTopics: (req) => {
				const chatId = num(req.chatId);
				const list = this.topics.get(chatId) ?? [];
				const messages = this.server.expectedMessages(chatId, this.selfId);
				const sorted = [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || this.topicTop(chatId, b.id) - this.topicTop(chatId, a.id));
				const start = req.cursor === "" ? 0 : Number(req.cursor);
				const page = sorted.slice(start, start + this.topicPageSize);
				const next = start + page.length < sorted.length ? String(start + page.length) : "";
				const tops = page.map((t) => messages.find((m) => m.seq === this.topicTop(chatId, t.id))).filter((m) => m !== undefined);
				return {
					nextCursor: next,
					topics: page.map((t) => ({
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
						icon: t.icon ?? "",
						messageCount: t.messageCount ?? 0,
						unreadMentionsCount: t.unreadMentions ?? 0,
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

	/** ModerationService on the fixture's report queue (operators only, as on the server). */
	moderationRoutes(router: ConnectRouter): void {
		const report = (r: FixtureReport) => ({
			id: BigInt(r.id),
			targetKind: r.kind,
			reporterId: BigInt(r.reporterId),
			targetUserId: BigInt(r.targetUserId),
			targetChatId: BigInt(r.targetChatId),
			seqs: r.seqs.map(BigInt),
			reason: r.reason,
			comment: r.comment,
			status: r.status,
			createdAt: BigInt(r.createdAt),
			actions: r.actions,
			resolutionNote: r.note,
			resolvedBy: BigInt(r.status === ReportStatus.OPEN ? 0 : this.selfId),
			resolvedAt: BigInt(r.status === ReportStatus.OPEN ? 0 : r.createdAt + 600),
		});
		const operator = () => {
			if (!this.operator) throw new ConnectError("not an operator", Code.PermissionDenied);
		};
		const find = (id: bigint): FixtureReport => {
			const found = this.reportQueue.find((r) => r.id === num(id));
			if (found === undefined) throw new ConnectError("no such report", Code.NotFound);
			return found;
		};
		const feedback = (f: FixtureFeedback) => ({
			id: BigInt(f.id),
			userId: BigInt(f.userId),
			kind: f.kind,
			text: f.text,
			status: f.status,
			createdAt: BigInt(f.createdAt),
			handledAt: BigInt(f.status === FeedbackStatus.OPEN ? 0 : f.createdAt + 600),
			handledBy: BigInt(f.handledBy),
			replyText: f.replyText,
			repliedAt: BigInt(f.replyText === "" ? 0 : f.createdAt + 600),
			repliedBy: BigInt(f.replyText === "" ? 0 : f.handledBy),
			source: f.source ?? FeedbackSource.ASSISTANT,
		});
		router.service(FeedbackService, {
			sendFeedback: (req) => {
				if (this.feedbackRateLimited) throw new ConnectError("too many requests; slow down", Code.ResourceExhausted);
				const text = req.text.trim();
				if (text === "") throw new ConnectError("text is required", Code.InvalidArgument);
				this.feedbackQueue.unshift({
					id: this.feedbackQueue.length + 1,
					userId: this.selfId,
					kind: req.kind === FeedbackKind.BUG ? FeedbackKind.BUG : FeedbackKind.IDEA,
					text,
					status: FeedbackStatus.OPEN,
					createdAt: 1_760_000_000,
					handledBy: 0,
					replyText: "",
					source: FeedbackSource.SETTINGS,
				});
				return {};
			},
			reportClientError: () => ({}),
		});
		// The server's markdown, reduced to *bold*: an odd number of * is an error.
		const parseBold = (text: string) => {
			if ((text.match(/\*/g) ?? []).length % 2 === 1) throw new ConnectError("unclosed * at byte " + text.indexOf("*"), Code.InvalidArgument);
			const entities: { type: EntityType; offset: number; length: number }[] = [];
			let out = "";
			for (const [i, part] of text.split("*").entries()) {
				if (i % 2 === 1) entities.push({ type: EntityType.BOLD, offset: out.length, length: part.length });
				out += part;
			}
			return { text: out, entities };
		};
		const announcement = (a: { id: number; text: string; state: AnnouncementState; sent: number }) => ({
			id: BigInt(a.id),
			...parseBold(a.text),
			state: a.state,
			reason: a.state === AnnouncementState.CANCELLED ? "cancelled" : "",
			total: this.announceAudience,
			sent: a.sent,
			skipped: 0,
			failed: 0,
			createdAt: 1_760_000_000n,
			finishedAt: a.state === AnnouncementState.RUNNING ? 0n : 1_760_000_100n,
			createdBy: BigInt(this.selfId),
		});
		const findFeedback = (id: bigint): FixtureFeedback => {
			const found = this.feedbackQueue.find((f) => f.id === num(id));
			if (found === undefined) throw new ConnectError("no such feedback", Code.NotFound);
			return found;
		};
		const chatsOf = (ids: readonly number[]) => ids.filter((id) => id !== 0 && this.members.has(id)).map((id) => this.server.wireChat(id, this.selfId));
		const usersOf = (ids: readonly number[]) => [...new Set(ids)].filter((id) => this.names.has(id)).map((id) => this.wireUser(id));
		const sameTarget = (a: FixtureReport, b: FixtureReport) =>
			a.targetUserId === b.targetUserId && a.targetChatId === b.targetChatId && a.seqs.join() === b.seqs.join();
		const botReview = (b: FixtureBotReview) => ({
			botId: BigInt(b.botId),
			ownerId: BigInt(b.ownerId),
			createdAt: 1_759_000_000n,
			tier: b.restrictedAt !== 0 ? BotTier.RESTRICTED : b.verified ? BotTier.VERIFIED : b.tier,
			verified: b.verified,
			restrictedAt: BigInt(b.restrictedAt),
			restrictedReason: b.restrictedReason,
			restrictedAutomatically: b.restrictedAt !== 0,
			restrictionReviewed: b.reviewed,
			users: b.users,
			messages7d: 100,
			blockedPermille24h: b.blockedPermille,
			openReports: 0,
		});
		const findBot = (id: bigint): FixtureBotReview => {
			const found = this.botReviews.get(num(id));
			if (found === undefined) throw new ConnectError("no such bot", Code.NotFound);
			return found;
		};
		const log = (action: ModerationAction, targetUserId: number, note: string) =>
			this.moderationLog.unshift({ id: this.moderationLog.length + 1, operatorId: this.selfId, action, targetUserId, targetChatId: 0, note, createdAt: 1_760_000_000 });
		router.service(ModerationService, {
			getReportGroups: (req) => {
				operator();
				const status = req.status === ReportStatus.UNSPECIFIED ? ReportStatus.OPEN : req.status;
				const groups: FixtureReport[][] = [];
				for (const r of this.reportQueue.filter((r) => r.status === status)) {
					const group = groups.find((g) => g[0] !== undefined && sameTarget(g[0], r));
					if (group === undefined) groups.push([r]);
					else group.push(r);
				}
				const newest = (g: FixtureReport[]) => g.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
				const sorted = groups.sort((a, b) => b.length - a.length || newest(b).createdAt - newest(a).createdAt);
				const all = sorted.flat();
				return {
					groups: sorted.map((g) => {
						const counts = new Map<ReportReason, number>();
						for (const r of g) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
						const main = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ReportReason.OTHER;
						return { report: report(newest(g)), reportCount: g.length, mainReason: main };
					}),
					users: usersOf(all.flatMap((r) => [r.reporterId, r.targetUserId])),
					chats: chatsOf(all.map((r) => r.targetChatId)),
					nextCursor: "",
				};
			},
			getModerationLog: (req) => {
				operator();
				const list = this.moderationLog.filter(
					(e) =>
						(req.action === ModerationAction.UNSPECIFIED || e.action === req.action) &&
						(!req.automaticOnly || e.operatorId === 0) &&
						(req.operatorId === 0n || e.operatorId === num(req.operatorId)),
				);
				return {
					entries: list.map((e) => ({
						id: BigInt(e.id),
						operatorId: BigInt(e.operatorId),
						action: e.action,
						targetUserId: BigInt(e.targetUserId),
						targetChatId: BigInt(e.targetChatId),
						note: e.note,
						createdAt: BigInt(e.createdAt),
					})),
					users: usersOf(list.flatMap((e) => [e.operatorId, e.targetUserId])),
					chats: chatsOf(list.map((e) => e.targetChatId)),
					nextCursor: "",
				};
			},
			getBotReview: (req) => {
				operator();
				const b = findBot(req.botId);
				return { review: botReview(b), users: usersOf([b.botId, b.ownerId]) };
			},
			getBotReviews: () => {
				operator();
				const list = [...this.botReviews.values()].filter((b) => b.restrictedAt !== 0 && !b.reviewed);
				return { reviews: list.map(botReview), users: usersOf(list.flatMap((b) => [b.botId, b.ownerId])) };
			},
			setBotVerified: (req) => {
				operator();
				const b = findBot(req.botId);
				b.verified = req.verified;
				log(req.verified ? ModerationAction.VERIFY_BOT : ModerationAction.UNVERIFY_BOT, b.botId, req.note);
				return { review: botReview(b) };
			},
			reviewBotRestriction: (req) => {
				operator();
				const b = findBot(req.botId);
				if (b.restrictedAt === 0) throw new ConnectError("not_restricted: this bot is not restricted", Code.FailedPrecondition);
				if (req.restore) {
					b.restrictedAt = 0;
					b.restrictedReason = "";
				}
				b.reviewed = true;
				log(req.restore ? ModerationAction.RESTORE_BOT_TIER : ModerationAction.KEEP_BOT_RESTRICTED, b.botId, req.note);
				return { review: botReview(b) };
			},
			getReports: (req) => {
				operator();
				const status = req.status === ReportStatus.UNSPECIFIED ? ReportStatus.OPEN : req.status;
				const list = this.reportQueue.filter((r) => r.status === status).sort((a, b) => b.createdAt - a.createdAt);
				return {
					reports: list.map(report),
					users: usersOf(list.flatMap((r) => [r.reporterId, r.targetUserId])),
					chats: chatsOf(list.map((r) => r.targetChatId)),
					nextCursor: "",
				};
			},
			getReport: (req) => {
				operator();
				const r = find(req.reportId);
				const messages = r.kind === ReportTargetKind.MESSAGES ? this.server.expectedMessages(r.targetChatId, this.selfId) : [];
				const around = messages.filter((m) => r.seqs.some((seq) => Math.abs(m.seq - seq) <= 5));
				return {
					report: report(r),
					evidence: around.filter((m) => r.seqs.includes(m.seq)).map((m) => ({ seq: BigInt(m.seq), fromId: BigInt(m.fromId), date: BigInt(m.date), text: m.text, deleted: false })),
					context: around.map((m) => ({ chatId: BigInt(r.targetChatId), seq: BigInt(m.seq), fromId: BigInt(m.fromId), date: BigInt(m.date), text: m.text })),
					users: usersOf([r.reporterId, r.targetUserId, ...around.map((m) => m.fromId), ...this.restrictions.keys()]),
					...(r.targetChatId === 0 || !this.members.has(r.targetChatId) ? {} : { chat: this.server.wireChat(r.targetChatId, this.selfId) }),
					history: [],
					restrictions: [...this.restrictions].map(([userId, until]) => ({ userId: BigInt(userId), until: BigInt(until), reason: "", createdAt: 1_760_000_000n })),
					group: (() => {
						const group = this.reportQueue.filter((other) => other.status === r.status && sameTarget(other, r));
						const counts = new Map<ReportReason, number>();
						for (const other of group) counts.set(other.reason, (counts.get(other.reason) ?? 0) + 1);
						return {
							reportCount: group.length,
							reporterCount: new Set(group.map((other) => other.reporterId)).size,
							reasons: [...counts].sort((a, b) => b[1] - a[1]).map(([reason, count]) => ({ reason, count })),
							comments: group.map((other) => other.comment).filter((comment) => comment !== ""),
						};
					})(),
					signals:
						r.targetUserId === 0
							? []
							: [{ userId: BigInt(r.targetUserId), accountAgeSeconds: 2n * 86_400n, strangerChats24h: 148, blockedBy: 21, chatsJoined24h: 6, otherOpenReports: 1 }],
					hooks: this.reportHooks.get(r.id) ?? [],
				};
			},
			resolveReport: (req) => {
				operator();
				const r = find(req.reportId);
				if (r.status !== ReportStatus.OPEN) throw new ConnectError("report closed", Code.FailedPrecondition);
				if (req.note.trim() === "") throw new ConnectError("note required", Code.InvalidArgument);
				const group = this.reportQueue.filter((other) => other.status === ReportStatus.OPEN && sameTarget(other, r));
				for (const other of group) {
					other.status = req.actions.includes(ModerationAction.DISMISS) ? ReportStatus.DISMISSED : ReportStatus.RESOLVED;
					other.actions = [...req.actions];
					other.note = req.note;
				}
				this.resolutions.push({ reportIds: group.map((other) => other.id), actions: [...req.actions], notify: req.notify });
				if (req.actions.includes(ModerationAction.RESTRICT_ACCOUNT) && r.targetUserId !== 0) {
					this.restrictions.set(r.targetUserId, req.restrictSeconds === 0 ? 0 : 1_760_000_000 + req.restrictSeconds);
				}
				return { report: report(r) };
			},
			liftRestriction: (req) => {
				operator();
				this.restrictions.delete(num(req.userId));
				this.lifted.push(num(req.userId));
				return {};
			},
			getFeedback: (req) => {
				operator();
				const status = req.status === FeedbackStatus.UNSPECIFIED ? FeedbackStatus.OPEN : req.status;
				const list = this.feedbackQueue.filter((f) => f.status === status).sort((a, b) => b.id - a.id);
				return {
					feedback: list.map(feedback),
					users: usersOf(list.flatMap((f) => [f.userId, f.handledBy])),
					nextCursor: "",
				};
			},
			resolveFeedback: (req) => {
				operator();
				const f = findFeedback(req.feedbackId);
				if (f.status === FeedbackStatus.OPEN) {
					f.status = FeedbackStatus.HANDLED;
					f.handledBy = this.selfId;
				}
				return { feedback: feedback(f) };
			},
			previewAnnouncement: (req) => {
				operator();
				return { ...parseBold(req.text), audience: this.announceAudience };
			},
			sendAnnouncement: (req) => {
				operator();
				parseBold(req.text);
				const a = { id: this.announcements.length + 1, text: req.text, state: AnnouncementState.RUNNING, sent: 1 };
				this.announcements.push(a);
				return { announcement: announcement(a) };
			},
			getAnnouncements: () => {
				operator();
				return {
					announcements: [...this.announcements].reverse().map(announcement),
					users: usersOf([this.selfId]),
					audience: this.announceAudience,
				};
			},
			cancelAnnouncement: (req) => {
				operator();
				const a = this.announcements.find((x) => x.id === num(req.announcementId));
				if (a === undefined) throw new ConnectError("announcement not found", Code.NotFound);
				if (a.state === AnnouncementState.RUNNING) a.state = AnnouncementState.CANCELLED;
				return { announcement: announcement(a) };
			},
			replyFeedback: (req) => {
				operator();
				const f = findFeedback(req.feedbackId);
				if (f.replyText !== "") throw new ConnectError("already_replied: this feedback was already answered", Code.FailedPrecondition);
				if (req.text.trim() === "") throw new ConnectError("text is required", Code.InvalidArgument);
				f.replyText = req.text.trim();
				f.status = FeedbackStatus.HANDLED;
				f.handledBy = this.selfId;
				return { feedback: feedback(f) };
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
		setDialogUnreadMark: (chatId, unread) => core.setDialogUnreadMark(chatId, unread),
		setKeyboardHidden: (chatId, seq, hidden) => core.setKeyboardHidden(chatId, seq, hidden),
		botKeyboard: (chatId, botId) => core.botKeyboard(chatId, botId),
		notificationSettings: () => core.notificationSettings(),
		setNotificationSettings: (change) => core.setNotificationSettings(change),
		pinnedMessages: (chatId, request) => core.pinnedMessages(chatId, request),
		unpinAllMessages: (chatId, topicId) => core.unpinAllMessages(chatId, topicId),
		onlineCount: (chatId) => core.onlineCount(chatId),
		typing: async () => core.typing(),
		uploadPhoto: (file, fileName) => core.uploadPhoto(file, fileName),
		sendTyping: async (chatId, topicId, action) => core.sendTyping(chatId, topicId, action),
		sendMedia: (chatId, file, media, options) => core.sendMedia(chatId, file, media, options),
		sendAlbum: (chatId, items, options) => core.sendAlbum(chatId, items, options),
		uploadProgress: (key) => core.uploadProgress(key),
		pauseUpload: (key) => core.pauseUpload(key),
		resumeUpload: (key) => core.resumeUpload(key),
		pendingFile: (key) => core.pendingFile(key),
		mediaFile: (request) => core.mediaFile(request),
		mediaUrl: (request, refresh) => core.mediaUrl(request, refresh),
		mediaLimits: () => core.mediaLimits(),
		retryOutbox: (id) => core.retryOutbox(id),
		discardOutbox: (id) => core.discardOutbox(id),
		search: (query, options) => core.search(query, options),
		searchServer: (request) => core.searchServer(request),
		openChat: async (chatId, anchorSeq, visible) => core.openChat(chatId, anchorSeq, visible),
		connectionState: async () => core.connectionState(),
	};
}

/** Connector for <App messagingConnector>: the real core on the fixture server. */
export function fixtureConnector(fixture: ChatFixture, sql: () => Promise<SqlDriverFactory>): MessagingConnector {
	return async (options) => {
		const core = await fixture.startCore(await sql(), options.filterNotification);
		const client: MessagingClient = {
			source: toSource(core),
			createBackend: (remote, source) => new ServerBackend(remote, source, "https://chat.example.test"),
			coldSnapshot: () => null,
			saveSnapshot: async () => undefined,
			signOutAndLeave: () => core.signOut(),
			dispose: () => void core.close(),
		};
		return client;
	};
}
