// The user's rights over their chat data (PrivacyService): personal data
// export (an account is deleted only at the IdP, ADR 0016). Types and
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

export interface AccountData {
	readonly exports: ExportState;
}

export type PrivacyErrorKind = "rate_limited" | "unavailable" | "other";

export interface AccountApi {
	account(): Promise<AccountData>;
	exportState(): Promise<ExportState>;
	requestExport(): Promise<ExportState>;
	/** A short-lived download URL of a ready export. */
	exportUrl(exportId: number): Promise<string>;
}

/** The Connect client of the "Tài khoản" tab, fetched with the tab's code. */
export const loadPrivacyClient = () => import("./privacy-client.ts");
