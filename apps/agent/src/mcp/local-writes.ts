// Whether MCP clients without a session ticket (`claude mcp add tunelo --
// tunelo mcp`, or any process of the user that reads control.json) may run
// write tools: `mcp-local-writes.json` in the config folder, off unless the
// user turns it on with `tunelo config mcp-local-writes on`. Writes of the
// claude sessions tunelo opens do not depend on it: they need the device's
// approval (write-approvals.ts). Like local-forward.json, the file is apart
// from config.json, read again whenever it changed on disk, and every change
// is a read-modify-write under a lock; anything unreadable counts as off.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { withFileLock, writePrivateFile } from "@tunelo/client";

export const LOCAL_WRITES_FILE = "mcp-local-writes.json";

export const LOCAL_WRITES_OFF =
	"Write tools are off for MCP clients outside the claude sessions tunelo opens (they only read). The owner of this machine can turn them on by running `tunelo config mcp-local-writes on` in a terminal; the AI client then approves every write itself.";

export class LocalWritesSetting {
	readonly file: string;
	private cache: { key: string; enabled: boolean } | undefined;

	constructor(dir: string) {
		this.file = join(dir, LOCAL_WRITES_FILE);
	}

	/** On only when the file says so. */
	enabled(): boolean {
		let key: string;
		try {
			const st = statSync(this.file);
			key = `${st.ino}:${st.size}:${st.mtimeMs}`;
		} catch {
			return false;
		}
		if (this.cache?.key !== key) {
			let enabled: boolean;
			try {
				enabled = (JSON.parse(readFileSync(this.file, "utf8")) as { enabled?: unknown }).enabled === true;
			} catch {
				enabled = false;
			}
			this.cache = { key, enabled };
		}
		return this.cache.enabled;
	}

	/** Writes the setting atomically, under the lock; returns it as now on disk. */
	async set(enabled: boolean): Promise<boolean> {
		return withFileLock(`${this.file}.lock`, async () => {
			writePrivateFile(this.file, `${JSON.stringify({ enabled }, null, 2)}\n`);
			this.cache = undefined;
			return this.enabled();
		});
	}
}
