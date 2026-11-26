// The tunelo service's rows of the machine's "about" card: whether it runs
// (since when, its pid and memory) and the ports it has open. A machine that
// is not connected shows why instead, and no ports (they would be stale).
import { AgentPortKind, type AgentPort, type MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { Conn } from "./machine-status.ts";
import { connText } from "./session-row.tsx";

type PortKindKey = keyof MachinesCopy["detail"]["portKind"];

const PORT_KIND: Readonly<Partial<Record<AgentPortKind, PortKindKey>>> = {
	[AgentPortKind.DEVICE_LINK]: "link",
	[AgentPortKind.SESSION_MCP]: "mcp",
	[AgentPortKind.OBSERVATORY]: "observatory",
	[AgentPortKind.CONTROL]: "control",
	[AgentPortKind.TUNNEL_HTTP]: "tunnelHttp",
	[AgentPortKind.TUNNEL_TCP]: "tunnelTcp",
};

function portLabel(t: MachinesCopy, port: AgentPort): string {
	const key = PORT_KIND[port.kind];
	return key === undefined ? "—" : t.detail.portKind[key];
}

export function AgentRuntimeRows({ t, conn, info, now }: { t: MachinesCopy; conn: Conn; info: MachineInfo | null; now: number }) {
	const { locale } = useI18n();
	if (conn.kind !== "on") {
		return (
			<>
				<dt>{t.detail.status}</dt>
				<dd>
					<span className={conn.kind === "offline" || conn.kind === "blocked" ? "chip mx-chip offline" : "chip mx-chip warn"} data-id="agent-status">
						{connText(t, conn, now)}
					</span>
				</dd>
			</>
		);
	}
	const runtime = info?.runtime;
	const startedAt = runtime === undefined ? 0 : Number(runtime.startedAt);
	return (
		<>
			<dt>{t.detail.status}</dt>
			<dd>
				<span className="chip mx-chip ok" data-id="agent-status">
					{t.detail.running}
				</span>
				{runtime !== undefined && startedAt > 0 && (
					<span className="muted mx-runtime-since">
						{" "}
						<time dateTime={new Date(startedAt).toISOString()}>
							{t.detail.runningSince(
								new Date(startedAt).toLocaleString(locale, { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
								runtime.pid,
								info?.memoryMb ?? 0,
							)}
						</time>
					</span>
				)}
			</dd>
			{/* An older tunelo does not tell its ports: the row is left out rather than saying "none". */}
			{runtime !== undefined && (
				<>
					<dt>{t.detail.ports}</dt>
					<dd>
						{runtime.ports.length === 0 ? (
							<span className="muted">{t.detail.noPorts}</span>
						) : (
							<ul className="mx-ports" data-id="agent-ports">
								{runtime.ports.map((p) => (
									<li key={`${p.kind}:${p.port}`}>
										<span className="mono">{p.port}</span>
										<span>{portLabel(t, p)}</span>
										{!p.listening && <span className="chip mx-chip warn">{t.detail.portTaken}</span>}
										{p.urls.map((url) => (
											<a key={url} className="mono mx-port-url" href={url} target="_blank" rel="noreferrer">
												{url}
											</a>
										))}
									</li>
								))}
							</ul>
						)}
					</dd>
				</>
			)}
		</>
	);
}
