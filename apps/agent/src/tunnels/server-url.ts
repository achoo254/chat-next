import { serverIdentity } from "@tunelo/client";
import { loadConfig, updateConfig } from "./config.js";
import { DEFAULT_SERVER_URL } from "./default-server.js";

export { DEFAULT_SERVER_URL } from "./default-server.js";
/** Hosts of the old domain; saved configs pointing there move over. */
const RETIRED_HOSTS = new Set(["tunnel.inetdev.io.vn"]);

function isRetired(url: string): boolean {
	try {
		return RETIRED_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * Server to use: `--server`, then `TUNELO_SERVER`, then the saved config,
 * then the default. A saved config on the retired domain is rewritten to
 * the new one once, and `onMigrated` is told so the user sees a notice,
 * unless the saved sign-in belongs to that server's own domain: the domain
 * can come back as another tenant (`tunelo login --server`).
 */
export function resolveServerUrl(
	flag?: string,
	onMigrated?: (from: string, to: string) => void,
): string {
	if (flag) return flag;
	if (process.env.TUNELO_SERVER) return process.env.TUNELO_SERVER;
	const { server: saved, session } = loadConfig();
	if (!saved) return DEFAULT_SERVER_URL;
	const ownSignIn =
		session !== undefined && serverIdentity(saved)?.issuer === session.issuer;
	if (isRetired(saved) && !ownSignIn) {
		updateConfig((config) => ({ ...config, server: DEFAULT_SERVER_URL }));
		onMigrated?.(saved, DEFAULT_SERVER_URL);
		return DEFAULT_SERVER_URL;
	}
	return saved;
}

/** Notice printed (to stderr) when a saved server was migrated. */
export function printServerMigration(from: string, to: string): void {
	process.stderr.write(
		`  Tunelo moved: server ${from} → ${to} (config updated)\n`,
	);
}
