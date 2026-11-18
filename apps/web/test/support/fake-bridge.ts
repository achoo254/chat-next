// In-memory BridgeService for tests: one user's connected apps, their
// conversations and the chats made from them. Never imported by production code.
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
	BridgeAccountStatus,
	BridgeConversationKind,
	BridgeDirection,
	BridgeLoginStepKind,
	BridgeOutboxStatus,
	BridgeService,
	type BridgeAccount,
	type BridgeCandidate,
	type BridgeConversation,
	type BridgeFeature,
	type BridgeInvite,
	type BridgeLoginStep,
	type BridgeOutboxItem,
} from "@achoo254/chat-proto/bridge";

export class FakeBridge {
	/** Answers every call with failed_precondition bridge_disabled. */
	disabled = false;
	/** The next mutating call fails with reauth_required. */
	reauth = false;
	apps = ["telegram"];
	accounts: BridgeAccount[] = [];
	conversations: BridgeConversation[] = [
		{ $typeName: "app.v1.BridgeConversation", id: "user:7", kind: BridgeConversationKind.PRIVATE, title: "Anh Đô CEO", chatId: 0n, forum: false, topicsSplit: false },
		{ $typeName: "app.v1.BridgeConversation", id: "chat:3", kind: BridgeConversationKind.GROUP, title: "Nhóm dự án", chatId: 0n, forum: false, topicsSplit: false },
		{ $typeName: "app.v1.BridgeConversation", id: "forum:1", kind: BridgeConversationKind.GROUP, title: "Diễn đàn nhóm", chatId: 0n, forum: true, topicsSplit: false },
	];
	/** What each chat has queued for the other app (by chat id). Tests set it; a retry or a dismiss removes what it handles. */
	outbox = new Map<number, BridgeOutboxItem[]>();
	/** How many times a chat's outbox was asked for. */
	outboxLooks = 0;
	/** The next enable call fails (after a remove, as when a forum is synced again). */
	failEnable = false;
	/** What the app can sync for a chat, by feature (a Telegram-like set); tests edit it. */
	features: BridgeFeature[] = [
		{ $typeName: "app.v1.BridgeFeature", feature: "messages", risk: "r2", direction: "in", isDefault: true, canReceive: true, canSend: true },
		{ $typeName: "app.v1.BridgeFeature", feature: "pins", risk: "r1", direction: "in", isDefault: true, canReceive: true, canSend: true },
		{ $typeName: "app.v1.BridgeFeature", feature: "topics", risk: "r2", direction: "in", isDefault: true, canReceive: true, canSend: true },
		{ $typeName: "app.v1.BridgeFeature", feature: "read", risk: "r1", direction: "in", isDefault: true, canReceive: true, canSend: false },
		{ $typeName: "app.v1.BridgeFeature", feature: "members", risk: "r3", direction: "off", isDefault: true, canReceive: true, canSend: true },
		{ $typeName: "app.v1.BridgeFeature", feature: "invites", risk: "r3", direction: "off", isDefault: true, canReceive: true, canSend: true },
		{ $typeName: "app.v1.BridgeFeature", feature: "lifecycle", risk: "r3", direction: "off", isDefault: true, canReceive: false, canSend: true },
	];
	/** The links of the other app for the first synced chat, and who could be added. */
	invites: BridgeInvite[] = [];
	candidates: BridgeCandidate[] = [{ $typeName: "app.v1.BridgeCandidate", participantId: "88", name: "Giang" }];
	/** The name the chat must be confirmed with, and how long the second confirmation of a delete waits (seconds). */
	chatName = "Anh Đô CEO";
	deleteWait = 1;
	private tokens = new Set<string>();
	/** The next call that sends on (switching to both, retrying) fails with send_unsupported. */
	sendUnsupported = false;
	/** The calls, in order, with the arguments that matter. */
	readonly calls: string[] = [];
	private nextChat = 900n;

	/** A connected account whose chat `chatId` sends on to the app (two-way), for the conversation tests. */
	seedTwoWay(chatId: number): void {
		this.accounts = [
			{
				$typeName: "app.v1.BridgeAccount",
				id: 1n,
				source: "telegram",
				status: BridgeAccountStatus.ACTIVE,
				lastError: "",
				chats: [
					{
						$typeName: "app.v1.BridgeSyncedChat",
						conversationId: "user:7",
						chatId: BigInt(chatId),
						caughtUp: true,
						historyWindow: 2000,
						title: "Anh Đô CEO",
						direction: BridgeDirection.BOTH,
						topicsSplit: false,
					},
				],
			},
		];
	}

	/** A connected account with two synced chats (one still importing) and a long list to pick from: the visual harness. */
	seedDemo(): void {
		const synced = (conversationId: string, chatId: bigint, title: string, window: number, caughtUp: boolean, direction = BridgeDirection.IN) => ({
			$typeName: "app.v1.BridgeSyncedChat" as const,
			conversationId,
			chatId,
			caughtUp,
			historyWindow: window,
			title,
			direction,
			topicsSplit: false,
		});
		this.accounts = [
			{
				$typeName: "app.v1.BridgeAccount",
				id: 1n,
				source: "telegram",
				status: BridgeAccountStatus.ACTIVE,
				lastError: "",
				chats: [
					synced("user:7", 900n, "Anh Đô CEO", 2000, true, BridgeDirection.BOTH),
					synced("chat:9", 901n, "Work - OneDash Audit Logs", 500, false),
				],
			},
		];
		const conv = (id: string, kind: BridgeConversationKind, title: string, chatId = 0n, forum = false, topicsSplit = false): BridgeConversation => ({
			$typeName: "app.v1.BridgeConversation",
			id,
			kind,
			title,
			chatId,
			forum,
			topicsSplit,
		});
		this.conversations = [
			conv("user:7", BridgeConversationKind.PRIVATE, "Anh Đô CEO", 900n),
			conv("chat:9", BridgeConversationKind.GROUP, "Work - OneDash Audit Logs", 901n, true, false),
			conv("bot:1", BridgeConversationKind.BOT, "tg_cloudpanel_staging_bot"),
			conv("chat:10", BridgeConversationKind.GROUP, "Anh em đoàn kết 🙈"),
			conv("chat:11", BridgeConversationKind.GROUP, "Work - Onemail monitor logs", 0n, true, false),
			conv("bot:2", BridgeConversationKind.BOT, "cloudpanel_dev_bot"),
			conv("user:8", BridgeConversationKind.PRIVATE, "Telegram"),
			conv("bot:3", BridgeConversationKind.BOT, "Bot_OneMail"),
			conv("chat:12", BridgeConversationKind.GROUP, "Work - iNET Helpdesk Center"),
			conv("chan:1", BridgeConversationKind.CHANNEL, "Tin công nghệ mỗi ngày"),
			conv("chat:13", BridgeConversationKind.GROUP, "Work - Nền tảng"),
			conv("user:9", BridgeConversationKind.PRIVATE, "Nguyễn Thị Lan"),
			conv("chat:14", BridgeConversationKind.GROUP, "Work - Claude Engineer Marketing"),
		];
	}

	private guard(mutating: boolean): void {
		if (this.disabled) throw new ConnectError("bridge_disabled: off", Code.FailedPrecondition);
		if (mutating && this.reauth) throw new ConnectError("reauth_required: sign in again", Code.FailedPrecondition);
	}

	private step(kind: BridgeLoginStepKind, loginId: string, fields: string[] = []): BridgeLoginStep {
		return {
			$typeName: "app.v1.BridgeLoginStep",
			kind,
			loginId,
			prompt: "",
			fields: fields.map((name) => ({ $typeName: "app.v1.BridgeLoginField", name, label: name, secret: true })),
		};
	}

	routes(router: ConnectRouter): void {
		router.service(BridgeService, {
			getBridgeStatus: () => {
				this.guard(false);
				return { apps: this.apps.map((source) => ({ $typeName: "app.v1.BridgeApp" as const, source })), accounts: this.accounts };
			},
			startBridgeLogin: (req) => {
				this.guard(true);
				this.calls.push(`start:${req.source}`);
				return { step: this.step(BridgeLoginStepKind.INPUT, "login-1", ["phone"]) };
			},
			continueBridgeLogin: (req) => {
				this.guard(true);
				this.calls.push(`continue:${Object.keys(req.input).join(",")}`);
				if (req.input["phone"] !== undefined) return { step: this.step(BridgeLoginStepKind.INPUT, "login-1", ["code"]) };
				if (req.input["code"] === "00000") throw new ConnectError("wrong_input: wrong_code: that code is not right", Code.InvalidArgument);
				if (req.input["code"] !== undefined) return { step: this.step(BridgeLoginStepKind.INPUT, "login-1", ["password"]) };
				this.accounts = [
					{ $typeName: "app.v1.BridgeAccount", id: 1n, source: "telegram", status: BridgeAccountStatus.ACTIVE, lastError: "", chats: [] },
				];
				return { step: { ...this.step(BridgeLoginStepKind.DONE, ""), account: this.accounts[0] } };
			},
			listBridgeConversations: () => {
				this.guard(false);
				return { conversations: this.conversations };
			},
			enableBridgeChat: (req) => {
				this.guard(true);
				this.calls.push(`enable:${req.conversationId}:${req.historyWindow}:${BridgeDirection[req.direction] ?? ""}`);
				if (this.failEnable) {
					this.failEnable = false;
					throw new ConnectError("internal error", Code.Internal);
				}
				const conv = this.conversations.find((c) => c.id === req.conversationId);
				if (conv === undefined) throw new ConnectError("not found", Code.NotFound);
				const chatId = this.nextChat++;
				conv.chatId = chatId;
				this.accounts[0]?.chats.push({
					$typeName: "app.v1.BridgeSyncedChat",
					conversationId: conv.id,
					chatId,
					caughtUp: true,
					historyWindow: req.historyWindow,
					title: conv.title,
					direction: req.direction === BridgeDirection.UNSPECIFIED ? BridgeDirection.BOTH : req.direction,
					// A forum enabled now is split into topics.
					topicsSplit: conv.forum,
				});
				conv.topicsSplit = conv.forum;
				return { chatId };
			},
			removeBridgeChat: (req) => {
				this.guard(true);
				this.calls.push(`remove:${req.conversationId}`);
				const account = this.accounts[0];
				if (account !== undefined) account.chats = account.chats.filter((c) => c.conversationId !== req.conversationId);
				for (const c of this.conversations) {
					if (c.id !== req.conversationId) continue;
					c.chatId = 0n;
					c.topicsSplit = false;
				}
				return {};
			},
			listBridgeInvites: () => {
				this.guard(false);
				return { invites: this.invites.map((i) => ({ ...i })) };
			},
			createBridgeInvite: (req) => {
				this.guard(false);
				this.calls.push(`invite:create:${req.title}`);
				this.invites.push({ $typeName: "app.v1.BridgeInvite", link: `https://t.me/+new${this.invites.length}`, title: req.title, revoked: false, usage: 0 });
				return {};
			},
			revokeBridgeInvite: (req) => {
				this.guard(false);
				this.calls.push(`invite:revoke:${req.link}`);
				this.invites = this.invites.map((i) => (i.link === req.link ? { ...i, revoked: true } : i));
				return {};
			},
			listBridgeCandidates: () => {
				this.guard(false);
				return { candidates: this.candidates.map((c) => ({ ...c })) };
			},
			addBridgeMember: (req) => {
				this.guard(false);
				this.calls.push(`member:add:${req.participantId}`);
				this.candidates = this.candidates.filter((c) => c.participantId !== req.participantId);
				return {};
			},
			leaveBridgeGroup: (req) => {
				this.guard(true);
				if (req.confirmName !== this.chatName) throw new ConnectError("confirmation_wrong: the name is not right", Code.InvalidArgument);
				this.calls.push("group:leave");
				return {};
			},
			requestBridgeGroupDelete: (req) => {
				this.guard(true);
				if (req.confirmName !== this.chatName) throw new ConnectError("confirmation_wrong: the name is not right", Code.InvalidArgument);
				const token = `tok${this.tokens.size}`;
				this.tokens.add(token);
				const now = Math.floor(Date.now() / 1000);
				return { token, usableFromUnix: BigInt(now + this.deleteWait), expiresUnix: BigInt(now + 300) };
			},
			deleteBridgeGroup: (req) => {
				this.guard(true);
				if (req.confirmName !== this.chatName || !this.tokens.delete(req.token)) throw new ConnectError("confirmation_wrong: not right", Code.InvalidArgument);
				this.calls.push("group:delete");
				return {};
			},
			listBridgeFeatures: (req) => {
				this.guard(false);
				this.calls.push(`features:${req.conversationId}`);
				if (this.accounts[0]?.chats.find((c) => c.conversationId === req.conversationId) === undefined) throw new ConnectError("not found", Code.NotFound);
				return { features: this.features.map((x) => ({ ...x })) };
			},
			setBridgeFeature: (req) => {
				this.guard(false);
				this.calls.push(`feature:${req.conversationId}:${req.feature}:${req.direction}`);
				const row = this.features.find((x) => x.feature === req.feature);
				if (row === undefined) throw new ConnectError("feature_unsupported: this app cannot do that", Code.FailedPrecondition);
				const ok = req.direction === "off" || (req.direction === "in" && row.canReceive) || (req.direction === "out" && row.canSend) || (req.direction === "both" && row.canReceive && row.canSend);
				if (!ok) throw new ConnectError("feature_unsupported: this app cannot do that", Code.FailedPrecondition);
				row.direction = req.direction;
				row.isDefault = false;
				return {};
			},
			setBridgeChatDirection: (req) => {
				this.guard(false);
				this.calls.push(`direction:${req.conversationId}:${BridgeDirection[req.direction] ?? ""}`);
				if (req.direction === BridgeDirection.BOTH && this.sendUnsupported) {
					throw new ConnectError("send_unsupported: this app cannot be written to", Code.FailedPrecondition);
				}
				const chat = this.accounts[0]?.chats.find((c) => c.conversationId === req.conversationId);
				if (chat === undefined) throw new ConnectError("not found", Code.NotFound);
				chat.direction = req.direction;
				return {};
			},
			listBridgeOutbox: (req) => {
				this.guard(false);
				this.outboxLooks++;
				return { items: this.outbox.get(Number(req.chatId)) ?? [] };
			},
			retryBridgeMessage: (req) => {
				this.guard(false);
				this.calls.push(`retry:${String(req.chatId)}:${String(req.seq)}`);
				const chatId = Number(req.chatId);
				this.outbox.set(
					chatId,
					(this.outbox.get(chatId) ?? []).map((item) =>
						item.seq === req.seq && (item.status === BridgeOutboxStatus.FAILED || item.status === BridgeOutboxStatus.UNKNOWN)
							? { ...item, status: BridgeOutboxStatus.PENDING, lastError: "", attempts: 0 }
							: item,
					),
				);
				return {};
			},
			dismissBridgeMessage: (req) => {
				this.guard(false);
				this.calls.push(`dismiss:${String(req.chatId)}:${String(req.seq)}`);
				const chatId = Number(req.chatId);
				this.outbox.set(chatId, (this.outbox.get(chatId) ?? []).filter((item) => item.seq !== req.seq));
				return {};
			},
			disconnectBridgeAccount: (req) => {
				this.guard(true);
				this.calls.push(`disconnect:${String(req.deleteChats)}`);
				const account = this.accounts[0];
				if (account === undefined) return {};
				if (req.deleteChats) this.accounts = [];
				else account.status = BridgeAccountStatus.STOPPED;
				return {};
			},
		});
	}
}
