// What a QR login (Zalo, ADR 0022 step model) shows at each moment, worked out
// from the server's steps and errors. Pure: the polling lives in
// use-qr-login.ts and the view in bridge-qr-login.tsx.
import type { BridgeError, LoginStep } from "./bridge-api.ts";

/** Apps whose login is a QR code scanned on the phone, shown after a notice the user accepts. */
export const QR_LOGIN_APPS: ReadonlySet<string> = new Set(["zalo"]);

/**
 * Apps Chat only reads from: nothing typed in Chat goes back to them, so the
 * page must not promise two-way sync. Remove an app here when its send path
 * ships (the server reports `send_unsupported` for an app that cannot send).
 */
export const RECEIVE_ONLY_APPS: ReadonlySet<string> = new Set(["zalo"]);

/** The longest wait a countdown shows, in seconds: a hint from the server is capped to it. */
const MAX_LIMIT_WAIT_S = 3600;

/**
 * Seconds a refused login start waits before it may be tried again: the
 * server's hint (`retry_after`, carried in the error's detail), else the
 * adapter's own cool-down.
 */
export function limitWaitSeconds(error: BridgeError): number {
	const hint = Number.parseInt(error.detail, 10);
	if (Number.isFinite(hint) && hint > 0) return Math.min(hint, MAX_LIMIT_WAIT_S);
	return Math.ceil(LOGIN_RETRY_GAP_MS / 1000);
}

/** The QR image the page agrees to show: a base64 PNG data: URL, nothing else. */
const QR_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** Upper bound of the QR data: URL's length (the server sends a PNG of at most 256 KiB, about 342 KB as base64). */
export const MAX_QR_URL_LENGTH = 400_000;

/** How long the server makes a user wait after a failed or abandoned login (zalo login_limits.go). */
export const LOGIN_RETRY_GAP_MS = 20_000;

/** True when `url` is a PNG data: URL of a size the page will render. */
export function isSafeQrDataUrl(url: string): boolean {
	return url.length < MAX_QR_URL_LENGTH && QR_DATA_URL.test(url);
}

/**
 * Where a QR login is. `preparing`: the first code is being made. `scan`: a
 * code is on screen. `refreshing`: the code expired and a new one is coming.
 * `confirm`: scanned, waiting for the phone. `network`: a call did not reach
 * the server (retry polls the same login). The rest end the login.
 */
export type QrLoginStatus =
	| "preparing"
	| "scan"
	| "refreshing"
	| "confirm"
	| "network"
	| "declined"
	| "expired"
	| "limited"
	| "taken"
	| "failed";

/** Statuses after which the login is over on the server: the user starts again. */
const ENDED: ReadonlySet<QrLoginStatus> = new Set(["declined", "expired", "limited", "taken", "failed"]);

export function isEnded(status: QrLoginStatus): boolean {
	return ENDED.has(status);
}

/** What a running (not done) step means: the status to show and the image, if any. */
export interface QrView {
	readonly status: QrLoginStatus;
	/** The QR image to show; "" when none. */
	readonly image: string;
}

/**
 * The view for `step`, given whether a code was already shown (an empty
 * prompt after one means it expired and a new one is loading). A prompt that
 * is not a safe PNG data: URL is refused: nothing is rendered and the login
 * counts as failed.
 */
export function viewOfStep(step: Exclude<LoginStep, { kind: "done" }>, shownBefore: boolean): QrView {
	if (step.kind === "confirm") return { status: "confirm", image: "" };
	if (step.kind !== "qr") return { status: "failed", image: "" };
	if (step.prompt === "") return { status: shownBefore ? "refreshing" : "preparing", image: "" };
	if (!isSafeQrDataUrl(step.prompt)) return { status: "failed", image: "" };
	return { status: "scan", image: step.prompt };
}

/** The status a failed login call leads to. */
export function statusOfError(error: BridgeError): QrLoginStatus {
	switch (error.kind) {
		case "network":
			return "network";
		case "rate_limited":
			return "limited";
		case "account_taken":
			return "taken";
		case "not_found":
			return "expired";
		case "wrong_input":
			if (error.detail === "qr_declined") return "declined";
			if (error.detail === "qr_expired" || error.detail === "login_expired") return "expired";
			return "failed";
		default:
			return "failed";
	}
}
