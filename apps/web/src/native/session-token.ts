// The native app's chat session token (ADR 0006): kept in the Keychain
// (iOS, this device only) or the Keystore (Android) through
// @aparajita/capacitor-secure-storage, never in the WebView's storage, and
// held in memory for the requests of this run. One entry per server, so a
// build pointed at another tenant never reads this one's token.
import { KeychainAccess, SecureStorage } from "@aparajita/capacitor-secure-storage";
import { NATIVE_API_ORIGIN } from "../server-origin.ts";

const KEY = `chat-session:${new URL(NATIVE_API_ORIGIN || "https://invalid").host}`;

let current = "";

/** The token of this run; "" when signed out. */
export function sessionToken(): string {
	return current;
}

/** Reads the stored token once at start; a store that fails reads as signed out. */
export async function loadSessionToken(): Promise<string> {
	try {
		const stored = await SecureStorage.get(KEY, false, false);
		current = typeof stored === "string" ? stored : "";
	} catch (err) {
		console.warn("secure storage:", err);
		current = "";
	}
	return current;
}

/** Stores the token of a new session (ExchangeNativeCode). */
export async function saveSessionToken(token: string): Promise<void> {
	await SecureStorage.set(KEY, token, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
	current = token;
}

/** Forgets the token (sign-out, revoked or expired session). */
export async function clearSessionToken(): Promise<void> {
	current = "";
	try {
		await SecureStorage.remove(KEY, false);
	} catch (err) {
		console.warn("secure storage:", err);
	}
}
