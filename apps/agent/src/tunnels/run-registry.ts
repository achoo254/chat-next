import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunTunnel {
	url: string;
	localPort: number;
}

/** On-disk record of a running `tunelo http`/`tcp` process. */
export interface RunRecord {
	pid: number;
	kind: "http" | "tcp";
	startedAt: number;
	server: string;
	tunnels: RunTunnel[];
	/** Local inspector of an `http` process (`tunelo watch` reads it). */
	inspectorPort?: number;
}

function getRunDir(): string {
	return join(homedir(), ".tunelo", "running");
}

function recordPath(pid: number): string {
	return join(getRunDir(), `${pid}.json`);
}

/** True if a process with this pid currently exists. */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process; EPERM = exists but not ours (still alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function saveRecord(record: RunRecord): void {
	const dir = getRunDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(recordPath(record.pid), JSON.stringify(record));
}

export function removeRecord(pid: number): void {
	rmSync(recordPath(pid), { force: true });
}

/** List live tunnel processes, pruning records whose process has exited. */
export function listRecords(): RunRecord[] {
	const dir = getRunDir();
	if (!existsSync(dir)) return [];
	const records: RunRecord[] = [];
	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".json")) continue;
		const path = join(dir, file);
		let record: RunRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf-8")) as RunRecord;
		} catch {
			rmSync(path, { force: true });
			continue;
		}
		if (!isAlive(record.pid)) {
			rmSync(path, { force: true });
			continue;
		}
		records.push(record);
	}
	return records.sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Register this process as a running tunnel and keep the record in sync.
 * Returns an `update` to refresh the tunnel list as tunnels connect.
 */
export function startRunRecord(
	kind: "http" | "tcp",
	server: string,
): {
	update: (tunnels: RunTunnel[]) => void;
	setInspectorPort: (port: number) => void;
} {
	const pid = process.pid;
	const record: RunRecord = {
		pid,
		kind,
		startedAt: Date.now(),
		server,
		tunnels: [],
	};
	saveRecord(record);

	const cleanup = (): void => removeRecord(pid);
	process.on("exit", cleanup);
	// SIGINT is handled by the command (prints stats); SIGTERM needs its own exit
	// so `tunelo kill` leaves no stale record.
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});

	return {
		update(tunnels: RunTunnel[]): void {
			record.tunnels = tunnels;
			saveRecord(record);
		},
		setInspectorPort(port: number): void {
			record.inspectorPort = port;
			saveRecord(record);
		},
	};
}
