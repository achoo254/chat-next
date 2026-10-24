// The UI's view of server features that vary by backend release: forum
// topics, link previews, reports and invite previews (see server-backend.ts).
// The UI asks `features` before it shows any of them, so a missing one is
// simply hidden. Everything else (contacts, bans, mute, pinned chats, the
// blocked list, moderation) is a plain RPC on Remote, on every R1 server;
// mute and pinned chats reach the dialog list through the client core.
import type { Message } from "@achoo254/chat-core";

export type PendingFeature = "topics" | "linkPreview" | "report" | "invitePreview";

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
	/** Newest message of the topic. */
	readonly topSeq: number;
	/** The reader's read position in this topic (a forum keeps one per topic). */
	readonly readInboxMaxSeq: number;
	/** Counted up to 1000 by the server (shown as "999+"). */
	readonly unreadCount: number;
	readonly unreadMentions: number;
	/** 0 when the server does not count it. */
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
	/** A few members to show as avatars (groups). */
	readonly members: readonly { readonly id: number; readonly name: string; readonly isBot: boolean }[];
	/** Set when the user is already a member: open this chat instead. */
	readonly memberOfChatId: number;
}

export interface PendingBackend {
	readonly features: ReadonlySet<PendingFeature>;
	/** Cached topics of a group, or null when it has none (or they are not loaded yet). */
	topics(chatId: number): readonly Topic[] | null;
	/** Fetches the first page of a group's topics; `subscribe` listeners run when they arrive. */
	loadTopics(chatId: number): void;
	/** Whether the server has more topics than the cached pages. */
	hasMoreTopics(chatId: number): boolean;
	/** Fetches the next page of topics (no-op while one is loading or none is left). */
	loadMoreTopics(chatId: number): void;
	/** Topic of a message in a group with topics; 0 elsewhere. */
	messageTopic(message: Message): number;
	setTopic(chatId: number, topicId: number, change: TopicChange): Promise<void>;
	sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number, noLinkPreview?: boolean): Promise<void>;
	readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void>;
	/** Preview the server attached to a message, if any. */
	linkPreview(message: Message): LinkPreview | null;
	/** Preview for a URL being typed in the composer. */
	composePreview(url: string): Promise<LinkPreview | null>;
	report(target: ReportTarget, reason: ReportReason, note: string): Promise<void>;
	invitePreview(token: string): Promise<InvitePreview | null>;
	/** Re-render signal for state kept by the backend (topics). */
	subscribe(listener: () => void): () => void;
	/** Stops listening to the client (sign-out, unmount). */
	dispose(): void;
}
