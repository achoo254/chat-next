// tunelo's services on a machine's page, as rows to draw: each port of
// MachineInfo.runtime with its state, why it does not run and what a device
// may do to it. An older tunelo tells only whether a port listens; its rows
// get no buttons.
import { AgentPortKind, AgentServiceAction, AgentServiceProblem, AgentServiceState, type AgentRuntime } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "./copy-vi.ts";

export type ServiceKindKey = keyof MachinesCopy["services"]["kind"];
export type ServiceStateKey = keyof MachinesCopy["services"]["state"];
export type ServiceProblemKey = Exclude<keyof MachinesCopy["services"]["problem"], "portTaken">;

export type ServiceRow = {
	/** Unique in the list: kind, port and tunnel. */
	key: string;
	kind: ServiceKindKey;
	portKind: AgentPortKind;
	/** 0 when the service has no port now. */
	port: number;
	state: ServiceStateKey;
	problem: ServiceProblemKey | undefined;
	controls: readonly AgentServiceAction[];
	tunnelId: string;
	urls: readonly string[];
};

const KIND: Readonly<Partial<Record<AgentPortKind, ServiceKindKey>>> = {
	[AgentPortKind.DEVICE_LINK]: "link",
	[AgentPortKind.SESSION_MCP]: "mcp",
	[AgentPortKind.OBSERVATORY]: "observatory",
	[AgentPortKind.CONTROL]: "control",
	[AgentPortKind.TUNNEL_HTTP]: "tunnelHttp",
	[AgentPortKind.TUNNEL_TCP]: "tunnelTcp",
};

const STATE: Readonly<Partial<Record<AgentServiceState, ServiceStateKey>>> = {
	[AgentServiceState.RUNNING]: "running",
	[AgentServiceState.OFF]: "off",
	[AgentServiceState.PORT_TAKEN]: "portTaken",
	[AgentServiceState.FAILED]: "failed",
};

const PROBLEM: Readonly<Partial<Record<AgentServiceProblem, ServiceProblemKey>>> = {
	[AgentServiceProblem.TOKEN_UNREADABLE]: "tokenUnreadable",
	[AgentServiceProblem.NO_FREE_PORT]: "noFreePort",
	[AgentServiceProblem.STORE_FAILED]: "storeFailed",
	[AgentServiceProblem.OTHER]: "other",
};

export function serviceRows(runtime: AgentRuntime): ServiceRow[] {
	const rows: ServiceRow[] = [];
	for (const p of runtime.ports) {
		const kind = KIND[p.kind];
		// A kind this page does not know yet (a newer tunelo) is left out.
		if (kind === undefined) continue;
		const state = STATE[p.state] ?? (p.listening ? "running" : "portTaken");
		rows.push({
			key: `${p.kind}:${p.port}:${p.tunnelId}`,
			kind,
			portKind: p.kind,
			port: p.port,
			state,
			problem: state === "failed" ? (PROBLEM[p.problem] ?? "other") : undefined,
			controls: runtime.serviceControl ? p.controls : [],
			tunnelId: p.tunnelId,
			urls: p.urls,
		});
	}
	return rows;
}

/** How many run, and how many need a look (an error or a taken port); one turned off is neither. */
export function serviceCounts(rows: readonly ServiceRow[]): { total: number; running: number; problems: number } {
	return {
		total: rows.length,
		running: rows.filter((r) => r.state === "running").length,
		problems: rows.filter((r) => r.state === "failed" || r.state === "portTaken").length,
	};
}
