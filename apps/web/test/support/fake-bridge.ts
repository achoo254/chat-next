// In-memory BridgeService for tests: one user's connected apps, their
// conversations and the chats made from them. Never imported by production code.
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import {
	BridgeAccountStatus,
	BridgeConversationKind,
	BridgeLoginStepKind,
	BridgeService,
	type BridgeAccount,
	type BridgeConversation,
	type BridgeLoginStep,
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
	/** The calls, in order, with the arguments that matter. */
	readonly calls: string[] = [];
	private nextChat = 900n;

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
				this.calls.push(`enable:${req.conversationId}:${req.historyWindow}`);
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
