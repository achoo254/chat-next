// Server calls the client core does not make (ADR 0001 mapping included):
// chat creation, members, invite links, reactions, pins, forwarding, blocking,
// privacy, per-chat settings (mute, pinned chats, delete) and the moderation
// queue. Their results reach the local database through the core's update
// stream; these calls only return what the UI needs right away.
import type { Transport } from "@connectrpc/connect";
import type { ReportReason, ReportTarget } from "./pending-backend.ts";

export type Presence =
	| { readonly kind: "online" }
	| { readonly kind: "offline"; readonly lastSeen: number }
	| { readonly kind: "recently" | "last_week" | "last_month" | "hidden" };

/** A user as search, member lists and profiles show them. Email is never kept. */
export interface Person {
	readonly id: number;
	readonly name: string;
	readonly username: string;
	readonly bio: string;
	readonly isBot: boolean;
	readonly isSelf: boolean;
	readonly isBlocked: boolean;
	readonly presence: Presence;
}

export type Role = "member" | "admin" | "owner";

export interface Member {
	readonly person: Person;
	readonly role: Role;
	readonly permissions: number;
	readonly inviterId: number;
	readonly joinedAt: number;
}

export interface Invite {
	readonly link: string;
	/** Unix seconds; 0 = never. */
	readonly expiresAt: number;
	/** 0 = unlimited. */
	readonly usageLimit: number;
	readonly usageCount: number;
	readonly revoked: boolean;
}

export type Audience = "everyone" | "contacts" | "nobody";

export interface Privacy {
	readonly lastSeen: Audience;
	readonly profilePhoto: Audience;
	readonly findByEmail: Audience;
	readonly findByUsername: Audience;
	readonly addToGroups: Audience;
	readonly sendMessages: Audience;
	readonly notificationPreview: boolean;
}

export interface Limits {
	/** Code points; 0 = unknown. */
	readonly messageLengthMax: number;
	/** Seconds; 0 = unknown (the server still enforces it). */
	readonly editTimeLimit: number;
	/** "Who read it" exists in groups up to this size (0 = unknown)... */
	readonly readReceiptsMemberMax: number;
	/** ...and for messages younger than this, in seconds. */
	readonly readReceiptsMaxAge: number;
}

/** A forum topic as GetForumTopics returns it, with the caller's read state. */
export interface ServerTopic {
	readonly id: number;
	readonly title: string;
	/** 0xRRGGBB. */
	readonly iconColor: number;
	readonly creatorId: number;
	readonly createdAt: number;
	readonly pinned: boolean;
	readonly closed: boolean;
	readonly hidden: boolean;
	readonly topSeq: number;
	readonly readInboxMaxSeq: number;
	/** Counted up to 1000 by the server. */
	readonly unreadCount: number;
	/** Glyph name from the client's icon set; "" for the default. */
	readonly icon: string;
	readonly messageCount: number;
	/** Unread messages that mention the caller or reply to them (up to 1000). */
	readonly unreadMentions: number;
}

export interface TopicTop {
	readonly seq: number;
	readonly fromId: number;
	readonly text: string;
	readonly date: number;
}

export interface WebPreview {
	readonly url: string;
	readonly siteName: string;
	readonly title: string;
	readonly description: string;
}

export interface InviteCheck {
	readonly title: string;
	readonly about: string;
	readonly kind: "group" | "channel" | "other";
	readonly memberCount: number;
	/** Set when the caller is already a member: open this chat instead. */
	readonly memberOfChatId: number;
	/** Groups: a few members (admins first). */
	readonly members: readonly Person[];
	/** Whether new members read earlier messages; null when the server does not say. */
	readonly historyShared: boolean | null;
}

/** One page of a list the server pages with an opaque cursor ("" = no more). */
export interface Page<T> {
	readonly items: T[];
	readonly nextCursor: string;
}

/** A user removed from a chat with a ban (GetBannedMembers). */
export interface BannedMember {
	readonly person: Person;
	readonly bannedBy: number;
	/** Name of the admin who removed them; "" when the server did not send that user. */
	readonly bannedByName: string;
	/** Unix seconds. */
	readonly bannedAt: number;
}

/** A member who read a message, with when (GetMessageReaders). */
export interface Reader {
	readonly person: Person;
	/** Unix seconds. */
	readonly readAt: number;
}

/** A contact with the date the caller added them (GetContacts). */
export interface Contact {
	readonly person: Person;
	/** Unix seconds; 0 when the server did not say. */
	readonly addedAt: number;
}

/** A user the caller blocked (GetBlockedUsers). */
export interface BlockedPerson {
	readonly person: Person;
	/** Unix seconds. */
	readonly blockedAt: number;
}

/** Why the server did not add a user to a chat (AddMembers, CreateGroup). */
export type AddFailureReason = "privacy" | "blocked" | "banned" | "already_member" | "too_many" | "not_found";

export interface AddFailure {
	readonly userId: number;
	readonly reason: AddFailureReason;
}

/** A group or channel two users share (GetCommonChats). */
export interface CommonChat {
	readonly id: number;
	readonly title: string;
	readonly channel: boolean;
	readonly memberCount: number;
}

/** One user's reaction to a message (GetMessageReactions). */
export interface Reactor {
	readonly person: Person;
	readonly emoji: string;
	/** Unix seconds. */
	readonly date: number;
}

/** SetDialogMute: muted for a number of seconds, until turned back on, or not at all (0). */
export type MuteFor = number | "forever";

export type ReportStatus = "open" | "resolved" | "dismissed";
export type ReportKind = "user" | "chat" | "messages";
/** What an operator can do with a report (ModerationService.ResolveReport). */
export type ModerationAction = "dismiss" | "delete_messages" | "ban_from_chat" | "restrict_account" | "lift_restriction";

/** A chat as the moderation screens name it. */
export interface ChatBrief {
	readonly id: number;
	readonly title: string;
	readonly channel: boolean;
	readonly memberCount: number;
}

export interface ModerationReport {
	readonly id: number;
	readonly kind: ReportKind;
	readonly reporterId: number;
	readonly targetUserId: number;
	readonly targetChatId: number;
	readonly seqs: readonly number[];
	readonly reason: ReportReason;
	readonly comment: string;
	readonly status: ReportStatus;
	readonly createdAt: number;
	readonly resolvedAt: number;
	readonly resolvedBy: number;
	readonly actions: readonly ModerationAction[];
	readonly resolutionNote: string;
}

export type FeedbackStatus = "open" | "handled";
export type FeedbackKind = "idea" | "bug";

/** What a user sent the assistant bot ("Góp ý" or "Báo lỗi"), with the operator's answer. */
export interface FeedbackItem {
	readonly id: number;
	readonly userId: number;
	readonly kind: FeedbackKind;
	readonly text: string;
	readonly status: FeedbackStatus;
	readonly createdAt: number;
	/** Handled items: when and by whom (0 while open). */
	readonly handledAt: number;
	readonly handledBy: number;
	/** The answer sent through the assistant; "" when none. */
	readonly replyText: string;
	readonly repliedAt: number;
	readonly repliedBy: number;
}

export interface FeedbackPage {
	readonly items: readonly FeedbackItem[];
	readonly people: ReadonlyMap<number, Person>;
	readonly nextCursor: string;
}

export interface ReportsPage {
	readonly reports: readonly ModerationReport[];
	readonly people: ReadonlyMap<number, Person>;
	readonly chats: ReadonlyMap<number, ChatBrief>;
	readonly nextCursor: string;
}

/** A message around a reported one, as it is now (deleted ones have no text). */
export interface ContextMessage {
	readonly seq: number;
	readonly fromId: number;
	readonly date: number;
	readonly text: string;
}

export interface ModerationEntry {
	readonly id: number;
	readonly operatorId: number;
	readonly action: ModerationAction;
	readonly targetUserId: number;
	readonly note: string;
	/** Restrictions: when it ends; 0 = until lifted. */
	readonly until: number;
	readonly createdAt: number;
}

export interface Restriction {
	readonly userId: number;
	/** 0 = until lifted. */
	readonly until: number;
	readonly reason: string;
	readonly createdAt: number;
}

export interface ReportDetail {
	readonly report: ModerationReport;
	/** The reported messages as filed. */
	readonly evidence: readonly { readonly seq: number; readonly fromId: number; readonly date: number; readonly text: string; readonly deleted: boolean }[];
	readonly context: readonly ContextMessage[];
	readonly people: ReadonlyMap<number, Person>;
	readonly chat: ChatBrief | null;
	readonly history: readonly ModerationEntry[];
	readonly restrictions: readonly Restriction[];
}

/** Who to add to the contact list: a user you can see, an exact username or an exact email. */
export type ContactTarget = { readonly userId: number } | { readonly username: string } | { readonly email: string };

/** ChatPermission bits (chats.proto). */
export const Permission = {
	sendMessages: 1,
	sendMedia: 2,
	addMembers: 4,
	pinMessages: 8,
	changeInfo: 16,
	manageTopics: 32,
} as const;

export interface Remote {
	limits(): Promise<Limits>;
	setReaction(chatId: number, seq: number, emoji: string): Promise<void>;
	/** `notify` false pins silently: members see the system line only. */
	pin(chatId: number, seq: number, notify?: boolean): Promise<void>;
	unpin(chatId: number, seq: number): Promise<void>;
	forward(fromChatId: number, seqs: readonly number[], toChatId: number): Promise<void>;
	createPrivate(userId: number): Promise<number>;
	/** `forum` creates the group with topics on. */
	createGroup(title: string, userIds: readonly number[], forum?: boolean): Promise<{ chatId: number; failures: AddFailure[] }>;
	createChannel(title: string, about: string): Promise<number>;
	members(chatId: number, query?: string, cursor?: string): Promise<{ members: Member[]; nextCursor: string }>;
	/** Everyone not added, with the reason (already members included). */
	addMembers(chatId: number, userIds: readonly number[]): Promise<AddFailure[]>;
	/** Removes a member; `ban` also keeps them from rejoining until an admin unbans them. */
	removeMember(chatId: number, userId: number, ban: boolean): Promise<void>;
	unbanMember(chatId: number, userId: number): Promise<void>;
	bannedMembers(chatId: number, cursor?: string): Promise<Page<BannedMember>>;
	/**
	 * Owners pass the admin who becomes the owner (0: the longest-serving
	 * admin). FailedPrecondition "owner_needs_admin…" when there is no admin.
	 */
	leaveChat(chatId: number, newOwnerId?: number): Promise<void>;
	setAdmin(chatId: number, userId: number, admin: boolean): Promise<void>;
	setDefaultPermissions(chatId: number, permissions: number): Promise<void>;
	setHistoryShared(chatId: number, shared: boolean): Promise<void>;
	/** Turns forum topics on for a group (admins; it cannot be turned off). */
	enableTopics(chatId: number): Promise<void>;
	exportInvite(chatId: number, expiresAt: number, usageLimit: number): Promise<Invite>;
	/** PermissionDenied when an admin removed and banned the caller. */
	joinByInvite(link: string): Promise<number>;
	searchPeople(query: string): Promise<Person[]>;
	people(ids: readonly number[]): Promise<Person[]>;
	block(userId: number): Promise<void>;
	unblock(userId: number): Promise<void>;
	privacy(): Promise<Privacy>;
	setPrivacy(change: Partial<Privacy>): Promise<Privacy>;
	/** The caller's own contact list, a page at a time (ordered by user id). */
	contacts(cursor?: string): Promise<Page<Contact>>;
	/** NotFound when the user is unknown or their privacy hides them from this kind of search. */
	addContact(target: ContactTarget): Promise<Person>;
	deleteContact(userId: number): Promise<void>;
	forumTopics(chatId: number, cursor?: string): Promise<{ topics: ServerTopic[]; tops: TopicTop[]; nextCursor: string }>;
	pinTopic(chatId: number, topicId: number, pinned: boolean): Promise<void>;
	closeTopic(chatId: number, topicId: number, closed: boolean): Promise<void>;
	hideTopic(chatId: number, topicId: number, hidden: boolean): Promise<void>;
	sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number, noLinkPreview?: boolean): Promise<void>;
	readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void>;
	linkPreview(url: string): Promise<WebPreview | null>;
	report(target: ReportTarget, reason: ReportReason, comment: string): Promise<void>;
	/** PermissionDenied when the caller is banned from the chat; NotFound when the link no longer admits anyone. */
	checkInvite(link: string): Promise<InviteCheck>;
	inviteLinks(chatId: number): Promise<Invite[]>;
	revokeInvite(chatId: number, link: string): Promise<Invite>;
	/** Members who read a message (small groups, recent messages only), most recent first. */
	readers(chatId: number, seq: number): Promise<Reader[]>;
	/** Mutes the caller's notifications of a chat; 0 unmutes. Returns the new mute end (Dialog.muteUntil). */
	setDialogMute(chatId: number, muteFor: MuteFor): Promise<number>;
	/** FailedPrecondition "pinned_dialogs_limit…" past PINNED_DIALOGS_MAX. Returns the pinned chats, top first. */
	setDialogPinned(chatId: number, pinned: boolean): Promise<number[]>;
	/** Private chats: for the caller only. Groups and channels: the owner deletes it for everyone. */
	deleteChat(chatId: number): Promise<void>;
	/** Groups and channels shared with a user, and how many in all. */
	commonChats(userId: number): Promise<{ chats: CommonChat[]; count: number }>;
	/** Who reacted to a message, newest first; `emoji` "" lists every reaction. */
	reactions(chatId: number, seq: number, emoji: string, cursor?: string): Promise<Page<Reactor>>;
	blockedUsers(cursor?: string): Promise<Page<BlockedPerson>>;
	moderationReports(status: ReportStatus, cursor?: string): Promise<ReportsPage>;
	moderationReport(reportId: number): Promise<ReportDetail>;
	/** `restrictSeconds` 0 restricts until lifted (restrict_account only). */
	resolveReport(reportId: number, actions: readonly ModerationAction[], note: string, restrictSeconds: number): Promise<ModerationReport>;
	liftRestriction(userId: number, note: string): Promise<void>;
	moderationFeedback(status: FeedbackStatus, cursor?: string): Promise<FeedbackPage>;
	resolveFeedback(feedbackId: number): Promise<FeedbackItem>;
	/** FailedPrecondition "already_replied…" for an item already answered. */
	replyFeedback(feedbackId: number, text: string): Promise<FeedbackItem>;
}

const METHODS = [
	"limits",
	"setReaction",
	"pin",
	"unpin",
	"forward",
	"createPrivate",
	"createGroup",
	"createChannel",
	"members",
	"addMembers",
	"removeMember",
	"unbanMember",
	"bannedMembers",
	"leaveChat",
	"setAdmin",
	"setDefaultPermissions",
	"setHistoryShared",
	"enableTopics",
	"exportInvite",
	"joinByInvite",
	"searchPeople",
	"people",
	"block",
	"unblock",
	"privacy",
	"setPrivacy",
	"contacts",
	"addContact",
	"deleteContact",
	"forumTopics",
	"pinTopic",
	"closeTopic",
	"hideTopic",
	"sendToTopic",
	"readTopic",
	"linkPreview",
	"report",
	"checkInvite",
	"inviteLinks",
	"revokeInvite",
	"readers",
	"setDialogMute",
	"setDialogPinned",
	"deleteChat",
	"commonChats",
	"reactions",
	"blockedUsers",
	"moderationReports",
	"moderationReport",
	"resolveReport",
	"liftRestriction",
	"moderationFeedback",
	"resolveFeedback",
	"replyFeedback",
] as const satisfies readonly (keyof Remote)[];

// Fails to compile when a Remote method is missing from METHODS.
const everyMethodForwarded: [Exclude<keyof Remote, (typeof METHODS)[number]>] extends [never] ? true : never = true;
void everyMethodForwarded;

/**
 * Builds the server calls on `transport`. The Connect clients and their
 * schemas load on the first call, so the first screen does not wait for them.
 * `onUnauthenticated` runs when the session is gone; the error is rethrown.
 */
/** The Connect clients' code; fetched ahead by screens whose first data comes through Remote. */
export const loadRemoteClient = () => import("./remote-client.ts");

export function createRemote(transport: Transport, onUnauthenticated: () => void): Remote {
	let client: Promise<Remote> | null = null;
	const load = (): Promise<Remote> => {
		client ??= loadRemoteClient().then((module) => module.createRemoteClient(transport, onUnauthenticated));
		return client;
	};
	// Each method waits for the client and passes its arguments through
	// unchanged, so the forwarder keeps the signature of the method it stands
	// for (checked above against the Remote interface).
	const forward =
		(method: (typeof METHODS)[number]) =>
		(...args: unknown[]): Promise<unknown> =>
			load().then((remote): unknown => Reflect.apply(remote[method], remote, args));
	return Object.fromEntries(METHODS.map((method) => [method, forward(method)])) as unknown as Remote;
}
