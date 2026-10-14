// PendingBackend on the R1 server: forum topics (GetForumTopics, paged, and
// the topic RPCs), link previews (stored by the core on each message, and
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
import type { TopicPages } from "./topic-mapping.ts";
import type { ChatSource } from "./source.ts";
import { GENERAL_TOPIC } from "./general-topic.ts";

const RELOAD_DELAY_MS = 250;

type TopicPaging = typeof import("./topic-mapping.ts");

const unavailable = (feature: PendingFeature) => (): Promise<never> => Promise.reject(new FeatureUnavailableError(feature));

export class ServerBackend implements PendingBackend {
	readonly features: ReadonlySet<PendingFeature> = new Set<PendingFeature>(["topics", "linkPreview", "report", "invitePreview"]);
	private readonly cache = new Map<number, TopicPages>();
	private readonly inFlight = new Set<number>();
	/** Chats that changed while their topics were loading: reload once the load ends. */
	private readonly stale = new Set<number>();
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
		return this.cache.get(chatId)?.topics ?? null;
	}

	loadTopics(chatId: number): void {
		if (this.cache.has(chatId)) return;
		void this.fetchTopics(chatId, 1);
	}

	hasMoreTopics(chatId: number): boolean {
		return (this.cache.get(chatId)?.nextCursor ?? "") !== "";
	}

	loadMoreTopics(chatId: number): void {
		const cached = this.cache.get(chatId);
		if (cached === undefined || cached.nextCursor === "" || this.inFlight.has(chatId)) return;
		void this.load(chatId, (paging) => paging.loadNextTopicPage(this.remote, chatId, cached, this.origin));
	}

	private scheduleReload(chatId: number): void {
		clearTimeout(this.timers.get(chatId));
		this.timers.set(
			chatId,
			setTimeout(() => {
				this.timers.delete(chatId);
				void this.fetchTopics(chatId, this.cache.get(chatId)?.pages ?? 1);
			}, RELOAD_DELAY_MS),
		);
	}

	/** Loads the first `pages` pages again (a reload keeps what the user scrolled to). */
	private fetchTopics(chatId: number, pages: number): Promise<void> {
		return this.load(chatId, (paging) => paging.loadTopicPages(this.remote, chatId, pages, this.origin));
	}

	/** Runs one load of a forum's topics at a time; a change during a load reloads after it. */
	private async load(chatId: number, run: (paging: TopicPaging) => Promise<TopicPages>): Promise<void> {
		if (this.inFlight.has(chatId)) {
			this.stale.add(chatId);
			return;
		}
		this.inFlight.add(chatId);
		try {
			this.cache.set(chatId, await run(await import("./topic-mapping.ts")));
			this.emit();
		} catch {
			// The list stays as it was; the next change of the chat retries.
		} finally {
			this.inFlight.delete(chatId);
			if (this.stale.delete(chatId)) this.scheduleReload(chatId);
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
		await this.fetchTopics(chatId, this.cache.get(chatId)?.pages ?? 1);
	}

	async sendToTopic(chatId: number, topicId: number, text: string, replyToSeq: number, noLinkPreview = false): Promise<void> {
		await this.remote.sendToTopic(chatId, topicId, text, replyToSeq, noLinkPreview);
	}

	async readTopic(chatId: number, topicId: number, maxSeq: number): Promise<void> {
		await this.remote.readTopic(chatId, topicId, maxSeq);
		const cached = this.cache.get(chatId);
		if (cached !== undefined) {
			this.cache.set(chatId, {
				...cached,
				topics: cached.topics.map((topic) => (topic.id === topicId ? { ...topic, unreadCount: 0, unreadMentions: 0 } : topic)),
			});
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
			historyShared: check.historyShared,
			members: check.members.map((person) => ({ id: person.id, name: person.name, isBot: person.isBot })),
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

	setMuted(_chatId: number, _muted: boolean, _forSeconds?: number): Promise<void> {
		return unavailable("mute")();
	}

	isPinnedDialog(_chatId: number): boolean {
		return false;
	}

	setPinnedDialog(_chatId: number, _pinned: boolean): Promise<void> {
		return unavailable("pinnedDialogs")();
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
