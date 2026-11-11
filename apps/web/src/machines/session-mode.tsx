// How a session opens: the chat view, or its AI's own CLI in the machine's
// terminal (for those who prefer the CLI). The terminal is offered only when
// the machine has its terminal and the session's AI opens there
// (ProviderCapabilities.terminal). The last mode used on a machine is
// remembered on this device and picks where its sessions open next. While
// the CLI holds a session, the chat view shows it read-only and points to
// the terminal: no two views write to one session.
import { useState } from "react";
import type { MachineInfo, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { navigate, paths } from "../router.tsx";
import { aiPaths } from "./ai-paths.ts";
import { terminalGate } from "./agent-version.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { errorText, providerOf } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

export type SessionMode = "chat" | "terminal";

const MODE_KEY = (machine: string) => `ai:mode:${machine}`;

/** The session's AI opens in the machine's terminal. */
export function terminalOffered(info: MachineInfo | null, provider: string): boolean {
	return terminalGate(info) === "available" && providerOf(info, provider)?.capabilities?.terminal === true;
}

/** The mode last used on the machine (chat when none, or when storage is refused). */
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

export function modePath(machine: string, threadId: string, mode: SessionMode): string {
	return mode === "terminal" ? aiPaths.sessionTerminal(machine, threadId) : paths.machineSession(machine, threadId);
}

/** Where a session opens from a list: in the mode last used on the machine, when that mode is offered. */
export function sessionPath(machine: string, threadId: string, offered: boolean): string {
	return modePath(machine, threadId, offered ? lastMode(machine) : "chat");
}

/** "Chat | Terminal" in the session header. */
export function ModeSwitch({ machine, threadId, mode }: { machine: string; threadId: string; mode: SessionMode }) {
	const t = useMachinesCopy();
	const pick = (next: SessionMode) => {
		rememberMode(machine, next);
		navigate(modePath(machine, threadId, next));
	};
	return (
		<div className="mx-mode" role="group" aria-label={t.terminal.mode.label}>
			{(["chat", "terminal"] as const).map((m) => (
				<button key={m} type="button" aria-pressed={mode === m} onClick={() => pick(m)} data-id={`session-mode-${m}`}>
					{t.terminal.mode[m]}
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
		link.request({ case: "termClose", value: { session: thread.terminalSession } }).then(
			() => setBusy(false),
			(err: unknown) => {
				setBusy(false);
				setError(errorText(t, err, ai));
			},
		);
	};
	return (
		<section className="mx-limit" role="status" data-id="session-terminal-held">
			<div className="mx-limit-inner">
				<MachineIcon name="terminal" />
				<p>{t.terminal.held(ai)}</p>
				<button
					type="button"
					className="btn btn-sm btn-primary"
					onClick={() => {
						rememberMode(machine, "terminal");
						navigate(aiPaths.sessionTerminal(machine, thread.id));
					}}
				>
					{t.terminal.showTerminal}
				</button>
				<button type="button" className="btn btn-sm" disabled={busy} onClick={end} title={t.terminal.endHint}>
					{t.terminal.end}
				</button>
				{error !== "" && <p className="mx-error">{error}</p>}
			</div>
		</section>
	);
}
