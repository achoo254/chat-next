/**
 * Settings of the tunnel commands, kept in `<config dir>/cli.json` beside the
 * rest of tunelo: the default Tunelo server, an anonymous access token of an
 * older CLI (`--legacy-key`) and the per-machine id sent with tunnels. The
 * Tunelo CLI 1.x kept them in `~/.tunelo/config.json` (legacy-import.ts
 * copies them once). The account session lives in session.ts, sealed.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "@tunelo/client";
import { configDir } from "../config.ts";

export interface CliSettings {
	server?: string | undefined;
	/** Anonymous access token (`tunelo_…`) of CLI 1.6.x or `--legacy-key`. */
	key?: string | undefined;
	/** Stable per-machine id used for idempotent device login. */
	deviceId?: string | undefined;
}

export const SETTINGS_FILE = "cli.json";

export function settingsPath(dir: string = configDir()): string {
	return join(dir, SETTINGS_FILE);
}

/** Where the Tunelo CLI 1.x kept its config and session. */
export function legacyCliDir(home: string = homedir()): string {
	return join(home, ".tunelo");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The three settings out of untrusted JSON (also the 1.x config file). */
export function parseSettings(raw: unknown): CliSettings {
	if (!isRecord(raw)) return {};
	const settings: CliSettings = {};
	const server = optionalString(raw.server);
	const key = optionalString(raw.key);
	const deviceId = optionalString(raw.deviceId);
	if (server) settings.server = server;
	if (key) settings.key = key;
	if (deviceId) settings.deviceId = deviceId;
	return settings;
}

/** Reads the settings; a missing or corrupt file reads as empty. */
export function loadSettings(dir: string = configDir()): CliSettings {
	try {
		return parseSettings(JSON.parse(readFileSync(settingsPath(dir), "utf-8")));
	} catch {
		return {};
	}
}

/**
 * Writes the settings atomically (temp file + rename, so a concurrent reader
 * never sees half a file) with owner-only permissions.
 */
export function saveSettings(
	settings: CliSettings,
	dir: string = configDir(),
): void {
	writePrivateFile(settingsPath(dir), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Read-modify-write helper. */
export function updateSettings(
	change: (settings: CliSettings) => CliSettings,
	dir: string = configDir(),
): CliSettings {
	const next = change(loadSettings(dir));
	saveSettings(next, dir);
	return next;
}

/** Stable per-machine id; created once and persisted in the settings. */
export function getDeviceId(dir: string = configDir()): string {
	const existing = loadSettings(dir).deviceId;
	if (existing) return existing;
	const deviceId = randomUUID();
	updateSettings((settings) => ({ ...settings, deviceId }), dir);
	return deviceId;
}

/** Machine details sent with `auth` so the account can tell machines apart. */
export function deviceInfo(dir: string = configDir()): {
	deviceId: string;
	deviceName: string;
} {
	return { deviceId: getDeviceId(dir), deviceName: hostname().slice(0, 80) };
}
