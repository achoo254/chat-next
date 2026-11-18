// Connect implementation of BridgeApi (see bridge-api.ts), loaded with the
// "Kết nối ứng dụng" settings tab.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@achoo254/chat-core";
import {
	BridgeAccountStatus as WireStatus,
	BridgeConversationKind,
	BridgeDirection as WireDirection,
	BridgeLoginStepKind,
	BridgeOutboxStatus as WireOutboxStatus,
	BridgeService,
	type BridgeAccount as WireAccount,
	type BridgeLoginStep as WireStep,
} from "@achoo254/chat-proto/bridge";
import {
	BridgeError,
	type BridgeAccount,
	type BridgeAccountStatus,
	type BridgeApi,
	type BridgeDirection,
	type BridgeErrorKind,
	type BridgeOutboxItem,
	type ConversationKind,
	type LoginStep,
} from "./bridge-api.ts";

const STATUSES: Partial<Record<WireStatus, BridgeAccountStatus>> = {
	[WireStatus.ACTIVE]: "active",
	[WireStatus.NEEDS_LOGIN]: "needs_login",
	[WireStatus.STOPPED]: "stopped",
};

const KINDS: Partial<Record<BridgeConversationKind, ConversationKind>> = {
	[BridgeConversationKind.PRIVATE]: "private",
	[BridgeConversationKind.BOT]: "bot",
	[BridgeConversationKind.GROUP]: "group",
	[BridgeConversationKind.CHANNEL]: "channel",
};

const OUTBOX_STATUSES: Partial<Record<WireOutboxStatus, BridgeOutboxItem["status"]>> = {
	[WireOutboxStatus.PENDING]: "pending",
	[WireOutboxStatus.SENDING]: "sending",
	[WireOutboxStatus.FAILED]: "failed",
	[WireOutboxStatus.UNKNOWN]: "unknown",
};

const OPS: readonly BridgeOutboxItem["op"][] = ["send", "edit", "delete"];

function toWireDirection(direction: BridgeDirection | undefined): WireDirection {
	if (direction === undefined) return WireDirection.UNSPECIFIED;
	return direction === "both" ? WireDirection.BOTH : WireDirection.IN;
}

function toAccount(a: WireAccount): BridgeAccount {
	return {
		id: assertSafeId(a.id),
		source: a.source,
		status: STATUSES[a.status] ?? "stopped",
		lastError: a.lastError,
		chats: a.chats.map((c) => ({
			conversationId: c.conversationId,
			chatId: assertSafeId(c.chatId),
			caughtUp: c.caughtUp,
			historyWindow: c.historyWindow,
			title: c.title,
			direction: c.direction === WireDirection.BOTH ? "both" : "in",
			topicsSplit: c.topicsSplit,
		})),
	};
}

function toStep(s: WireStep | undefined): LoginStep {
	if (s === undefined) throw new BridgeError("other");
	switch (s.kind) {
		case BridgeLoginStepKind.INPUT:
			return { kind: "input", loginId: s.loginId, fields: s.fields.map((f) => ({ name: f.name, label: f.label, secret: f.secret })), prompt: s.prompt };
		case BridgeLoginStepKind.QR:
			return { kind: "qr", loginId: s.loginId, prompt: s.prompt };
		case BridgeLoginStepKind.CONFIRM:
			return { kind: "confirm", loginId: s.loginId, prompt: s.prompt };
		case BridgeLoginStepKind.DONE:
			return { kind: "done", account: s.account === undefined ? null : toAccount(s.account) };
		default:
			throw new BridgeError("other");
	}
}

/** The kind of a failed call, and for a wrong answer the code the server gave ("wrong_code"…). */
export function bridgeError(err: unknown): BridgeError {
	if (err instanceof BridgeError) return err;
	const e = ConnectError.from(err);
	const message = e.rawMessage;
	let kind: BridgeErrorKind = "other";
	let detail = "";
	if (e.code === Code.FailedPrecondition && message.startsWith("bridge_disabled")) kind = "disabled";
	else if (e.code === Code.FailedPrecondition && message.startsWith("reauth_required")) kind = "reauth";
	else if (e.code === Code.FailedPrecondition && message.startsWith("send_unsupported")) kind = "send_unsupported";
	else if (e.code === Code.InvalidArgument && message.startsWith("wrong_input:")) {
		kind = "wrong_input";
		detail = message.slice("wrong_input:".length).trim().split(":")[0]?.trim() ?? "";
	} else if (e.code === Code.ResourceExhausted) kind = "rate_limited";
	else if (e.code === Code.AlreadyExists && message.startsWith("account_taken")) kind = "account_taken";
	else if (e.code === Code.NotFound) kind = "not_found";
	return new BridgeError(kind, detail);
}

const clients = new WeakMap<Transport, BridgeApi>();

/** The bridge calls on `transport`, one client per transport. */
export function bridgeClient(transport: Transport): BridgeApi {
	let client = clients.get(transport);
	if (client === undefined) {
		client = createBridgeClient(transport);
		clients.set(transport, client);
	}
	return client;
}

function createBridgeClient(transport: Transport): BridgeApi {
	const rpc = createClient(BridgeService, transport);
	const call = async <T>(fn: () => Promise<T>): Promise<T> => {
		try {
			return await fn();
		} catch (err) {
			throw bridgeError(err);
		}
	};
	return {
		status: () =>
			call(async () => {
				const r = await rpc.getBridgeStatus({});
				return { apps: r.apps.map((a) => a.source), accounts: r.accounts.map(toAccount) };
			}),
		startLogin: (source) => call(async () => toStep((await rpc.startBridgeLogin({ source })).step)),
		continueLogin: (loginId, input) => call(async () => toStep((await rpc.continueBridgeLogin({ loginId, input: { ...input } })).step)),
		conversations: (accountId) =>
			call(async () => {
				const r = await rpc.listBridgeConversations({ accountId: BigInt(accountId) });
				return r.conversations.map((c) => ({ id: c.id, kind: KINDS[c.kind] ?? "group", title: c.title, chatId: assertSafeId(c.chatId), forum: c.forum, topicsSplit: c.topicsSplit }));
			}),
		enable: (accountId, conversationId, historyWindow, direction) =>
			call(async () =>
				assertSafeId(
					(await rpc.enableBridgeChat({ accountId: BigInt(accountId), conversationId, historyWindow, direction: toWireDirection(direction) })).chatId,
				),
			),
		setDirection: (accountId, conversationId, direction) =>
			call(async () => {
				await rpc.setBridgeChatDirection({ accountId: BigInt(accountId), conversationId, direction: toWireDirection(direction) });
			}),
		outbox: (chatId) =>
			call(async () => {
				const r = await rpc.listBridgeOutbox({ chatId: BigInt(chatId) });
				return r.items.flatMap((item): BridgeOutboxItem[] => {
					const status = OUTBOX_STATUSES[item.status];
					const op = OPS.find((candidate) => candidate === item.op);
					return status === undefined || op === undefined
						? []
						: [{ seq: assertSafeId(item.seq), op, status, lastError: item.lastError, attempts: item.attempts }];
				});
			}),
		retry: (chatId, seq) =>
			call(async () => {
				await rpc.retryBridgeMessage({ chatId: BigInt(chatId), seq: BigInt(seq) });
			}),
		dismiss: (chatId, seq) =>
			call(async () => {
				await rpc.dismissBridgeMessage({ chatId: BigInt(chatId), seq: BigInt(seq) });
			}),
		remove: (accountId, conversationId) =>
			call(async () => {
				await rpc.removeBridgeChat({ accountId: BigInt(accountId), conversationId });
			}),
		disconnect: (accountId, deleteChats) =>
			call(async () => {
				await rpc.disconnectBridgeAccount({ accountId: BigInt(accountId), deleteChats });
			}),
	};
}
