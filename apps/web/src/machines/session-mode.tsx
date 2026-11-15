// How a session opens: the chat view, its AI's own CLI in the machine's
// terminal (for those who prefer the CLI), or its office (the AI and its
// subagents at work in a small building, view only). The terminal is offered
// only when the machine has its terminal and the session's AI opens there
// (ProviderCapabilities.terminal); the office when the machine's tunelo keeps
// one (AGENT_OFFICE). Each session remembers, on this device,
// the mode it was last opened in: switching one session never moves another.
// The machine keeps only the pick of the new-session dialog. While
// the CLI holds a session, the chat view shows it read-only and points to
// the terminal: no two views write to one session.
import { useState, type ReactElement } from "react";
import type { MachineInfo, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { navigate, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { AGENT_OFFICE, terminalGate, versionAtLeast } from "./agent-version.ts";
import { iconSvg } from "../components/icon.tsx";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { endOnPurpose } from "../terminal/ended-sessions.ts";
import { errorText, isRunning, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export type SessionMode = "chat" | "terminal" | "office";

const MODE_KEY = (machine: string) => `ai:mode:${machine}`;

/** The session's AI opens in the machine's terminal. */
export function terminalOffered(info: MachineInfo | null, provider: string): boolean {
	return terminalGate(info) === "available" && providerOf(info, provider)?.capabilities?.terminal === true;
}

/** The machine's tunelo keeps the office of a session. */
export function officeOffered(info: Pick<MachineInfo, "agentVersion"> | null): boolean {
	return info !== null && versionAtLeast(info.agentVersion, AGENT_OFFICE);
}

/** The views a session offers, in the order the switch shows them. */
export function sessionModes(terminal: boolean, office: boolean): SessionMode[] {
	return ["chat", ...(terminal ? (["terminal"] as const) : []), ...(office ? (["office"] as const) : [])];
}

/** The mode new sessions on the machine open in, as last picked when starting one (chat when none, or when storage is refused). */
export function lastMode(machine: string): SessionMode {
	try {
		return window.localStorage.getItem(MODE_KEY(machine)) === "terminal" ? "terminal" : "chat";
	} catch {
		return "chat";
	}
}

export function rememberMode(machine: string, mode: SessionMode): void {
	try {
		window.localStorage.setItem(MODE_KEY(machine), mode);
	} catch {
		// Private mode: the choice holds for this page only.
	}
}

const SESSION_MODE_KEY = (machine: string, threadId: string) => `ai:mode:${machine}:${threadId}`;

/** The mode the session was last opened in on this device; chat when never, or for a value this app does not know (another session's choice never applies). */
export function sessionModeOf(machine: string, threadId: string): SessionMode {
	try {
		const kept = window.localStorage.getItem(SESSION_MODE_KEY(machine, threadId));
		return kept === "terminal" || kept === "office" ? kept : "chat";
	} catch {
		return "chat";
	}
}

/** The session was just opened in `mode` (each visit records it). */
export function rememberSessionMode(machine: string, threadId: string, mode: SessionMode): void {
	try {
		window.localStorage.setItem(SESSION_MODE_KEY(machine, threadId), mode);
	} catch {
		// Storage refused: the session opens in chat next time.
	}
}

/**
 * The view a session row names: a live hold wins (held by a terminal: the
 * terminal; open as a chat in this app: the chat), else the mode it was last
 * opened in.
 */
export function rowMode(machine: string, thread: Pick<ThreadSummary, "id" | "terminalSession" | "open">): SessionMode {
	if (thread.terminalSession > 0) return "terminal";
	if (thread.open) return "chat";
	return sessionModeOf(machine, thread.id);
}

export function modePath(machine: string, threadId: string, mode: SessionMode): string {
	if (mode === "terminal") return aiPaths.sessionTerminal(machine, threadId);
	return mode === "office" ? aiPaths.sessionOffice(machine, threadId) : paths.machineSession(machine, threadId);
}

/** Switch this one session to `mode`: it remembers the choice, no other session moves. */
export function openSessionIn(machine: string, threadId: string, mode: SessionMode): void {
	rememberSessionMode(machine, threadId, mode);
	navigate(modePath(machine, threadId, mode));
}

/**
 * Where a session opens from a list: the view its row names; the terminal
 * only when offered (`offered`). An office it was left in opens there (only
 * a machine that keeps offices let it be picked; an older one says to update).
 */
export function sessionPath(machine: string, thread: Pick<ThreadSummary, "id" | "terminalSession" | "open">, offered: boolean): string {
	const mode = rowMode(machine, thread);
	return modePath(machine, thread.id, mode === "terminal" && !offered ? "chat" : mode);
}

/** A small building: the office view. */
const OFFICE_ICON = (
	<>
		<path d="M4 20V6l8-3 8 3v14" />
		<path d="M2.5 20h19M9 20v-4h6v4M8 8h2M14 8h2M8 12h2M14 12h2" />
	</>
);

/** The icon of a view. */
export function ModeIcon({ mode }: { mode: SessionMode }): ReactElement {
	if (mode === "office") return iconSvg(OFFICE_ICON, true);
	return <MachineIcon name={mode === "terminal" ? "terminal" : "chat"} small />;
}

/** "Chat | Terminal | Office" in the session header: only with two views or more. */
export function ModeSwitch({ machine, threadId, mode, modes }: { machine: string; threadId: string; mode: SessionMode; modes: readonly SessionMode[] }) {
	const t = useMachinesCopy();
	if (modes.length < 2) return null;
	const pick = (next: SessionMode) => openSessionIn(machine, threadId, next);
	return (
		<div className="mx-view-switch" role="group" aria-label={t.terminal.mode.label}>
			{modes.map((m) => (
				<button key={m} type="button" aria-pressed={mode === m} aria-label={t.terminal.mode[m]} title={t.terminal.mode[m]} onClick={() => pick(m)} data-id={`session-mode-${m}`}>
					<ModeIcon mode={m} />
					<span className="mx-view-word">{t.terminal.mode[m]}</span>
				</button>
			))}
		</div>
	);
}

/** Above the composer while the session's AI runs in the terminal: the terminal, or ending it there. */
export function TerminalHeldBar({ machine, link, thread, ai }: { machine: string; link: MachineLink; thread: ThreadSummary; ai: string }) {
	const t = useMachinesCopy();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const end = () => {
		setBusy(true);
		setError("");
		endOnPurpose(machine, thread.terminalSession);
		link.request({ case: "termClose", value: { session: thread.terminalSession } }).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	return (
		<section className="mx-limit mx-held" role="status" data-id="session-terminal-held">
			<div className="mx-limit-inner">
				<MachineIcon name="terminal" />
				<p>{isRunning(thread) ? t.terminal.held(ai) : t.terminal.heldOpen(ai)}</p>
				<div className="mx-limit-acts">
					<button type="button" className="btn btn-sm mx-btn-ghost" disabled={busy} onClick={end} title={t.terminal.endHint}>
						{t.terminal.end}
					</button>
					<button
						type="button"
						className="btn btn-sm btn-primary"
						onClick={() => openSessionIn(machine, thread.id, "terminal")}
					>
						{t.terminal.showTerminal}
					</button>
				</div>
				{error !== "" && <p className="mx-error">{error}</p>}
			</div>
		</section>
	);
}
