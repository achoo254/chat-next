// The repository key of a git remote URL, the same rule as the server's
// (server/internal/gitremote, copied from Orca) and tested against the same
// vectors (spec/git-remote/test-vectors.json): scp-like, ssh, http(s) and git
// forms of one repository give one key, "host/path" in lower case, without
// scheme, user, password, port, leading or trailing slashes or a trailing
// ".git". A local path, a malformed URL or a key holding "@" has no key.

/** Bytes, as the server counts them. */
const MAX_URL_LEN = 2048;
const MAX_KEY_LEN = 512;

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const SCP_LIKE = /^([^@\s:]+@)?([^:\s]+):(.+)$/;
// C0 and C1 controls, as Go's unicode.IsControl.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

function normalizePath(path: string): string {
	const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
	return trimmed.endsWith(".git") ? trimmed.slice(0, -".git".length) : trimmed;
}

/** The repository key of `remote`, or null when it names no repository on a host. */
export function canonicalRemote(remote: string): string | null {
	const trimmed = remote.trim();
	if (trimmed === "" || byteLength(trimmed) > MAX_URL_LEN || LONE_SURROGATE.test(trimmed) || CONTROL.test(trimmed)) return null;
	if (DRIVE_PATH.test(trimmed)) return null;
	let host: string;
	let path: string;
	const scp = trimmed.includes("://") ? null : SCP_LIKE.exec(trimmed);
	if (scp !== null) {
		host = scp[2] ?? "";
		path = scp[3] ?? "";
	} else {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		// Go's Hostname() drops the brackets of an IPv6 host.
		host = url.hostname.replace(/^\[(.*)\]$/, "$1");
		path = url.pathname;
	}
	host = host.trim().toLowerCase();
	path = normalizePath(path);
	if (host === "" || path === "") return null;
	const key = `${host}/${path}`.toLowerCase();
	if (key.includes("@") || byteLength(key) > MAX_KEY_LEN) return null;
	return key;
}

/** The repository's name, the last part of its key ("github.com/a/chat-next" → "chat-next"). */
export function repoName(key: string): string {
	return key.split("/").at(-1) ?? key;
}

/**
 * A URL the server reads back as `key` (it takes URLs, not keys), so a
 * remote as git reports it, with whatever user it holds, never leaves the device.
 */
export function remoteUrlFor(key: string, raw: string): string {
	const url = `https://${key}`;
	return canonicalRemote(url) === key ? url : raw;
}

/**
 * Attaching a folder whose repository differs from the one the project links:
 * refused, as Orca does. A project linking none, or a folder outside git (or
 * whose remote the machine did not report), takes anything.
 */
export function remoteMismatch(projectKey: string, folderRemote: string): boolean {
	if (projectKey === "") return false;
	const key = canonicalRemote(folderRemote);
	return key !== null && key !== projectKey;
}
