// Connect implementation of BridgeApi (see bridge-api.ts), loaded with the
// "Kết nối ứng dụng" settings tab.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@achoo254/chat-core";
import {
	BridgeAccountStatus as WireStatus,
	BridgeDirection as WireDirection,
	BridgeLoginStepKind,
	BridgeOutboxStatus as WireOutboxStatus,
	BridgeService,
	BridgeSyncState as WireSyncState,
	type BridgeAccount as WireAccount,
	type BridgeLoginStep as WireStep,
} from "@achoo254/chat-proto/bridge";
import {
	BridgeError,
	type BridgeAccount,
	type BridgeAccountStatus,
	type BridgeApi,
	type BridgeErrorKind,
	type BridgeOutboxItem,
	type LoginStep,
	STATE_OPS,
} from "./bridge-api.ts";
import type { BridgeFeatureView, FeatureDirection, FeatureRisk } from "./bridge-features-model.ts";

const STATUSES: Partial<Record<WireStatus, BridgeAccountStatus>> = {
	[WireStatus.ACTIVE]: "active",
	[WireStatus.NEEDS_LOGIN]: "needs_login",
	[WireStatus.STOPPED]: "stopped",
};


const OUTBOX_STATUSES: Partial<Record<WireOutboxStatus, BridgeOutboxItem["status"]>> = {
	[WireOutboxStatus.PENDING]: "pending",
	[WireOutboxStatus.SENDING]: "sending",
	[WireOutboxStatus.FAILED]: "failed",
	[WireOutboxStatus.UNKNOWN]: "unknown",
};

const DIRECTIONS: readonly FeatureDirection[] = ["off", "in", "out", "both"];
const RISKS: readonly FeatureRisk[] = ["r1", "r2", "r3", "re"];

const OPS: readonly BridgeOutboxItem["op"][] = ["send", "edit", "delete", ...STATE_OPS];


function toAccount(a: WireAccount): BridgeAccount {
	return {
		id: assertSafeId(a.id),
		source: a.source,
		status: STATUSES[a.status] ?? "stopped",
		lastError: a.lastError,
		sendGated: a.sendGated,
		sendEnabled: a.sendGated && a.sendEnabled,
		syncState: a.syncState === WireSyncState.LIVE ? "live" : a.syncState === WireSyncState.SYNCING ? "syncing" : "off",
		progress: {
			conversations: a.progress?.conversations ?? 0,
			conversationsDone: a.progress?.conversationsDone ?? 0,
			messages: Number(a.progress?.messages ?? 0n),
			messagesExpected: Number(a.progress?.messagesExpected ?? 0n),
		},
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
	else if (e.code === Code.FailedPrecondition && message.startsWith("feature_unsupported")) kind = "feature_unsupported";
	else if (e.code === Code.FailedPrecondition && message.startsWith("feature_off")) kind = "feature_off";
	else if (e.code === Code.InvalidArgument && message.startsWith("confirmation_wrong")) kind = "confirmation_wrong";
	else if (e.code === Code.InvalidArgument && message.startsWith("wrong_input:")) {
		kind = "wrong_input";
		detail = message.slice("wrong_input:".length).trim().split(":")[0]?.trim() ?? "";
	} else if (e.code === Code.ResourceExhausted) {
		kind = "rate_limited";
		// A login limit says how long to wait: "...; retry_after=<seconds>".
		detail = /retry_after=(\d+)/.exec(message)?.[1] ?? "";
	} else if (e.code === Code.AlreadyExists && message.startsWith("account_taken")) kind = "account_taken";
	else if (e.code === Code.NotFound) kind = "not_found";
	else if (e.code === Code.Canceled) kind = "canceled";
	else if (unreachable(e)) kind = "network";
	return new BridgeError(kind, detail);
}

/**
 * The server was not reached or did not answer: a gateway error, a call past
 * its deadline, or a fetch that failed (Connect wraps fetch's TypeError as
 * Unknown, which a plain server error also is, so the cause tells them apart).
 */
function unreachable(e: ConnectError): boolean {
	return e.code === Code.Unavailable || e.code === Code.DeadlineExceeded || (e.code === Code.Unknown && e.cause instanceof TypeError);
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
		startLogin: (source, options) => call(async () => toStep((await rpc.startBridgeLogin({ source }, { ...options })).step)),
		continueLogin: (loginId, input, options) =>
			call(async () => toStep((await rpc.continueBridgeLogin({ loginId, input: { ...input } }, { ...options })).step)),
		problems: (accountId) =>
			call(async () => {
				const r = await rpc.listBridgeProblems({ accountId: BigInt(accountId) });
				return r.problems.map((p) => ({
					id: Number(p.id),
					chatId: Number(p.chatId),
					chatTitle: p.chatTitle,
					feature: p.feature,
					op: p.op,
					status: p.status === "unknown" ? ("unknown" as const) : ("failed" as const),
					lastError: p.lastError,
					attempts: p.attempts,
					at: Number(p.atUnix),
				}));
			}),
		retryProblem: (accountId, id) =>
			call(async () => {
				await rpc.retryBridgeProblem({ accountId: BigInt(accountId), id: BigInt(id) });
			}),
		dismissProblem: (accountId, id) =>
			call(async () => {
				await rpc.dismissBridgeProblem({ accountId: BigInt(accountId), id: BigInt(id) });
			}),
		invites: (accountId, conversationId) =>
			call(async () => {
				const r = await rpc.listBridgeInvites({ accountId: BigInt(accountId), conversationId });
				return r.invites.map((i) => ({ link: i.link, title: i.title, revoked: i.revoked, usage: i.usage }));
			}),
		createInvite: (accountId, conversationId, title) =>
			call(async () => {
				await rpc.createBridgeInvite({ accountId: BigInt(accountId), conversationId, title });
			}),
		revokeInvite: (accountId, conversationId, link) =>
			call(async () => {
				await rpc.revokeBridgeInvite({ accountId: BigInt(accountId), conversationId, link });
			}),
		candidates: (accountId, conversationId) =>
			call(async () => {
				const r = await rpc.listBridgeCandidates({ accountId: BigInt(accountId), conversationId });
				return r.candidates.map((c) => ({ participantId: c.participantId, name: c.name }));
			}),
		addMember: (accountId, conversationId, participantId) =>
			call(async () => {
				await rpc.addBridgeMember({ accountId: BigInt(accountId), conversationId, participantId });
			}),
		leaveGroup: (accountId, conversationId, confirmName) =>
			call(async () => {
				await rpc.leaveBridgeGroup({ accountId: BigInt(accountId), conversationId, confirmName });
			}),
		requestGroupDelete: (accountId, conversationId, confirmName) =>
			call(async () => {
				const r = await rpc.requestBridgeGroupDelete({ accountId: BigInt(accountId), conversationId, confirmName });
				return { token: r.token, usableFrom: Number(r.usableFromUnix), expires: Number(r.expiresUnix) };
			}),
		deleteGroup: (accountId, conversationId, confirmName, token) =>
			call(async () => {
				await rpc.deleteBridgeGroup({ accountId: BigInt(accountId), conversationId, confirmName, token });
			}),
		features: (accountId, conversationId) =>
			call(async () => {
				const r = await rpc.listBridgeFeatures({ accountId: BigInt(accountId), conversationId });
				return r.features.flatMap((f): BridgeFeatureView[] => {
					const direction = DIRECTIONS.find((d) => d === f.direction);
					const risk = RISKS.find((x) => x === f.risk);
					return direction === undefined || risk === undefined
						? []
						: [{ feature: f.feature, risk, direction, isDefault: f.isDefault, canReceive: f.canReceive, canSend: f.canSend }];
				});
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
		startSync: (accountId) =>
			call(async () => {
				await rpc.startBridgeSync({ accountId: BigInt(accountId) });
			}),
		setSendEnabled: (accountId, enabled) =>
			call(async () => {
				await rpc.setBridgeSendEnabled({ accountId: BigInt(accountId), enabled });
			}),
		disconnect: (accountId, deleteChats) =>
			call(async () => {
				await rpc.disconnectBridgeAccount({ accountId: BigInt(accountId), deleteChats });
			}),
	};
}
