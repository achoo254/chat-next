// Server calls the client core does not make (ADR 0001 mapping included):
// chat creation, members, invite links, reactions, pins, forwarding, blocking
// and privacy. Their results reach the local database through the core's
// update stream; these calls only return what the UI needs right away.
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
	pin(chatId: number, seq: number): Promise<void>;
	unpin(chatId: number, seq: number): Promise<void>;
	forward(fromChatId: number, seqs: readonly number[], toChatId: number): Promise<void>;
	createPrivate(userId: number): Promise<number>;
	createGroup(title: string, userIds: readonly number[]): Promise<{ chatId: number; failedUserIds: number[] }>;
	createChannel(title: string, about: string): Promise<number>;
	members(chatId: number, query?: string, cursor?: string): Promise<{ members: Member[]; nextCursor: string }>;
	addMembers(chatId: number, userIds: readonly number[]): Promise<number[]>;
	/** Removes a member; `ban` also keeps them from rejoining until an admin unbans them. */
	removeMember(chatId: number, userId: number, ban: boolean): Promise<void>;
	unbanMember(chatId: number, userId: number): Promise<void>;
	bannedMembers(chatId: number, cursor?: string): Promise<Page<BannedMember>>;
	/** FailedPrecondition "owner_needs_admin…" when an owner would leave members without an admin. */
	leaveChat(chatId: number): Promise<void>;
	setAdmin(chatId: number, userId: number, admin: boolean): Promise<void>;
	setDefaultPermissions(chatId: number, permissions: number): Promise<void>;
	setHistoryShared(chatId: number, shared: boolean): Promise<void>;
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
	contacts(cursor?: string): Promise<Page<Person>>;
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
] as const satisfies readonly (keyof Remote)[];

// Fails to compile when a Remote method is missing from METHODS.
const everyMethodForwarded: [Exclude<keyof Remote, (typeof METHODS)[number]>] extends [never] ? true : never = true;
void everyMethodForwarded;

/**
 * Builds the server calls on `transport`. The Connect clients and their
 * schemas load on the first call, so the first screen does not wait for them.
 * `onUnauthenticated` runs when the session is gone; the error is rethrown.
 */
export function createRemote(transport: Transport, onUnauthenticated: () => void): Remote {
	let client: Promise<Remote> | null = null;
	const load = (): Promise<Remote> => {
		client ??= import("./remote-client.ts").then((module) => module.createRemoteClient(transport, onUnauthenticated));
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
