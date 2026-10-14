// Web sign-in (ADR 0006): the server runs Code + PKCE behind HTTP routes and
// keeps the chat session in an HttpOnly cookie, so the client never holds a
// token. It only navigates to these routes; the platform layer performs the
// navigation on the main thread.
import type { SessionRevokeReason } from "../model/types.ts";

/** Why the local session ended; every reason wipes local data. */
export type SessionEndReason = SessionRevokeReason | "unauthenticated" | "user_changed" | "local_sign_out";

/** POST target of the sign-out form (302 to the IdP end-session endpoint). */
export const SIGN_OUT_PATH = "/auth/logout";

const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

const RETURN_TO_MAX = 512;

/**
 * Whether `path` may be sent as return_to: a path on this origin (one
 * leading "/", no backslash, whitespace or control character, not under
 * /auth/). The server checks the same rules and ignores anything else.
 */
export function isReturnPath(path: string): boolean {
	if (path === "" || path.length > RETURN_TO_MAX || !path.startsWith("/") || path.startsWith("//")) return false;
	if (/[\\\s\u0000-\u001f\u007f]/u.test(path)) return false;
	const lower = path.toLowerCase();
	return !(lower === "/auth" || lower.startsWith("/auth/") || lower.startsWith("/auth?") || lower.startsWith("/auth#"));
}

/**
 * URL that starts sign-in at the tenant's IdP. `create` opens the IdP's
 * sign-up page (prompt=create); `locale` becomes ui_locales on the server;
 * `returnTo` (a path, see isReturnPath) is where the browser lands after
 * sign-in instead of "/".
 */
export function signInUrl(locale: string, options: { create?: boolean; returnTo?: string } = {}): string {
	const params = new URLSearchParams();
	if (options.create === true) params.set("prompt", "create");
	if (LOCALE.test(locale)) params.set("locale", locale.toLowerCase());
	if (options.returnTo !== undefined && options.returnTo !== "/" && isReturnPath(options.returnTo)) {
		params.set("return_to", options.returnTo);
	}
	return `/auth/login?${params.toString()}`;
}

/** Local database name for (tenant, user): accounts never share a file (ADR 0009). */
export function databaseName(tenant: string, userId: number): string {
	const safeTenant = tenant.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
	if (!Number.isSafeInteger(userId) || userId <= 0) throw new RangeError(`invalid user id ${userId}`);
	return `chat-${safeTenant}-${userId}.sqlite3`;
}
