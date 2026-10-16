// Connect implementation of AccountApi (see privacy-api.ts), loaded with the "Tài khoản" tab.
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { assertSafeId } from "@app/core";
import {
	DataExportStatus,
	PrivacyService,
	type DataExport as WireExport,
	type GetDataExportResponse,
	type GetAccountDeletionResponse,
} from "@app/proto-ts/privacy";
import type { AccountData, AutoDeleteMonths, DataExport, DeletionInfo, ExportState, ExportStatus, AccountApi, PrivacyErrorKind } from "./privacy-api.ts";

const STATUSES: Partial<Record<DataExportStatus, ExportStatus>> = {
	[DataExportStatus.PENDING]: "pending",
	[DataExportStatus.RUNNING]: "running",
	[DataExportStatus.READY]: "ready",
	[DataExportStatus.FAILED]: "failed",
	[DataExportStatus.EXPIRED]: "expired",
};

function toExport(e: WireExport): DataExport {
	return {
		id: assertSafeId(e.id),
		status: STATUSES[e.status] ?? "failed",
		progress: Math.min(100, Math.max(0, e.progress)),
		size: assertSafeId(e.size),
		fileName: e.fileName,
		createdAt: assertSafeId(e.createdAt),
		readyAt: assertSafeId(e.readyAt),
		expiresAt: assertSafeId(e.expiresAt),
	};
}

function toExportState(r: Pick<GetDataExportResponse, "export" | "nextRequestAt">, available: boolean): ExportState {
	return { latest: r.export === undefined ? null : toExport(r.export), nextRequestAt: assertSafeId(r.nextRequestAt), available };
}

function toMonths(months: number): AutoDeleteMonths {
	return months === 6 || months === 12 || months === 24 ? months : 0;
}

function toDeletion(r: GetAccountDeletionResponse): DeletionInfo {
	return {
		ownedChats: r.ownedChats.map((c) => ({ chatId: assertSafeId(c.chatId), title: c.title, isChannel: c.isChannel, memberCount: c.memberCount })),
		bots: r.bots.map((b) => ({ botId: assertSafeId(b.botId), name: b.name, username: b.username })),
		autoDeleteMonths: toMonths(r.autoDeleteMonths),
		signedInAt: assertSafeId(r.signedInAt),
		graceDays: r.graceDays,
	};
}

const clients = new WeakMap<Transport, AccountApi>();

/** The account calls on `transport`, one client per transport (the tab and its preloaded data share it). */
export function privacyClient(transport: Transport): AccountApi {
	let client = clients.get(transport);
	if (client === undefined) {
		client = createPrivacyClient(transport);
		clients.set(transport, client);
	}
	return client;
}

function createPrivacyClient(transport: Transport): AccountApi {
	const privacy = createClient(PrivacyService, transport);
	const exportState = async (): Promise<ExportState> => {
		const r = await privacy.getDataExport({});
		return toExportState(r, r.available);
	};
	return {
		// A session that ended is noticed by the realtime connection, which signs this device out.
		account: async (): Promise<AccountData> => {
			const [exports, deletion] = await Promise.all([exportState(), privacy.getAccountDeletion({})]);
			return { exports, deletion: toDeletion(deletion) };
		},
		exportState,
		requestExport: async () => toExportState(await privacy.requestDataExport({}), true),
		exportUrl: async (exportId) => (await privacy.getDataExportUrl({ exportId: BigInt(exportId) })).url,
		setAutoDelete: async (months) => toMonths((await privacy.setAutoDelete({ months })).months),
		deleteAccount: async (confirmation) => assertSafeId((await privacy.deleteAccount({ confirmation })).purgeAt),
	};
}

/** The server's error codes ("reauth_required: …") ride at the start of the message. */
export function privacyErrorKind(err: unknown): PrivacyErrorKind {
	if (!(err instanceof ConnectError)) return "other";
	const message = err.rawMessage;
	switch (err.code) {
		case Code.FailedPrecondition:
			if (message.startsWith("reauth_required")) return "reauth_required";
			if (message.startsWith("owns_chats")) return "owns_chats";
			if (message.startsWith("export_unavailable")) return "unavailable";
			return "other";
		case Code.ResourceExhausted:
			return "rate_limited";
		case Code.InvalidArgument:
			return "invalid";
		default:
			return "other";
	}
}
