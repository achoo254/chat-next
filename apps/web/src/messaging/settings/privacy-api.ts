// The user's rights over their chat data (PrivacyService): personal data
// export, auto-delete when unused, deletion of the chat account. Types and
// the loader only: the Connect client (privacy-client.ts) loads with the
// "Tài khoản" settings tab, so none of it ships with the messaging chunk.
export type ExportStatus = "pending" | "running" | "ready" | "failed" | "expired";

export interface DataExport {
	readonly id: number;
	readonly status: ExportStatus;
	/** 0 to 100 while running. */
	readonly progress: number;
	/** Bytes of the ZIP once ready. */
	readonly size: number;
	readonly fileName: string;
	/** Unix seconds; readyAt and expiresAt are 0 until ready. */
	readonly createdAt: number;
	readonly readyAt: number;
	readonly expiresAt: number;
}

export interface ExportState {
	/** The newest export; null before the first request. */
	readonly latest: DataExport | null;
	/** Unix seconds from which a new export may be requested; 0 when now. */
	readonly nextRequestAt: number;
	/** False when the server keeps no exports. */
	readonly available: boolean;
}

export interface OwnedChat {
	readonly chatId: number;
	readonly title: string;
	readonly isChannel: boolean;
	readonly memberCount: number;
}

export interface OwnedBot {
	readonly botId: number;
	readonly name: string;
	readonly username: string;
}

/** Months of the auto-delete setting; 0 is off. */
export type AutoDeleteMonths = 0 | 6 | 12 | 24;

export interface DeletionInfo {
	/** Groups and channels the user owns: deleting the account waits for them. */
	readonly ownedChats: readonly OwnedChat[];
	/** Bots stopped during the grace period and deleted with the account. */
	readonly bots: readonly OwnedBot[];
	readonly autoDeleteMonths: AutoDeleteMonths;
	/** Unix seconds of this session's IdP sign-in; 0 when unknown. */
	readonly signedInAt: number;
	readonly graceDays: number;
}

export interface AccountData {
	readonly exports: ExportState;
	readonly deletion: DeletionInfo;
}

/** How long an IdP sign-in confirms a deletion (ADR 0006). */
export const RECENT_SIGN_IN_SECONDS = 600;

export type PrivacyErrorKind = "reauth_required" | "owns_chats" | "rate_limited" | "invalid" | "unavailable" | "other";

export interface AccountApi {
	account(): Promise<AccountData>;
	exportState(): Promise<ExportState>;
	requestExport(): Promise<ExportState>;
	/** A short-lived download URL of a ready export. */
	exportUrl(exportId: number): Promise<string>;
	setAutoDelete(months: AutoDeleteMonths): Promise<AutoDeleteMonths>;
	/** Starts the grace period; resolves to when the account is erased (unix seconds). */
	deleteAccount(confirmation: string): Promise<number>;
}

/** The Connect client of the "Tài khoản" tab, fetched with the tab's code. */
export const loadPrivacyClient = () => import("./privacy-client.ts");
