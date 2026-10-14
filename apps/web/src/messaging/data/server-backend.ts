// PendingBackend on the R1 server: forum topics (GetForumTopics and the
// topic RPCs), link previews (stored by the core on each message, and
// GetLinkPreview while typing), reports and invite previews (CheckInvite).
// Mute, pinned chats, reactor lists, the blocked list and the moderation
// queue have no RPC yet and stay off.
import type { Message } from "@app/core";
import type {
	BlockedUser,
	InvitePreview,
	LinkPreview,
	ModerationDecision,
	ModerationDetail,
	ModerationRow,
	PendingBackend,
	PendingFeature,
	ReportReason,
	ReportTarget,
	Topic,
	TopicChange,
} from "./pending-backend.ts";
import { FeatureUnavailableError } from "./pending-backend.ts";
import type { Remote } from "./remote.ts";
import type { ChatSource } from "./source.ts";

import { GENERAL_TOPIC } from "./general-topic.ts";
const RELOAD_DELAY_MS = 250;

const unavailable = (feature: PendingFeature) => (): Promise<never> => Promise.reject(new FeatureUnavailableError(feature));

export class ServerBackend implements PendingBackend {
	readonly features: ReadonlySet<PendingFeature> = new Set<PendingFeature>(["topics", "linkPreview", "report", "invitePreview"]);
	private readonly cache = new Map<number, Topic[]>();
	private readonly inFlight = new Set<number>();
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: () => void;
	private serial = 0;

	constructor(
		protected readonly remote: Remote,
		source: ChatSource,
		private readonly origin: string = window.location.origin,
	) {
		// New messages, reads and topic changes of a loaded forum refresh its topics.
		this.unsubscribe = source.events.subscribeBatches((keys) => {
			for (const key of keys) {
				const [kind, id] = key.split(":");
				if (kind !== "chat" && kind !== "history" && kind !== "dialog") continue;
				const chatId = Number(id);
				if (this.cache.has(chatId)) this.scheduleReload(chatId);
			}
		});
	}

	dispose(): void {
		this.unsubscribe();
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		this.listeners.clear();
	}

	protected emit(): void {
		this.serial++;
		for (const listener of [...this.listeners]) listener();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	version(): number {
		return this.serial;
	}

	// ------------------------------------------------------------- topics

	topics(chatId: number): readonly Topic[] | null {
		return this.cache.get(chatId) ?? null;
	}

	loadTopics(chatId: number): void {
		if (this.cache.has(chatId)) return;
		void this.fetchTopics(chatId);
	}

	private scheduleReload(chatId: number): void {
		clearTimeout(this.timers.get(chatId));
		this.timers.set(
			chatId,
			setTimeout(() => {
				this.timers.delete(chatId);
				void this.fetchTopics(chatId);
			}, RELOAD_DELAY_MS),
		);
	}

	private async fetchTopics(chatId: number): Promise<void> {
		if (this.inFlight.has(chatId)) return;
		this.inFlight.add(chatId);
		try {
			const [page, { toTopic }] = await Promise.all([this.remote.forumTopics(chatId), import("./topic-mapping.ts")]);
			const tops = new Map(page.tops.map((top) => [top.seq, top]));
			this.cache.set(
				chatId,
				page.topics.map((topic) => toTopic(chatId, topic, tops, this.origin)),
			);
			this.emit();
		} catch {
			// The list stays as it was; the next change of the chat retries.
		} finally {
			this.inFlight.delete(chatId);
		}
	}

	messageTopic(message: Message): number {
		if (message.topicId !== 0) return message.topicId;
		return this.cache.has(message.chatId) ? GENERAL_TOPIC : 0;
	}

	async setTopic(chatId: number, topicId: number, change: TopicChange): Promise<void> {
		if (change.pinned !== undefined) await this.remote.pinTopic(chatId, topicId, change.pinned);
		if (change.closed !== undefined) await this.remote.closeTopic(chatId, topicId, change.closed);
		if (change.hidden !== undefined) await this.remote.hideTopic(chatId, topicId, change.hidden);
		await this.fetchTopics(chatId);
	}

	async sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number): Promise<void> {
		await this.remote.sendToTopic(chatId, topicId, text, replyToSeq);
	}

	async readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void> {
		await this.remote.readTopic(chatId, topicId, maxSeq);
		const list = this.cache.get(chatId);
		if (list !== undefined) {
			this.cache.set(
				chatId,
				list.map((topic) => (topic.id === topicId ? { ...topic, unreadCount: 0, unreadMentions: 0 } : topic)),
			);
			this.emit();
		}
	}

	// ------------------------------------------------------------- link previews

	linkPreview(message: Message): LinkPreview | null {
		const preview = message.linkPreview;
		if (preview === null || preview.title === "") return null;
		return { url: preview.url, site: preview.siteName || hostName(preview.url), title: preview.title, description: preview.description };
	}

	async composePreview(url: string): Promise<LinkPreview | null> {
		const preview = await this.remote.linkPreview(url);
		if (preview === null) return null;
		return { url, site: preview.siteName || hostName(url), title: preview.title, description: preview.description };
	}

	// ------------------------------------------------------------- reports and invites

	report(target: ReportTarget, reason: ReportReason, note: string): Promise<void> {
		return this.remote.report(target, reason, note);
	}

	async invitePreview(token: string): Promise<InvitePreview | null> {
		const check = await this.remote.checkInvite(token);
		return {
			title: check.title,
			kind: check.kind === "channel" ? "channel" : "group",
			memberCount: check.memberCount,
			historyShared: null,
			sampleNames: [],
			memberOfChatId: check.memberOfChatId,
		};
	}

	// ------------------------------------------------------------- not on the server yet

	reactors(_chatId: number, _seq: number, _emoji: string): readonly number[] | null {
		return null;
	}

	isMuted(_chatId: number): boolean {
		return false;
	}

	setMuted(_chatId: number, _muted: boolean): Promise<void> {
		return unavailable("mute")();
	}

	isPinnedDialog(_chatId: number): boolean {
		return false;
	}

	blockedUsers(): Promise<readonly BlockedUser[]> {
		return unavailable("blockedList")();
	}

	async moderationScope(): Promise<string | null> {
		return null;
	}

	moderationQueue(): Promise<readonly ModerationRow[]> {
		return unavailable("moderation")();
	}

	moderationDetail(_id: string): Promise<ModerationDetail | null> {
		return unavailable("moderation")();
	}

	claimReport(_id: string): Promise<void> {
		return unavailable("moderation")();
	}

	decideReport(_id: string, _decision: ModerationDecision | "skip"): Promise<void> {
		return unavailable("moderation")();
	}
}

function hostName(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
}
