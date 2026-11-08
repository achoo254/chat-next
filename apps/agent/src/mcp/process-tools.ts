/**
 * Tunnels other `tunelo http`/`tcp` processes run on this machine, as
 * `tunelo status` and `tunelo kill` see them (the run records in this
 * user's ~/.tunelo).
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type RunRecord,
	type RunTunnel,
	listRecords,
	removeRecord,
} from "../run-registry.js";
import { matchRuns } from "../run-target.js";
import { attempt } from "./mcp-result.js";

export interface LocalTunnelProcess {
	pid: number;
	kind: RunRecord["kind"];
	startedAt: string;
	tunnels: RunTunnel[];
	/** Its requests can be read with list_tunnel_requests. */
	inspectable: boolean;
}

export function listTunnelProcesses(): LocalTunnelProcess[] {
	return listRecords().map((record) => ({
		pid: record.pid,
		kind: record.kind,
		startedAt: new Date(record.startedAt).toISOString(),
		tunnels: record.tunnels,
		inspectable: record.kind === "http" && Boolean(record.inspectorPort),
	}));
}

/** SIGTERM, as `tunelo kill`: the process removes its own record and exits. */
function stop(record: RunRecord): { stopped: number; wasRunning: boolean } {
	try {
		process.kill(record.pid, "SIGTERM");
		return { stopped: record.pid, wasRunning: true };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			throw new Error(`PID ${record.pid} belongs to another user.`);
		}
		removeRecord(record.pid);
		return { stopped: record.pid, wasRunning: false };
	}
}

export function registerProcessTools(server: McpServer): void {
	server.registerTool(
		"close_local_tunnel_process",
		{
			title: "Stop a tunnel process on this machine",
			description:
				"Stop a `tunelo http` or `tunelo tcp` someone started on this machine (listed under `processes` by list_local_tunnels), like `tunelo kill`. Every tunnel of that process closes. Tunnels this MCP server opened close with close_tunnel instead.",
			inputSchema: z.object({
				target: z
					.string()
					.min(1)
					.max(256)
					.describe("The PID, or a subdomain or URL of one of its tunnels"),
			}),
			annotations: { destructiveHint: true, openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				const matches = matchRuns(listRecords(), args.target);
				const [only, ...rest] = matches;
				if (!only) {
					throw new Error(
						`No tunnel process matches "${args.target}" (see list_local_tunnels).`,
					);
				}
				if (rest.length > 0) {
					const pids = matches.map((record) => record.pid).join(", ");
					throw new Error(
						`Several processes match "${args.target}"; name one PID: ${pids}.`,
					);
				}
				return { ...stop(only), kind: only.kind, tunnels: only.tunnels };
			}),
	);
}
