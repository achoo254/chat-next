/**
 * The account session of this machine, kept in `~/.tunelo/config.json`
 * beside the rest of the CLI config and refreshed by `@tunelo/client`.
 */
import { join } from "node:path";
import {
	type SessionDeps,
	SessionExpiredError,
	type SessionStore,
	type StoredSession,
	getAccessToken as getSessionToken,
} from "@tunelo/client";
import { getConfigDir, loadConfig, updateConfig } from "./config.js";

export { SessionExpiredError, sessionFromTokens } from "@tunelo/client";

const EXPIRED_MESSAGE = "Your sign-in has expired. Run `tunelo login` again.";

export function saveSession(session: StoredSession): void {
	updateConfig((config) => ({ ...config, session }));
}

export function clearSession(): void {
	updateConfig((config) => ({ ...config, session: undefined }));
}

/** The session slot of the CLI config, locked by `~/.tunelo/session.lock`. */
function configSessionStore(): SessionStore {
	return {
		lockPath: join(getConfigDir(), "session.lock"),
		load: () => loadConfig().session,
		save: saveSession,
		clear: clearSession,
	};
}

/**
 * Current access token, refreshed if it is about to expire. The refresh runs
 * under a file lock and re-reads the config inside it, so concurrent
 * `tunelo` processes rotate the single-use refresh token exactly once.
 */
export async function getAccessToken(deps: SessionDeps = {}): Promise<string> {
	try {
		return await getSessionToken(configSessionStore(), deps);
	} catch (err) {
		if (err instanceof SessionExpiredError) {
			throw new SessionExpiredError(EXPIRED_MESSAGE);
		}
		throw err;
	}
}
