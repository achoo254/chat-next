// The tunelo service's status row of the machine's "about" card: whether it
// runs (since when, its pid and memory). A machine that is not connected shows
// why instead. Its services and ports are agent-services-panel.tsx's.
import type { MachineInfo } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { Conn } from "./machine-status.ts";
import { connText } from "./session-row.tsx";

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
		</>
	);
}
