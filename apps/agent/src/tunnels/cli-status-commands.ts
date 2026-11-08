import type { Command } from "commander";
import { listRecords, removeRecord } from "./run-registry.js";
import { matchRuns } from "./run-target.js";

function formatUptime(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function registerStatusCommands(program: Command): void {
	program
		.command("status")
		.description("List tunnels running on this machine")
		.action(() => {
			const records = listRecords();
			if (records.length === 0) {
				console.log("No tunnels running.");
				return;
			}
			const now = Date.now();
			for (const r of records) {
				const tunnels = r.tunnels.length
					? r.tunnels.map((t) => `${t.url} → :${t.localPort}`).join(", ")
					: "(connecting…)";
				console.log(
					`PID ${r.pid}  [${r.kind}]  up ${formatUptime(now - r.startedAt)}  ${tunnels}`,
				);
			}
		});

	program
		.command("kill <target>")
		.description("Stop a running tunnel by PID, subdomain/URL, or 'all'")
		.action((target: string) => {
			const records = listRecords();
			const matches = target === "all" ? records : matchRuns(records, target);

			if (matches.length === 0) {
				console.log(`No running tunnel matches "${target}".`);
				return;
			}

			for (const r of matches) {
				try {
					process.kill(r.pid, "SIGTERM");
					console.log(`Stopped PID ${r.pid} (${r.kind}).`);
				} catch {
					// Process already gone — clear the stale record.
					removeRecord(r.pid);
					console.log(`PID ${r.pid} was not running — removed stale record.`);
				}
			}
		});
}
