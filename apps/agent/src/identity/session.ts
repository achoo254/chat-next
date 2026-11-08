/**
 * The machine's one account session at the shared IdP: one rotating refresh
 * token for every resource (tunnel now; Chat and Localman later), kept in
 * `<config dir>/session.json` sealed with the OS key store (keystore.ts), and
 * short-lived access tokens per resource, sealed beside it.
 *
 * Every refresh runs under one lock file (`session.lock`) and re-reads the
 * file inside it: replaying a rotated refresh token revokes the whole grant,
 * so two refreshes must never use the same one. The background service does
 * the refreshing; a command refreshes only when the service is not running
 * (it routes everything else through the control socket). Nothing here hands
 * a refresh token to a caller.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	IDP_DEFAULTS,
	type IdpEndpoints,
	OAuthResponseError,
	SessionExpiredError,
	type TokenSet,
	discover,
	refreshTokens,
	revokeToken,
	subjectOf,
	withFileLock,
	writePrivateFile,
} from "@tunelo/client";
import { KeyStoreUnavailableError, seal, unseal } from "../keystore.ts";

export { SessionExpiredError } from "@tunelo/client";

export const SESSION_FILE = "session.json";
const LOCK_FILE = "session.lock";
/** Refresh this long before `exp` so a token never expires mid-handshake. */
const EXPIRY_MARGIN_MS = 60_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const EXPIRED_MESSAGE = "Your sign-in has expired. Run `tunelo login` again.";
/** `tunelo login` signs in again by itself when the stored session does not open. */
const UNREADABLE_MESSAGE =
	"The sign-in on this machine cannot be opened with this user's key store. Run `tunelo login` to sign in again.";
/** The grant died after another process saved a session: that one may look fine, so ask for a fresh one. */
const REPLACED_MESSAGE = "Your sign-in has expired. Run `tunelo login --force`.";

/** What callers may know about the session: never a token. */
export interface SessionInfo {
	issuer: string;
	/** Account id (`sub`). */
	sub: string;
	/** OAuth client the grant belongs to. */
	clientId: string;
}

interface SealedToken {
	token: string;
	/** Epoch ms. */
	expiresAt: number;
}

interface SessionFile extends SessionInfo {
	version: 1;
	/** New on every sign-in; tells processes their cached tokens are stale. */
	generation: string;
	refreshToken: string;
	access: Record<string, SealedToken>;
}

/** A session of an older tunelo or of the Tunelo CLI 1.x, stored in plain text. */
export interface PlainSession {
	issuer: string;
	sub: string;
	refreshToken: string;
	accessToken?: string | undefined;
	accessTokenExpiresAt?: number | undefined;
}

export interface SessionDeps {
	discover?: (issuer: string) => Promise<IdpEndpoints>;
	refresh?: (
		endpoints: IdpEndpoints,
		refreshToken: string,
		resource: string,
		clientId: string,
	) => Promise<TokenSet>;
	revoke?: (
		endpoints: IdpEndpoints,
		refreshToken: string,
		clientId: string,
	) => Promise<void>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseAccess(value: unknown): Record<string, SealedToken> {
	const access: Record<string, SealedToken> = {};
	if (!isRecord(value)) return access;
	for (const [resource, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		const token = text(entry.token);
		if (token && typeof entry.expiresAt === "number") {
			access[resource] = { token, expiresAt: entry.expiresAt };
		}
	}
	return access;
}

/** The session file, or undefined when missing, unreadable or incomplete. */
function readSession(dir: string): SessionFile | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(dir, SESSION_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (!isRecord(raw) || raw.version !== 1) return undefined;
	const issuer = text(raw.issuer);
	const sub = text(raw.sub);
	const clientId = text(raw.clientId);
	const generation = text(raw.generation);
	const refreshToken = text(raw.refreshToken);
	if (!issuer || !sub || !clientId || !generation || !refreshToken) {
		return undefined;
	}
	return {
		version: 1,
		issuer,
		sub,
		clientId,
		generation,
		refreshToken,
		access: parseAccess(raw.access),
	};
}

function writeSession(dir: string, session: SessionFile): void {
	writePrivateFile(
		join(dir, SESSION_FILE),
		`${JSON.stringify(session, null, 2)}\n`,
	);
}

/** Answers meaning the grant is gone; anything else is worth another try. */
const DEAD_GRANT_ERRORS = new Set([
	"invalid_grant",
	"invalid_client",
	"unauthorized_client",
]);

function isDeadGrant(err: unknown): boolean {
	return err instanceof OAuthResponseError && DEAD_GRANT_ERRORS.has(err.error);
}

type Attempt = { token: string } | { retry: unknown };

export class IdentitySession {
	/** Access tokens this process opened, by `<generation> <resource>`. */
	private readonly cache = new Map<string, SealedToken>();
	private readonly deps: Required<SessionDeps>;

	constructor(
		readonly dir: string,
		deps: SessionDeps = {},
	) {
		this.deps = {
			discover: deps.discover ?? discover,
			refresh: deps.refresh ?? refreshTokens,
			revoke: deps.revoke ?? revokeToken,
			sleep:
				deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
			now: deps.now ?? Date.now,
		};
	}

	private get lockPath(): string {
		return join(this.dir, LOCK_FILE);
	}

	/** Who is signed in, or undefined. Reads no secret. */
	info(): SessionInfo | undefined {
		const session = readSession(this.dir);
		if (!session) return undefined;
		const { issuer, sub, clientId } = session;
		return { issuer, sub, clientId };
	}

	/**
	 * An access token for `resource` (its `aud`), refreshed when about to
	 * expire. Throws `SessionExpiredError` when there is no session or the
	 * grant is gone.
	 */
	async getAccessToken(resource: string): Promise<string> {
		const session = readSession(this.dir);
		if (!session) throw new SessionExpiredError(EXPIRED_MESSAGE);
		const ready = await this.validToken(session, resource);
		if (ready) return ready;
		// Back off outside the lock, so other processes are not kept waiting.
		for (let attempt = 0; ; attempt++) {
			const outcome = await withFileLock(this.lockPath, () =>
				this.refreshLocked(resource),
			);
			if ("token" in outcome) return outcome.token;
			const delay = RETRY_DELAYS_MS[attempt];
			if (delay === undefined) throw outcome.retry;
			await this.deps.sleep(delay);
		}
	}

	/** A cached or stored access token that is still good, if any. */
	private async validToken(
		session: SessionFile,
		resource: string,
	): Promise<string | null> {
		const now = this.deps.now();
		const key = `${session.generation} ${resource}`;
		const cached = this.cache.get(key);
		if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now) return cached.token;
		const stored = session.access[resource];
		if (!stored || stored.expiresAt - EXPIRY_MARGIN_MS <= now) return null;
		try {
			const token = await unseal(this.dir, stored.token);
			this.cache.set(key, { token, expiresAt: stored.expiresAt });
			return token;
		} catch {
			// Unreadable: the refresh below replaces it (or says why it cannot).
			return null;
		}
	}

	/**
	 * The refresh token in clear. A key store that cannot be read right now
	 * (Keychain locked) is a passing error, kept as is; a token that does not
	 * open with this user's key means signing in again.
	 */
	private async openRefreshToken(session: SessionFile): Promise<string> {
		try {
			return await unseal(this.dir, session.refreshToken);
		} catch (err) {
			if (err instanceof KeyStoreUnavailableError) throw err;
			throw new SessionExpiredError(UNREADABLE_MESSAGE);
		}
	}

	/**
	 * True when a session is stored and its refresh token opens. Rejects
	 * when the key store cannot be read now, which says nothing either way.
	 */
	async isUsable(): Promise<boolean> {
		const session = readSession(this.dir);
		if (!session) return false;
		try {
			await this.openRefreshToken(session);
			return true;
		} catch (err) {
			if (err instanceof SessionExpiredError) return false;
			throw err;
		}
	}

	/**
	 * Holds the lock. Re-reads the file: another process may have refreshed
	 * while this one waited. On `invalid_grant` the file is read once more and
	 * a refresh token another writer saved meanwhile is tried once; otherwise
	 * the grant is gone and the session is removed.
	 */
	private async refreshLocked(resource: string): Promise<Attempt> {
		let session = readSession(this.dir);
		if (!session) throw new SessionExpiredError(EXPIRED_MESSAGE);
		const ready = await this.validToken(session, resource);
		if (ready) return { token: ready };
		for (let retried = false; ; retried = true) {
			try {
				// Open the token first: no network call for a session that cannot be used.
				const refreshToken = await this.openRefreshToken(session);
				const endpoints = await this.deps.discover(session.issuer);
				const tokens = await this.deps.refresh(
					endpoints,
					refreshToken,
					resource,
					session.clientId,
				);
				return { token: await this.store(session, tokens, resource) };
			} catch (err) {
				if (!isDeadGrant(err)) {
					if (err instanceof SessionExpiredError) throw err;
					return { retry: err };
				}
				const again = readSession(this.dir);
				const changed =
					again !== undefined && again.refreshToken !== session.refreshToken;
				if (changed && !retried) {
					session = again;
					continue;
				}
				if (!changed) rmSync(join(this.dir, SESSION_FILE), { force: true });
				throw new SessionExpiredError(changed ? REPLACED_MESSAGE : EXPIRED_MESSAGE);
			}
		}
	}

	/** Saves a refresh answer (rotated refresh token first) and returns its access token. */
	private async store(
		session: SessionFile,
		tokens: TokenSet,
		resource: string,
	): Promise<string> {
		const now = this.deps.now();
		const access: Record<string, SealedToken> = {};
		for (const [name, entry] of Object.entries(session.access)) {
			if (name !== resource && entry.expiresAt > now) access[name] = entry;
		}
		const expiresAt = now + tokens.expiresIn * 1000;
		access[resource] = {
			token: await seal(this.dir, tokens.accessToken),
			expiresAt,
		};
		writeSession(this.dir, {
			...session,
			refreshToken: tokens.refreshToken
				? await seal(this.dir, tokens.refreshToken)
				: session.refreshToken,
			access,
		});
		this.cache.set(`${session.generation} ${resource}`, {
			token: tokens.accessToken,
			expiresAt,
		});
		return tokens.accessToken;
	}

	/**
	 * Saves the tokens of a new device sign-in in place of the current
	 * session, then revokes the grant that session held. Resolves with the
	 * new session, and the revocation error if that failed.
	 */
	async replace(
		issuer: string,
		tokens: TokenSet,
		resource: string,
		clientId: string = IDP_DEFAULTS.clientId,
	): Promise<{ info: SessionInfo; revokeError?: Error }> {
		const sub = subjectOf(tokens.idToken) ?? subjectOf(tokens.accessToken);
		if (!tokens.refreshToken || !sub) {
			throw new Error("The identity provider returned no refresh token");
		}
		const refreshToken = tokens.refreshToken;
		const previous = await withFileLock(this.lockPath, async () => {
			const old = readSession(this.dir);
			const fresh: SessionFile = {
				version: 1,
				issuer,
				sub,
				clientId,
				generation: randomUUID(),
				refreshToken: await seal(this.dir, refreshToken),
				access: {
					[resource]: {
						token: await seal(this.dir, tokens.accessToken),
						expiresAt: this.deps.now() + tokens.expiresIn * 1000,
					},
				},
			};
			writeSession(this.dir, fresh);
			return old;
		});
		const info = { issuer, sub, clientId };
		if (!previous) return { info };
		const revokeError = await this.revokeGrant(previous);
		return revokeError ? { info, revokeError } : { info };
	}

	/**
	 * Takes over a plain-text session of an older tunelo or of the CLI 1.x
	 * when this machine has none yet. Returns false when one existed.
	 */
	async adopt(plain: PlainSession, resource: string): Promise<boolean> {
		return withFileLock(this.lockPath, async () => {
			if (readSession(this.dir)) return false;
			const access: Record<string, SealedToken> = {};
			if (plain.accessToken && plain.accessTokenExpiresAt) {
				access[resource] = {
					token: await seal(this.dir, plain.accessToken),
					expiresAt: plain.accessTokenExpiresAt,
				};
			}
			writeSession(this.dir, {
				version: 1,
				issuer: plain.issuer,
				sub: plain.sub,
				clientId: IDP_DEFAULTS.clientId,
				generation: randomUUID(),
				refreshToken: await seal(this.dir, plain.refreshToken),
				access,
			});
			return true;
		});
	}

	/**
	 * Revokes the grant at the IdP and forgets the session. Resolves with the
	 * issuer and the revocation error (the session is removed either way), or
	 * null when nobody was signed in.
	 */
	async signOut(): Promise<{ issuer: string; revokeError?: Error } | null> {
		const previous = await withFileLock(this.lockPath, async () => {
			const old = readSession(this.dir);
			rmSync(join(this.dir, SESSION_FILE), { force: true });
			return old;
		});
		if (!previous) return null;
		const revokeError = await this.revokeGrant(previous);
		return revokeError
			? { issuer: previous.issuer, revokeError }
			: { issuer: previous.issuer };
	}

	private async revokeGrant(session: SessionFile): Promise<Error | undefined> {
		try {
			const refreshToken = await this.openRefreshToken(session);
			await this.deps.revoke(
				await this.deps.discover(session.issuer),
				refreshToken,
				session.clientId,
			);
			return undefined;
		} catch (err) {
			return err instanceof Error ? err : new Error(String(err));
		}
	}
}

const sessions = new Map<string, IdentitySession>();

/** The session of a config folder, shared by everything in this process. */
export function identitySession(dir: string): IdentitySession {
	let session = sessions.get(dir);
	if (!session) {
		session = new IdentitySession(dir);
		sessions.set(dir, session);
	}
	return session;
}
