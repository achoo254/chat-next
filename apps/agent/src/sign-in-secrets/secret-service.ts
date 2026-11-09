/**
 * Sign-in secrets for the sessions tunelo opens. Claude asks with
 * request_secret (site, name, why); tunelo answers with a reference only:
 *
 * - a secret saved for that site and name: its reference at once;
 * - otherwise every connected device gets a prompt (SecretPrompt), outside
 *   the transcript; the value the user types comes back end-to-end encrypted
 *   (SecretProvide), is sealed in the key store or kept in memory for the
 *   session, and Claude gets its reference. Declined, expired, or the
 *   session ended: Claude gets an error saying so.
 *
 * Sessions are named by their MCP ticket (one per claude process), so a
 * session that starts again for the same thread starts with no references.
 * A session may only use the references it was given (`grants`): fill_secret
 * into a page of the secret's site, or `$TUNELO_SECRET_<NAME>` in a command.
 * Every value given, every use and every removal is written to the consent
 * log, never the value.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "../safety/audit-log.ts";
import { FillError, fillPage, pagesOn, reachablePages } from "./cdp-fill.ts";
import { MAX_PURPOSE_CHARS, SecretInputError, checkName, checkValue, envName, idOfRef, normalizeOrigin, refOf } from "./secret-names.ts";
import { type HeldSecret, type SavedSecretInfo, SecretStore, removeSavedSecret } from "./secret-store.ts";

export const PROMPT_TTL_MS = 5 * 60_000;
/** Open prompts of one session at a time. */
const MAX_PROMPTS_PER_SESSION = 3;

export interface SecretPromptInfo {
	requestId: string;
	threadId: string;
	name: string;
	purpose: string;
	origin: string;
	expiresAt: number;
}

export type SecretEvent = { type: "prompt"; prompt: SecretPromptInfo } | { type: "ended"; requestId: string; threadId: string };

/** What request_secret answers: never a value. */
export interface SecretRef {
	ref: string;
	name: string;
	origin: string;
	saved: boolean;
	env: string;
}

/** Why a prompt failed, as the user's choice or the clock says. */
export class SecretRefused extends Error {}

/** A device answered a prompt that is no longer open. */
export class SecretPromptGone extends Error {}

/** A device asked to remove a secret the machine does not keep. */
export class SecretNotFound extends Error {}

/** One claude process of a thread: its MCP ticket and its thread. */
export interface SecretSession {
	key: string;
	threadId: string;
}

interface Pending extends SecretPromptInfo {
	key: string;
	resolve(ref: SecretRef): void;
	reject(err: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export interface SecretServiceOptions {
	configDir: string;
	audit: AuditLog;
	now?: () => number;
	ttlMs?: number;
	/** The browsers' debugging ports (cdp-fill.ts findDebugPorts when unset). */
	findDebugPorts?: () => Promise<number[]>;
}

const sessionLabel = (threadId: string) => `session ${threadId.slice(0, 8)}`;

export class SecretService {
	readonly store: SecretStore;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(event: SecretEvent) => void>();
	/** References each session was given: session key → secret id → secret. */
	private readonly grants = new Map<string, Map<string, HeldSecret>>();
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(private readonly opts: SecretServiceOptions) {
		this.store = new SecretStore(opts.configDir, opts.now);
		this.now = opts.now ?? Date.now;
		this.ttlMs = opts.ttlMs ?? PROMPT_TTL_MS;
	}

	/** Devices get prompts and their end from here; returns the unsubscribe. */
	onEvent(listener: (event: SecretEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The prompts open now (for a device that just connected). */
	openPrompts(): SecretPromptInfo[] {
		return [...this.pending.values()].map(({ requestId, threadId, name, purpose, origin, expiresAt }) => ({ requestId, threadId, name, purpose, origin, expiresAt }));
	}

	private emit(event: SecretEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private grant(key: string, held: HeldSecret): SecretRef {
		const mine = this.grants.get(key) ?? new Map<string, HeldSecret>();
		mine.set(held.id, held);
		this.grants.set(key, mine);
		return { ref: refOf(held.id), name: held.name, origin: held.origin, saved: held.saved, env: `$${envName(held.name)}` };
	}

	/** request_secret of a session: a reference, at once or once the user typed the value. */
	async request(session: SecretSession, input: { name: string; purpose: string; origin: string }): Promise<SecretRef> {
		const { key, threadId } = session;
		const name = checkName(input.name);
		const origin = normalizeOrigin(input.origin);
		const purpose = input.purpose.trim().slice(0, MAX_PURPOSE_CHARS);
		const saved = this.store.findSaved(origin, name);
		if (saved) return this.grant(key, saved);
		const same = [...this.pending.values()].find((p) => p.key === key && p.origin === origin && p.name === name);
		if (same) return new Promise((resolve, reject) => this.chain(same, resolve, reject));
		if ([...this.pending.values()].filter((p) => p.key === key).length >= MAX_PROMPTS_PER_SESSION) {
			throw new SecretInputError("this session already waits for several secrets; wait for the user to answer them");
		}
		const requestId = randomBytes(12).toString("base64url");
		const expiresAt = this.now() + this.ttlMs;
		return new Promise<SecretRef>((resolve, reject) => {
			const timer = setTimeout(() => this.end(requestId, new SecretRefused(`nobody entered ${name} for ${origin} within ${Math.round(this.ttlMs / 60_000)} minutes`)), this.ttlMs);
			timer.unref?.();
			const prompt: Pending = { key, requestId, threadId, name, purpose, origin, expiresAt, resolve, reject, timer };
			this.pending.set(requestId, prompt);
			this.emit({ type: "prompt", prompt: { requestId, threadId, name, purpose, origin, expiresAt } });
		});
	}

	/** A second request for what one session already waits for gets the same answer. */
	private chain(p: Pending, resolve: (r: SecretRef) => void, reject: (e: Error) => void): void {
		const first = { resolve: p.resolve, reject: p.reject };
		p.resolve = (r) => {
			first.resolve(r);
			resolve(r);
		};
		p.reject = (e) => {
			first.reject(e);
			reject(e);
		};
	}

	private end(requestId: string, outcome: SecretRef | Error): void {
		const p = this.pending.get(requestId);
		if (!p) return;
		this.pending.delete(requestId);
		clearTimeout(p.timer);
		this.emit({ type: "ended", requestId, threadId: p.threadId });
		if (outcome instanceof Error) p.reject(outcome);
		else p.resolve(outcome);
	}

	/** A device gave the value of an open prompt. */
	async provide(requestId: string, value: string, remember: boolean, device: string): Promise<void> {
		const p = this.pending.get(requestId);
		if (!p) throw new SecretPromptGone("this request is no longer open");
		checkValue(value);
		const held = remember ? await this.store.save(p.origin, p.name, value) : this.store.keepOnce(p.key, p.origin, p.name, value);
		this.opts.audit.write({ device, action: "secret_add", path: p.origin, detail: `${p.name} ${remember ? "saved" : "once"}` });
		this.end(requestId, this.grant(p.key, held));
	}

	/** A device will not give it. */
	decline(requestId: string): void {
		const p = this.pending.get(requestId);
		if (!p) throw new SecretPromptGone("this request is no longer open");
		this.end(requestId, new SecretRefused(`the user declined to give ${p.name} for ${p.origin}`));
	}

	/** A secret this session was given, by its reference. */
	private granted(key: string, ref: string): HeldSecret {
		const id = idOfRef(ref);
		const held = id ? this.grants.get(key)?.get(id) : undefined;
		if (!held) throw new SecretInputError(`${ref.slice(0, 80)} is not a secret reference this session was given; call request_secret first`);
		if (held.saved && !this.store.describe(held.id)) throw new SecretInputError(`${held.name} for ${held.origin} was removed on the machine; call request_secret again`);
		return held;
	}

	/** fill_secret: the value into a field of a page on the secret's site. */
	async fill(session: SecretSession, input: { ref: string; selector?: string; cdpUrl?: string }): Promise<{ filled: string; page: string }> {
		const held = this.granted(session.key, input.ref);
		const { pages } = await reachablePages(input.cdpUrl, this.opts.findDebugPorts);
		const on = pagesOn(pages, held.origin);
		if (on.length === 0) {
			const open = pages.map((p) => p.url).slice(0, 5);
			throw new FillError(
				`no page of ${held.origin} is open in the browser${open.length ? ` (open: ${open.join(", ")})` : ""}; tunelo only fills ${held.name} into a page of that site. Open the sign-in page first`,
			);
		}
		const page = on[0];
		if (!page) throw new FillError("no page");
		const value = await this.store.reveal(held.id);
		if (value === undefined) throw new SecretInputError(`${held.name} is no longer kept on the machine; call request_secret again`);
		const { field } = await fillPage(page, held.origin, value, input.selector);
		this.opts.audit.write({ device: sessionLabel(session.threadId), action: "secret_use", path: held.origin, detail: `${held.name} fill` });
		return { filled: field, page: held.origin };
	}

	/**
	 * The values of the secrets a command names (`$TUNELO_SECRET_<NAME>`),
	 * by environment variable; names this session was not given are left
	 * out (`missing`).
	 */
	async envFor(session: SecretSession, names: readonly string[]): Promise<{ env: Record<string, string>; missing: string[] }> {
		const mine = [...(this.grants.get(session.key)?.values() ?? [])];
		const env: Record<string, string> = {};
		const missing: string[] = [];
		for (const name of names) {
			// The latest reference of that name wins.
			const held = mine.filter((h) => h.name === name).at(-1);
			const value = held ? await this.store.reveal(held.id).catch(() => undefined) : undefined;
			if (!held || value === undefined) {
				missing.push(name);
				continue;
			}
			env[envName(name)] = value;
			this.opts.audit.write({ device: sessionLabel(session.threadId), action: "secret_use", path: held.origin, detail: `${name} env` });
		}
		return { env, missing };
	}

	/** Whether a session was given a secret of this name (the env path asks before using it). */
	hasName(key: string, name: string): boolean {
		return [...(this.grants.get(key)?.values() ?? [])].some((h) => h.name === name);
	}

	list(): SavedSecretInfo[] {
		return this.store.list();
	}

	/** Forgets a saved secret (from a device, or `tunelo secrets remove`). */
	remove(id: string, device: string): SavedSecretInfo[] {
		const gone = removeSavedSecret(this.opts.configDir, id);
		if (!gone) throw new SecretNotFound("the machine keeps no such secret");
		this.opts.audit.write({ device, action: "secret_remove", path: gone.origin, detail: gone.name });
		return this.store.list();
	}

	/** A session ended: its prompts close, its one-time secrets and references are dropped. */
	endSession(key: string): void {
		for (const p of [...this.pending.values()]) {
			if (p.key === key) this.end(p.requestId, new SecretRefused("the session ended"));
		}
		this.grants.delete(key);
		this.store.endSession(key);
	}

	/** Stops waiting for anything (the service stops). */
	close(): void {
		for (const p of [...this.pending.values()]) this.end(p.requestId, new SecretRefused("tunelo stopped"));
	}
}
