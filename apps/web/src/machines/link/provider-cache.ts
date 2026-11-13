// The AIs each machine reported the last time it was online
// (MachineInfo.providers), kept on this device so a machine's page still
// lists them, with their versions, while the machine is offline. Only names
// and versions are kept; storage that fails (private mode, quota) only means
// nothing is shown offline.
import type { ProviderInfo } from "@achoo254/chat-proto/remote/remote";

const KEY_PREFIX = "machines:providers:";
/** A machine reporting more than this is not a machine this page knows. */
const MAX_PROVIDERS = 16;
const MAX_TEXT = 200;

export interface CachedProvider {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	/** The installed CLI is outside the range the agent was tested with. */
	readonly untested: boolean;
}

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

/** Keeps what the machine `ref` reports now. */
export function rememberProviders(ref: string, providers: readonly ProviderInfo[]): void {
	const kept: CachedProvider[] = providers.slice(0, MAX_PROVIDERS).map((p) => ({ id: p.id, name: p.name, version: p.version, untested: p.untestedVersion }));
	try {
		storage()?.setItem(KEY_PREFIX + ref, JSON.stringify(kept));
	} catch {
		// Full or refused: the offline list stays as it was.
	}
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length <= MAX_TEXT ? value : null;
}

/** What `ref` reported last; empty when nothing (valid) was kept. */
export function cachedProviders(ref: string): CachedProvider[] {
	let raw: unknown;
	try {
		raw = JSON.parse(storage()?.getItem(KEY_PREFIX + ref) ?? "[]");
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	const out: CachedProvider[] = [];
	for (const item of raw.slice(0, MAX_PROVIDERS)) {
		if (typeof item !== "object" || item === null) continue;
		const { id, name, version, untested } = item as Record<string, unknown>;
		const i = text(id);
		const n = text(name);
		const v = text(version);
		if (i === null || i === "" || n === null || v === null) continue;
		out.push({ id: i, name: n, version: v, untested: untested === true });
	}
	return out;
}

/** Forgets what `ref` reported (the machine was removed from this device). */
export function forgetProviders(ref: string): void {
	try {
		storage()?.removeItem(KEY_PREFIX + ref);
	} catch {
		// Nothing to forget.
	}
}
