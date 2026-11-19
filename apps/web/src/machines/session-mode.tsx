// How a session opens: the chat view, its AI's own CLI in the machine's
// terminal (for those who prefer the CLI), or its office (the AI and its
// subagents at work in a small building, view only). The terminal is offered
// only when the machine has its terminal and the session's AI opens there
// (ProviderCapabilities.terminal); the office when the machine's tunelo keeps
// one (AGENT_OFFICE). Each session remembers the mode it was last opened in
// on this device, and opens in it again from a list: its row's icon says that
// one (or a live hold). The view last picked on the switch is kept on this
// device too, and only a session never opened here opens in it (one that does
// not offer it opens as before). The machine keeps only the pick of the
// new-session dialog. While
// the CLI holds a session, the chat view shows it read-only and points to
// the terminal: no two views write to one session.
import { useState, type ReactElement } from "react";
import type { MachineInfo, ProjectDefaults, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
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

/** Chat may write to a session of this AI that a terminal holds (tunelo takes it back on the first message). */
export function chatTakesTerminal(info: MachineInfo | null, provider: string): boolean {
	return providerOf(info, provider)?.capabilities?.chatTakesTerminal === true;
}

/** The machine's tunelo keeps the office of a session. */
export function officeOffered(info: Pick<MachineInfo, "agentVersion"> | null): boolean {
	return info !== null && versionAtLeast(info.agentVersion, AGENT_OFFICE);
}

/**
 * The views a session offers, in the order the switch shows them. An office
 * open now stays among them (remembered, on a machine that went offline or
 * back to an older tunelo), so there is always a way back to chat; a terminal
 * not offered says so on its own page.
 */
export function sessionModes(terminal: boolean, office: boolean, current: SessionMode = "chat"): SessionMode[] {
	return (["chat", "terminal", "office"] as const).filter((m) => m === "chat" || (m === "terminal" ? terminal : office || current === "office"));
}

/** The mode new sessions on the machine open in, as last picked when starting one (chat when none, or when storage is refused). */
export function lastMode(machine: string): SessionMode {
	try {
		return window.localStorage.getItem(MODE_KEY(machine)) === "terminal" ? "terminal" : "chat";
	} catch {
		return "chat";
	}
}

/** The mode new sessions of a project open in: the project's own pick (a terminal only where `terminalOffered`), else the last one on the machine. */
export function projectMode(defaults: Pick<ProjectDefaults, "sessionMode"> | undefined, machine: string): SessionMode {
	const own = defaults?.sessionMode;
	return own === "chat" || own === "terminal" ? own : lastMode(machine);
}

export function rememberMode(machine: string, mode: SessionMode): void {
	try {
		window.localStorage.setItem(MODE_KEY(machine), mode);
	} catch {
		// Private mode: the choice holds for this page only.
	}
}

/** The view last picked on a session's switch, on this device, for every session and machine. */
const PICKED_MODE_KEY = "ai:mode:picked";

/** The pick as last read or written (undefined: not read yet, or another tab changed it); storage is read once, not per render. */
let pickedCache: { readonly mode: SessionMode | null } | undefined;
let pickedWatched = false;

function readPicked(): SessionMode | null {
	try {
		const kept = window.localStorage.getItem(PICKED_MODE_KEY);
		return kept === "chat" || kept === "terminal" || kept === "office" ? kept : null;
	} catch {
		return null;
	}
}

/** The view last picked on a session's switch; null when none, or when storage is refused. */
export function pickedMode(): SessionMode | null {
	if (!pickedWatched && typeof window !== "undefined") {
		pickedWatched = true;
		// Another tab picked (or storage was cleared): read again next time.
		window.addEventListener("storage", (e) => {
			if (e.key === null || e.key === PICKED_MODE_KEY) pickedCache = undefined;
		});
	}
	pickedCache ??= { mode: readPicked() };
	return pickedCache.mode;
}

export function rememberPickedMode(mode: SessionMode): void {
	pickedCache = { mode };
	try {
		window.localStorage.setItem(PICKED_MODE_KEY, mode);
	} catch {
		// Storage refused: the pick holds for this page only.
	}
}

const SESSION_MODE_KEY = (machine: string, threadId: string) => `ai:mode:${machine}:${threadId}`;

/** The mode kept for the session on this device; null when it was never opened here, or for a value this app does not know. */
function keptMode(machine: string, threadId: string): SessionMode | null {
	try {
		const kept = window.localStorage.getItem(SESSION_MODE_KEY(machine, threadId));
		return kept === "chat" || kept === "terminal" || kept === "office" ? kept : null;
	} catch {
		return null;
	}
}

/** The mode the session was last opened in on this device; chat when never, or for a value this app does not know (another session's choice never applies). */
export function sessionModeOf(machine: string, threadId: string): SessionMode {
	return keptMode(machine, threadId) ?? "chat";
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
 * opened in. A terminal hold yields to the chat the session was left in when
 * `takesBack` (chat can write to it: its first message takes the session back).
 */
export function rowMode(machine: string, thread: Pick<ThreadSummary, "id" | "terminalSession" | "open">, takesBack = false): SessionMode {
	if (thread.terminalSession > 0) return takesBack && keptMode(machine, thread.id) === "chat" ? "chat" : "terminal";
	if (thread.open) return "chat";
	return sessionModeOf(machine, thread.id);
}

export function modePath(machine: string, threadId: string, mode: SessionMode): string {
	if (mode === "terminal") return aiPaths.sessionTerminal(machine, threadId);
	return mode === "office" ? aiPaths.sessionOffice(machine, threadId) : paths.machineSession(machine, threadId);
}

/** Switch this session to `mode`: it and the device remember the choice (a session never opened here opens in it too). */
export function openSessionIn(machine: string, threadId: string, mode: SessionMode): void {
	rememberSessionMode(machine, threadId, mode);
	rememberPickedMode(mode);
	navigate(modePath(machine, threadId, mode));
}

/**
 * Where a session opens from a list: the view its row names (a live hold,
 * else the mode it was last opened in on this device), the terminal only when
 * offered. Only a session never opened here, and not held, takes the view last
 * picked on a switch when it offers it (the terminal when `offered`, the
 * office when the machine keeps one, `office`): a pick on one session never
 * moves another the user left in its own view. An office it was left in opens
 * there (only a machine that keeps offices let it be picked; an older one says
 * to update). A session a terminal holds opens in the chat it was left in when
 * `takesBack`.
 */
export function sessionPath(machine: string, thread: Pick<ThreadSummary, "id" | "terminalSession" | "open">, offered: boolean, office = true, takesBack = false): string {
	const picked = thread.terminalSession > 0 || keptMode(machine, thread.id) !== null ? null : pickedMode();
	const usable = picked === "chat" || (picked === "terminal" && offered) || (picked === "office" && office);
	const mode = usable && picked !== null ? picked : rowMode(machine, thread, takesBack);
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

/**
 * Above the composer while the session's AI runs in the terminal: the
 * terminal, or ending it there. With `takesBack` (the machine lets chat take
 * the session back) it only says that sending here moves the session to chat,
 * or that a turn runs there first; the composer stays open.
 */
export function TerminalHeldBar({ machine, link, thread, ai, takesBack = false }: { machine: string; link: MachineLink; thread: ThreadSummary; ai: string; takesBack?: boolean }) {
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
	const running = isRunning(thread);
	const text = takesBack ? (running ? t.terminal.heldBusy(ai) : t.terminal.takesBack(ai)) : running ? t.terminal.held(ai) : t.terminal.heldOpen(ai);
	return (
		<section className="mx-limit mx-held" role="status" data-id="session-terminal-held" data-takes-back={takesBack ? "" : undefined}>
			<div className="mx-limit-inner">
				<MachineIcon name="terminal" />
				<p>{text}</p>
				<div className="mx-limit-acts">
					{!takesBack && (
						<button type="button" className="btn btn-sm mx-btn-ghost" disabled={busy} onClick={end} title={t.terminal.endHint}>
							{t.terminal.end}
						</button>
					)}
					<button type="button" className={takesBack ? "btn btn-sm mx-btn-ghost" : "btn btn-sm btn-primary"} onClick={() => openSessionIn(machine, thread.id, "terminal")}>
						{t.terminal.showTerminal}
					</button>
				</div>
				{error !== "" && <p className="mx-error">{error}</p>}
			</div>
		</section>
	);
}
