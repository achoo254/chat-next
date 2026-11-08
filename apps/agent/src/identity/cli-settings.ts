import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type StoredSession,
	parseSession,
	writePrivateFile,
} from "@tunelo/client";

export type { StoredSession } from "@tunelo/client";

export interface TuneloConfig {
	server?: string;
	/** Anonymous access token (`tunelo_…`) of CLI 1.6.x or `--legacy-key`. */
	key?: string;
	/** Stable per-machine id used for idempotent device login. */
	deviceId?: string;
	session?: StoredSession;
}

export function getConfigDir(): string {
	return join(homedir(), ".tunelo");
}

export function getConfigPath(): string {
	return join(getConfigDir(), "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads the config; a missing or corrupt file reads as empty. */
export function loadConfig(): TuneloConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(getConfigPath(), "utf-8"));
	} catch {
		return {};
	}
	if (!isRecord(raw)) return {};
	return {
		server: optionalString(raw.server),
		key: optionalString(raw.key),
		deviceId: optionalString(raw.deviceId),
		session: parseSession(raw.session),
	};
}

/**
 * Writes the config atomically (temp file + rename, so a concurrent reader
 * never sees half a file) with owner-only permissions.
 */
export function saveConfig(config: TuneloConfig): void {
	writePrivateFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

/** Read-modify-write helper. */
export function updateConfig(
	change: (config: TuneloConfig) => TuneloConfig,
): TuneloConfig {
	const next = change(loadConfig());
	saveConfig(next);
	return next;
}
