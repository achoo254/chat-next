// The terminal's path and round trip, always true to the path in use:
// "Trực tiếp 12 ms" over WebRTC, "Qua relay 85 ms" through the relay, or
// what the link is doing instead.
import type { MachinesCopy } from "../machines/copy-vi.ts";
import type { TerminalStatus } from "./terminal-link.ts";

type Tone = "direct" | "relay" | "wait" | "off";

export function pillOf(t: MachinesCopy["terminal"], status: TerminalStatus, online: boolean): { tone: Tone; text: string; hint: string } {
	if (!online) return { tone: "off", text: t.offline, hint: t.offline };
	switch (status.kind) {
		case "open":
			return status.path === "direct"
				? { tone: "direct", text: t.direct(status.rttMs), hint: t.directHint }
				: { tone: "relay", text: t.relay(status.rttMs), hint: t.relayHint };
		case "reconnecting":
			return { tone: "wait", text: t.reconnecting, hint: t.reconnecting };
		case "failed":
			return { tone: "off", text: t.failedShort, hint: t.failed[status.reason] };
		default:
			return { tone: "wait", text: t.connecting, hint: t.connecting };
	}
}

export function StatusPill({ t, status, online }: { t: MachinesCopy["terminal"]; status: TerminalStatus; online: boolean }) {
	// Online with no terminal attached there is no path to show yet.
	if (online && status.kind === "idle") return null;
	const pill = pillOf(t, status, online);
	return (
		<span className="tx-pill" data-tone={pill.tone} title={pill.hint} data-id="terminal-path">
			<span className="dot" aria-hidden="true" />
			<span>{pill.text}</span>
		</span>
	);
}
