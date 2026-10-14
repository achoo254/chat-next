// The UI's view of server features that vary by backend release: forum
// topics, link previews, reports and invite previews (on the R1 server, see
// server-backend.ts) and mute, pinned chats, per-reaction user lists, the
// blocked list and the moderation queue (no RPC yet). The UI asks `features`
// before it shows any of them, so a missing one is simply hidden.
import type { Message } from "@app/core";

export type PendingFeature =
	| "topics"
	| "linkPreview"
	| "reactors"
	| "mute"
	| "pinnedDialogs"
	| "report"
	| "blockedList"
	| "invitePreview"
	| "moderation"
	/**
	 * Pending flows decided after the R1 security review, wired once their
	 * mock screens and RPCs land: an explicit contacts list
	 * (AddContact/DeleteContact/GetContacts) behind "Danh bạ", and member
	 * bans (removing a member bans them; UnbanMember, GetBannedMembers).
	 * The UI offers neither yet. Owner leave is handled: LeaveChat answers
	 * FailedPrecondition until another admin exists.
	 */
	| "contacts"
	| "bans";

/** Icons a topic can carry (mockups/chat.html#topics). */
export type TopicIcon = "hash" | "megaphone" | "edit" | "code" | "flag" | "inbox" | "users" | "database";
export type Tone = "violet" | "green" | "blue" | "amber" | "cyan" | "red" | "grey";

export interface Topic {
	readonly id: number;
	readonly title: string;
	readonly icon: TopicIcon;
	readonly tone: Tone;
	/** The built-in "General" topic: always first, cannot be closed. */
	readonly general: boolean;
	readonly pinned: boolean;
	readonly closed: boolean;
	readonly hidden: boolean;
	readonly muted: boolean;
	readonly unreadCount: number;
	readonly unreadMentions: number;
	readonly messageCount: number;
	readonly lastMessage: { readonly fromId: number; readonly text: string; readonly date: number } | null;
	readonly createdBy: number;
	readonly createdAt: number;
	/** Who closed or hid the topic; 0 when it is open and visible. */
	readonly changedBy: number;
	readonly changedAt: number;
	/** Shareable link that only members can open. */
	readonly link: string;
}

export interface TopicChange {
	readonly pinned?: boolean;
	readonly closed?: boolean;
	readonly hidden?: boolean;
}

/** Text-only link preview fetched by the server (images come with R3). */
export interface LinkPreview {
	readonly url: string;
	readonly site: string;
	readonly title: string;
	readonly description: string;
}

export type ReportReason = "spam" | "scam" | "violence" | "sexual" | "other";

export type ReportTarget =
	| { readonly kind: "message"; readonly chatId: number; readonly seq: number }
	| { readonly kind: "user"; readonly userId: number }
	| { readonly kind: "chat"; readonly chatId: number };

export interface InvitePreview {
	readonly title: string;
	readonly kind: "group" | "channel";
	readonly memberCount: number;
	/** Whether new members read earlier messages; null when the server does not say. */
	readonly historyShared: boolean | null;
	/** A few members to show as avatars. */
	readonly sampleNames: readonly string[];
	/** Set when the user is already a member: open this chat instead. */
	readonly memberOfChatId: number;
}

export interface BlockedUser {
	readonly id: number;
	readonly name: string;
	readonly username: string;
	readonly isBot: boolean;
	/** Unix seconds. */
	readonly blockedAt: number;
}

export type ModerationObject = "message" | "user" | "bot" | "channel" | "webhook";
export type ModerationStatus = "open" | "handled" | "skipped";

export interface ModerationRow {
	readonly id: string;
	readonly object: ModerationObject;
	readonly title: string;
	readonly subtitle: string;
	readonly reason: ReportReason;
	readonly reports: number;
	readonly status: ModerationStatus;
	/** Display name of the moderator reviewing it, "" when nobody is. */
	readonly reviewer: string;
	/** Unix seconds. */
	readonly latestAt: number;
}

export interface ModerationContextMessage {
	readonly seq: number;
	readonly fromName: string;
	readonly text: string;
	readonly date: number;
	readonly reported: boolean;
}

export interface ModerationDetail {
	readonly row: ModerationRow;
	readonly context: readonly ModerationContextMessage[];
	readonly reasons: readonly { readonly reason: ReportReason; readonly count: number }[];
	readonly notes: readonly string[];
	readonly history: readonly { readonly action: string; readonly by: string; readonly at: number; readonly note: string }[];
}

export type ModerationAction = "remove" | "lock" | "warn" | "disable_webhook";
export type LockDuration = "day" | "week" | "month" | "forever";

export interface ModerationDecision {
	readonly actions: readonly ModerationAction[];
	readonly lock: LockDuration;
	readonly reason: string;
	readonly notify: boolean;
}

export interface PendingBackend {
	readonly features: ReadonlySet<PendingFeature>;
	/** Cached topics of a group, or null when it has none (or they are not loaded yet). */
	topics(chatId: number): readonly Topic[] | null;
	/** Fetches the topics of a group; `subscribe` listeners run when they arrive. */
	loadTopics(chatId: number): void;
	/** Topic of a message in a group with topics; 0 elsewhere. */
	messageTopic(message: Message): number;
	setTopic(chatId: number, topicId: number, change: TopicChange): Promise<void>;
	sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number): Promise<void>;
	readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void>;
	/** Preview the server attached to a message, if any. */
	linkPreview(message: Message): LinkPreview | null;
	/** Preview for a URL being typed in the composer. */
	composePreview(url: string): Promise<LinkPreview | null>;
	/** Users who reacted with `emoji` in small chats; null when only counts are known. */
	reactors(chatId: number, seq: number, emoji: string): readonly number[] | null;
	isMuted(chatId: number): boolean;
	setMuted(chatId: number, muted: boolean): Promise<void>;
	isPinnedDialog(chatId: number): boolean;
	report(target: ReportTarget, reason: ReportReason, note: string): Promise<void>;
	blockedUsers(): Promise<readonly BlockedUser[]>;
	invitePreview(token: string): Promise<InvitePreview | null>;
	moderationScope(): Promise<string | null>;
	moderationQueue(): Promise<readonly ModerationRow[]>;
	moderationDetail(id: string): Promise<ModerationDetail | null>;
	claimReport(id: string): Promise<void>;
	decideReport(id: string, decision: ModerationDecision | "skip"): Promise<void>;
	/** Re-render signal for state kept by the backend (topics, mute). */
	subscribe(listener: () => void): () => void;
	/** Changes whenever `subscribe` listeners are called. */
	version(): number;
	/** Stops listening to the client (sign-out, unmount). */
	dispose(): void;
}

export class FeatureUnavailableError extends Error {
	constructor(feature: PendingFeature) {
		super(`${feature} is not available on this server yet`);
		this.name = "FeatureUnavailableError";
	}
}
