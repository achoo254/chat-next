// The terminal's path and round trip, always true to the path in use:
// "Trực tiếp 12 ms" over WebRTC, "Qua relay 85 ms" through the relay, or
// what the link is doing instead. A session's header shows it on every view
// (chat, terminal, Observe) under the title: with no terminal attached it
// tells the machine's own link, which always goes through the relay.
import { useSyncExternalStore } from "react";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import type { LinkStatus } from "../machines/link/machine-link.ts";
import { useHub, useLink } from "../machines/use-machines.ts";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import type { TerminalStatus } from "./terminal-link.ts";
import { terminalLinkFor } from "./terminal-links.ts";
import "./status-pill.css";

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

const IDLE: TerminalStatus = { kind: "idle" };
const noTerminal = { subscribe: () => () => undefined, status: () => IDLE };
const MACHINE_LINK: TerminalStatus = { kind: "open", path: "relay", rttMs: null, directIssue: "" };

/** What a session's header says: the terminal's path while one is attached, else the machine's link. */
function sessionStatus(link: LinkStatus, terminal: TerminalStatus): TerminalStatus {
	if (link.kind === "connecting") return { kind: "connecting" };
	if (link.kind === "open" && terminal.kind === "idle") return MACHINE_LINK;
	return terminal;
}

/**
 * The path pill of a session's header, the same on every view. `terminal`
 * is false where the machine's AI has no terminal: only its link then.
 */
export function SessionPathPill({ machine, terminal }: { machine: string; terminal: boolean }) {
	const t = useMachinesCopy();
	const hub = useHub();
	const [, state] = useLink(hub, machine);
	const source = terminal ? terminalLinkFor(hub, machine) : noTerminal;
	const status = sessionStatus(state.status, useSyncExternalStore(source.subscribe, source.status));
	// "Connecting" is shown as such, not as offline.
	const online = state.status.kind === "open" || state.status.kind === "connecting";
	return <StatusPill t={t.terminal} status={status} online={online} />;
}
