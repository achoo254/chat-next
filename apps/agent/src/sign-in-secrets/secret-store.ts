/**
 * Sign-in secrets kept on the machine: `secrets.json` in tunelo's config
 * folder (0600) lists them by site and name, each value sealed with the
 * user's key store (keystore.ts: Keychain, DPAPI), the site and name sealed
 * with it so an entry cannot be moved to another site. The file is read
 * again on every call, so `tunelo secrets remove` and the service agree.
 * One-time secrets never touch the disk: they live in memory for the session
 * they were given to.
 *
 * Another store of the same kind may keep its own file in the same folder
 * (Advisor's key: advisor/advisor-key-store.ts); what one file holds is
 * never reachable through a store of another.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { seal, unseal } from "../keystore.ts";
import { rememberSecret } from "../mcp/redact.ts";

export interface SavedSecretInfo {
	id: string;
	name: string;
	origin: string;
	createdAt: number;
	/** 0 when not used since it was saved. */
	lastUsedAt: number;
	/** Who saved it (a device label, "local"); kept only when the store's user gave it. */
	savedBy?: string;
	/** A short fingerprint of the value; kept only when the store's user gave it (never the value). */
	fingerprint?: string;
	/** Whose value it is, in the store user's own words (Advisor: "account"); kept only when given. */
	scope?: string;
}

interface SavedEntry extends SavedSecretInfo {
	sealed: string;
}

interface StoreFile {
	version: 1;
	secrets: SavedEntry[];
}

/** A secret tunelo holds the value of, saved or for one session. */
export interface HeldSecret {
	id: string;
	name: string;
	origin: string;
	saved: boolean;
}

export function newSecretId(): string {
	return randomBytes(12).toString("base64url");
}

/** The sign-in secrets' file name in the config folder. */
export const SECRETS_FILE = "secrets.json";

export function secretsFile(configDir: string, fileName = SECRETS_FILE): string {
	return join(configDir, fileName);
}

function isEntry(value: unknown): value is SavedEntry {
	const e = value as Partial<SavedEntry> | null;
	return (
		typeof e === "object" &&
		e !== null &&
		typeof e.id === "string" &&
		typeof e.name === "string" &&
		typeof e.origin === "string" &&
		typeof e.sealed === "string" &&
		typeof e.createdAt === "number" &&
		typeof e.lastUsedAt === "number" &&
		(e.savedBy === undefined || typeof e.savedBy === "string") &&
		(e.fingerprint === undefined || typeof e.fingerprint === "string") &&
		(e.scope === undefined || typeof e.scope === "string")
	);
}

/** The saved secrets' list, without values; [] when there is no file. A damaged file is an error, never overwritten. */
export function readSavedSecrets(configDir: string, fileName = SECRETS_FILE): SavedEntry[] {
	const file = secretsFile(configDir, fileName);
	if (!existsSync(file)) return [];
	const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoreFile>;
	if (parsed.version !== 1 || !Array.isArray(parsed.secrets) || !parsed.secrets.every(isEntry)) {
		throw new Error(`${file} is damaged; nothing was changed`);
	}
	return parsed.secrets;
}

function writeSavedSecrets(configDir: string, secrets: SavedEntry[], fileName = SECRETS_FILE): void {
	const file = secretsFile(configDir, fileName);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ version: 1, secrets } satisfies StoreFile, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

const info = (e: SavedEntry): SavedSecretInfo => ({
	id: e.id,
	name: e.name,
	origin: e.origin,
	createdAt: e.createdAt,
	lastUsedAt: e.lastUsedAt,
	...(e.savedBy !== undefined ? { savedBy: e.savedBy } : {}),
	...(e.fingerprint !== undefined ? { fingerprint: e.fingerprint } : {}),
	...(e.scope !== undefined ? { scope: e.scope } : {}),
});

/** By site, then name. */
export function listSavedSecrets(configDir: string, fileName = SECRETS_FILE): SavedSecretInfo[] {
	return readSavedSecrets(configDir, fileName)
		.map(info)
		.sort((a, b) => a.origin.localeCompare(b.origin) || a.name.localeCompare(b.name));
}

/** Forgets a saved secret; what it was, or undefined when there is none with that id. */
export function removeSavedSecret(configDir: string, id: string, fileName = SECRETS_FILE): SavedSecretInfo | undefined {
	const all = readSavedSecrets(configDir, fileName);
	const found = all.find((e) => e.id === id);
	if (!found) return undefined;
	writeSavedSecrets(
		configDir,
		all.filter((e) => e.id !== id),
		fileName,
	);
	return info(found);
}

/** Who saved a value and its fingerprint, kept beside it (SecretStore.save). */
export interface SaveNote {
	savedBy?: string;
	fingerprint?: string;
	scope?: string;
	/** When it counts as saved (Unix ms); the store's clock when not given. */
	createdAt?: number;
}

interface Once extends HeldSecret {
	value: string;
	session: string;
}

export class SecretStore {
	private readonly once = new Map<string, Once>();

	/** `fileName`: the file in `configDir` this store keeps its values in (secrets.json for sign-in secrets). */
	constructor(
		private readonly configDir: string,
		private readonly now: () => number = Date.now,
		private readonly fileName: string = SECRETS_FILE,
	) {}

	private read(): SavedEntry[] {
		return readSavedSecrets(this.configDir, this.fileName);
	}

	private write(secrets: SavedEntry[]): void {
		writeSavedSecrets(this.configDir, secrets, this.fileName);
	}

	list(): SavedSecretInfo[] {
		return listSavedSecrets(this.configDir, this.fileName);
	}

	/** The saved secret for this site and name, if any. */
	findSaved(origin: string, name: string): HeldSecret | undefined {
		const e = this.read().find((x) => x.origin === origin && x.name === name);
		return e ? { id: e.id, name: e.name, origin: e.origin, saved: true } : undefined;
	}

	/** Seals and saves a value (replacing one of the same site and name). */
	async save(origin: string, name: string, value: string, note: SaveNote = {}): Promise<HeldSecret> {
		const sealed = await seal(this.configDir, JSON.stringify({ origin, name, value }));
		rememberSecret(value);
		const all = this.read();
		const before = all.find((x) => x.origin === origin && x.name === name);
		const entry: SavedEntry = {
			id: before?.id ?? newSecretId(),
			name,
			origin,
			sealed,
			createdAt: note.createdAt ?? this.now(),
			lastUsedAt: 0,
			...(note.savedBy !== undefined ? { savedBy: note.savedBy } : {}),
			...(note.fingerprint !== undefined ? { fingerprint: note.fingerprint } : {}),
			...(note.scope !== undefined ? { scope: note.scope } : {}),
		};
		this.write([...all.filter((x) => x !== before), entry]);
		return { id: entry.id, name, origin, saved: true };
	}

	/** Forgets a saved value; what it was, or undefined when there is none with that id. */
	remove(id: string): SavedSecretInfo | undefined {
		return removeSavedSecret(this.configDir, id, this.fileName);
	}

	/** Keeps a value in memory for one session only. */
	keepOnce(session: string, origin: string, name: string, value: string): HeldSecret {
		rememberSecret(value);
		const held: Once = { id: newSecretId(), name, origin, saved: false, value, session };
		this.once.set(held.id, held);
		return { id: held.id, name, origin, saved: false };
	}

	/** What a secret is (saved or one-time), without its value. */
	describe(id: string): HeldSecret | undefined {
		const o = this.once.get(id);
		if (o) return { id: o.id, name: o.name, origin: o.origin, saved: false };
		const e = this.read().find((x) => x.id === id);
		return e ? { id: e.id, name: e.name, origin: e.origin, saved: true } : undefined;
	}

	/** The value of a secret, for filling it in or handing it to a command; marks a saved one used. */
	async reveal(id: string): Promise<string | undefined> {
		const o = this.once.get(id);
		if (o) return o.value;
		const e = this.read().find((x) => x.id === id);
		if (!e) return undefined;
		const opened = JSON.parse(await unseal(this.configDir, e.sealed)) as { origin?: unknown; name?: unknown; value?: unknown };
		if (opened.origin !== e.origin || opened.name !== e.name || typeof opened.value !== "string") {
			throw new Error(`the saved secret ${e.name} does not belong to ${e.origin}; remove it and enter it again`);
		}
		rememberSecret(opened.value);
		// Read again after the wait: a save or removal that landed meanwhile stays.
		const latest = this.read();
		if (latest.some((x) => x.id === id && x.sealed === e.sealed)) {
			this.write(latest.map((x) => (x.id === id && x.sealed === e.sealed ? { ...x, lastUsedAt: this.now() } : x)));
		}
		return opened.value;
	}

	/** Drops the one-time secrets of a session that ended. */
	endSession(session: string): void {
		for (const [id, o] of this.once) if (o.session === session) this.once.delete(id);
	}

	/**
	 * Opens every saved value once, so that one echoed by an old transcript is
	 * hidden too. A value that cannot be opened (key store locked) is skipped.
	 */
	async loadForRedaction(): Promise<void> {
		for (const e of this.read()) {
			try {
				const opened = JSON.parse(await unseal(this.configDir, e.sealed)) as { value?: unknown };
				if (typeof opened.value === "string") rememberSecret(opened.value);
			} catch {
				// locked or damaged: hidden once it is used
			}
		}
	}
}
