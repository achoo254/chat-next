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
	readonly unreadCount: number;
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
}

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
	leaveChat(chatId: number): Promise<void>;
	setAdmin(chatId: number, userId: number, admin: boolean): Promise<void>;
	setDefaultPermissions(chatId: number, permissions: number): Promise<void>;
	setHistoryShared(chatId: number, shared: boolean): Promise<void>;
	exportInvite(chatId: number, expiresAt: number, usageLimit: number): Promise<Invite>;
	joinByInvite(link: string): Promise<number>;
	searchPeople(query: string): Promise<Person[]>;
	people(ids: readonly number[]): Promise<Person[]>;
	block(userId: number): Promise<void>;
	unblock(userId: number): Promise<void>;
	privacy(): Promise<Privacy>;
	setPrivacy(change: Partial<Privacy>): Promise<Privacy>;
	forumTopics(chatId: number): Promise<{ topics: ServerTopic[]; tops: TopicTop[] }>;
	pinTopic(chatId: number, topicId: number, pinned: boolean): Promise<void>;
	closeTopic(chatId: number, topicId: number, closed: boolean): Promise<void>;
	hideTopic(chatId: number, topicId: number, hidden: boolean): Promise<void>;
	sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number): Promise<void>;
	readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void>;
	linkPreview(url: string): Promise<WebPreview | null>;
	report(target: ReportTarget, reason: ReportReason, comment: string): Promise<void>;
	checkInvite(link: string): Promise<InviteCheck>;
	inviteLinks(chatId: number): Promise<Invite[]>;
	revokeInvite(chatId: number, link: string): Promise<Invite>;
	/** Members who read a message (small groups, recent messages only). */
	readers(chatId: number, seq: number): Promise<Person[]>;
}

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
	return {
		limits: () => load().then((r) => r.limits()),
		setReaction: (chatId, seq, emoji) => load().then((r) => r.setReaction(chatId, seq, emoji)),
		pin: (chatId, seq) => load().then((r) => r.pin(chatId, seq)),
		unpin: (chatId, seq) => load().then((r) => r.unpin(chatId, seq)),
		forward: (fromChatId, seqs, toChatId) => load().then((r) => r.forward(fromChatId, seqs, toChatId)),
		createPrivate: (userId) => load().then((r) => r.createPrivate(userId)),
		createGroup: (title, userIds) => load().then((r) => r.createGroup(title, userIds)),
		createChannel: (title, about) => load().then((r) => r.createChannel(title, about)),
		members: (chatId, query, cursor) => load().then((r) => r.members(chatId, query, cursor)),
		addMembers: (chatId, userIds) => load().then((r) => r.addMembers(chatId, userIds)),
		leaveChat: (chatId) => load().then((r) => r.leaveChat(chatId)),
		setAdmin: (chatId, userId, admin) => load().then((r) => r.setAdmin(chatId, userId, admin)),
		setDefaultPermissions: (chatId, permissions) => load().then((r) => r.setDefaultPermissions(chatId, permissions)),
		setHistoryShared: (chatId, shared) => load().then((r) => r.setHistoryShared(chatId, shared)),
		exportInvite: (chatId, expiresAt, usageLimit) => load().then((r) => r.exportInvite(chatId, expiresAt, usageLimit)),
		joinByInvite: (link) => load().then((r) => r.joinByInvite(link)),
		searchPeople: (query) => load().then((r) => r.searchPeople(query)),
		people: (ids) => load().then((r) => r.people(ids)),
		block: (userId) => load().then((r) => r.block(userId)),
		unblock: (userId) => load().then((r) => r.unblock(userId)),
		privacy: () => load().then((r) => r.privacy()),
		setPrivacy: (change) => load().then((r) => r.setPrivacy(change)),
		forumTopics: (chatId) => load().then((r) => r.forumTopics(chatId)),
		pinTopic: (chatId, topicId, pinned) => load().then((r) => r.pinTopic(chatId, topicId, pinned)),
		closeTopic: (chatId, topicId, closed) => load().then((r) => r.closeTopic(chatId, topicId, closed)),
		hideTopic: (chatId, topicId, hidden) => load().then((r) => r.hideTopic(chatId, topicId, hidden)),
		sendToTopic: (chatId, topicId, text, replyToSeq) => load().then((r) => r.sendToTopic(chatId, topicId, text, replyToSeq)),
		readTopic: (chatId, topicId, maxSeq) => load().then((r) => r.readTopic(chatId, topicId, maxSeq)),
		linkPreview: (url) => load().then((r) => r.linkPreview(url)),
		report: (target, reason, comment) => load().then((r) => r.report(target, reason, comment)),
		checkInvite: (link) => load().then((r) => r.checkInvite(link)),
		inviteLinks: (chatId) => load().then((r) => r.inviteLinks(chatId)),
		revokeInvite: (chatId, link) => load().then((r) => r.revokeInvite(chatId, link)),
		readers: (chatId, seq) => load().then((r) => r.readers(chatId, seq)),
	};
}
