// The signed-in user as of the last successful start, so the app can open
// without the server (offline, or the server unreachable): the service
// worker serves the app shell, the chats come from the local database, and
// the client core starts from the user id it stored itself.
//
// It is only used while the client core still holds the same user's data
// (its "last user" key, cleared on sign-out and when the session ends), and
// removed on sign-out and whenever the server says the session is gone.
import type { SelfUser } from "./adapters.ts";

const KEY = "app:last-self";
/** The client core's key (LAST_USER_KEY of @app/platform-web), read here without loading that package at startup. */
export const CORE_LAST_USER_KEY = "chat:last-user";

function storage(): Storage | null {
	try {
		return window.localStorage;
	} catch {
		// Storage disabled (privacy settings): nothing to remember.
		return null;
	}
}

export function rememberSelf(self: SelfUser): void {
	try {
		storage()?.setItem(KEY, JSON.stringify(self));
	} catch {
		// Quota or privacy mode: the app just cannot open offline.
	}
}

export function forgetSelf(): void {
	storage()?.removeItem(KEY);
}

function isSelfUser(value: unknown): value is SelfUser {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "number" &&
		Number.isSafeInteger(v.id) &&
		v.id > 0 &&
		typeof v.username === "string" &&
		typeof v.name === "string" &&
		typeof v.bio === "string" &&
		typeof v.email === "string" &&
		typeof v.isOperator === "boolean"
	);
}

/** The remembered user when the local data still belongs to them; null otherwise (and the stale entry is dropped). */
export function lastSelf(): SelfUser | null {
	const store = storage();
	const raw = store?.getItem(KEY) ?? null;
	if (store === null || raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		parsed = null;
	}
	if (!isSelfUser(parsed) || store.getItem(CORE_LAST_USER_KEY) !== String(parsed.id)) {
		store.removeItem(KEY);
		return null;
	}
	return parsed;
}
