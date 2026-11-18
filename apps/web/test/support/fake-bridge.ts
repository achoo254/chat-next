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
	type BridgeConversation,
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
		{ $typeName: "app.v1.BridgeConversation", id: "user:7", kind: BridgeConversationKind.PRIVATE, title: "Anh Đô CEO", chatId: 0n },
		{ $typeName: "app.v1.BridgeConversation", id: "chat:3", kind: BridgeConversationKind.GROUP, title: "Nhóm dự án", chatId: 0n },
	];
	/** What each chat has queued for the other app (by chat id). Tests set it; a retry or a dismiss removes what it handles. */
	outbox = new Map<number, BridgeOutboxItem[]>();
	/** How many times a chat's outbox was asked for. */
	outboxLooks = 0;
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
		const conv = (id: string, kind: BridgeConversationKind, title: string, chatId = 0n): BridgeConversation => ({
			$typeName: "app.v1.BridgeConversation",
			id,
			kind,
			title,
			chatId,
		});
		this.conversations = [
			conv("user:7", BridgeConversationKind.PRIVATE, "Anh Đô CEO", 900n),
			conv("chat:9", BridgeConversationKind.GROUP, "Work - OneDash Audit Logs", 901n),
			conv("bot:1", BridgeConversationKind.BOT, "tg_cloudpanel_staging_bot"),
			conv("chat:10", BridgeConversationKind.GROUP, "Anh em đoàn kết 🙈"),
			conv("chat:11", BridgeConversationKind.GROUP, "Work - Onemail monitor logs"),
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
				});
				return { chatId };
			},
			removeBridgeChat: (req) => {
				this.guard(true);
				this.calls.push(`remove:${req.conversationId}`);
				const account = this.accounts[0];
				if (account !== undefined) account.chats = account.chats.filter((c) => c.conversationId !== req.conversationId);
				for (const c of this.conversations) if (c.id === req.conversationId) c.chatId = 0n;
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
