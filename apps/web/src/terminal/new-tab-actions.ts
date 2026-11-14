// What the dock's "+" menu offers, as data (after Orca's new-tab menu): a
// new shell, a new session of each AI tunelo knows, and the machine's
// sessions no pane shows. Each entry carries its own label, hint, icon,
// disabled state and action, so the menu only renders groups of rows, and a
// future kind of tab (a browser, a markdown preview…) is one more entry here.
// No React: the menu, the dock and the tests all build from these functions.
import { fold } from "@achoo254/chat-core";
import { LoginState, type MachineInfo, type TermSessionInfo } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../machines/copy-vi.ts";
import type { MachineIconName } from "../machines/machine-icons.tsx";
import { folderName } from "../machines/new-session-hints.ts";
import { terminalOffered } from "../machines/session-mode.tsx";
import { providerOf } from "../machines/use-machines.ts";

type TerminalCopy = MachinesCopy["terminal"];

export type NewTabGroup = "terminal" | "agent" | "session";

/** The menu's groups, top to bottom, each under its heading. A group with no entry is left out. */
export const NEW_TAB_GROUPS: readonly { readonly id: NewTabGroup; heading(t: TerminalCopy): string }[] = [
	{ id: "terminal", heading: (t) => t.groupTerminal },
	{ id: "agent", heading: (t) => t.groupAgent },
	{ id: "session", heading: (t) => t.sessionsOnMachine },
];

export interface NewTabAction {
	/** Unique in the menu (a React key and a test hook). */
	readonly id: string;
	readonly group: NewTabGroup;
	readonly label: string;
	/** The muted second line: a session's folder and state, or why an AI cannot start here. */
	readonly hint?: string;
	/** The tooltip (a session's full folder). */
	readonly title?: string;
	/** The keyboard shortcut shown at the right. */
	readonly shortcut?: string;
	readonly icon: MachineIconName;
	readonly disabled?: boolean;
	/** More text the search matches besides the label and the hint (a session's full folder). */
	readonly keywords?: string;
	run(): void;
}

/** An AI tunelo can run, by its provider id on the machine (apps/agent/src/providers). */
export interface KnownAi {
	readonly id: string;
	readonly name: string;
	readonly icon: MachineIconName;
}

export const KNOWN_AIS: readonly KnownAi[] = [
	{ id: "claude", name: "Claude Code", icon: "run-claude" },
	{ id: "antigravity", name: "Antigravity", icon: "run-antigravity" },
];

/** Whether a new session of the AI can open in the terminal: the machine has it, signed in, and its CLI opens there. */
export type AgentAvailability = "ready" | "not-installed" | "needs-login" | "not-in-terminal";

export interface AgentChoice extends KnownAi {
	readonly availability: AgentAvailability;
}

/**
 * Every known AI against what the machine reports (none reported yet: all "not installed"). The machine
 * lists signed-out AIs too: those are not ready, as a new session picks only a signed-in one (sessionProvider).
 */
export function agentChoices(info: MachineInfo | null): AgentChoice[] {
	return KNOWN_AIS.map((ai) => {
		const reported = providerOf(info, ai.id);
		const availability: AgentAvailability =
			reported === null ? "not-installed" : reported.loginState === LoginState.NEEDS_LOGIN ? "needs-login" : terminalOffered(info, ai.id) ? "ready" : "not-in-terminal";
		// The machine's own name for it wins (it may say "Claude Code (beta)"), the static one otherwise.
		return { ...ai, name: reported?.name || ai.name, availability };
	});
}

/** "21:05" today, else "12/11 21:05": when a session on the machine was opened. */
export function openedTime(ms: number, now: number): string {
	const at = new Date(ms);
	const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return at.toDateString() === new Date(now).toDateString() ? time : `${at.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" })} ${time}`;
}

export interface NewTabInput {
	readonly t: TerminalCopy;
	/** The shortcut prefix as the platform writes it ("⌥⇧" or "Alt+Shift+"). */
	readonly prefix: string;
	/** A terminal is opening, or the machine is offline: nothing new starts and nothing reopens. */
	readonly busy: boolean;
	/** A new AI session is being started from the menu: no second one meanwhile. */
	readonly startingAgent: boolean;
	/**
	 * The dock has no folder of its own (the machine's dock): an AI would start in the home folder, which the
	 * machine refuses without a consent this menu has no dialog for. Its AIs start from a project instead.
	 */
	readonly noFolder: boolean;
	readonly agents: readonly AgentChoice[];
	/** The machine's sessions no pane shows. */
	readonly hidden: readonly TermSessionInfo[];
	/** "Today" for the sessions' opened times: the moment the menu opened. */
	readonly now: number;
	onNewTab(): void;
	onStartAgent(provider: string): void;
	onReopen(session: number): void;
}

function sessionHint(t: TerminalCopy, s: TermSessionInfo, now: number): string {
	return [
		s.cwd === "" ? "" : folderName(s.cwd),
		s.createdAt > 0n ? t.openedAt(openedTime(Number(s.createdAt), now)) : "",
		s.exited ? t.exitedShort(s.exitCode) : s.attached ? t.openElsewhere : t.running,
	]
		.filter((x) => x !== "")
		.join(" · ");
}

/** Why the AI's row is greyed out; none when it can start. */
function agentHint(t: TerminalCopy, ai: AgentChoice, noFolder: boolean): string | undefined {
	switch (ai.availability) {
		case "not-installed":
			return t.notInstalled;
		case "needs-login":
			return t.needsLogin;
		case "not-in-terminal":
			return t.notInTerminal;
		case "ready":
			return noFolder ? t.agentNeedsProject : undefined;
	}
}

export function buildNewTabActions(input: NewTabInput): NewTabAction[] {
	const { t, prefix, busy, agents, hidden, now } = input;
	const terminal: NewTabAction = { id: "new-terminal", group: "terminal", label: t.newTab, shortcut: `${prefix}T`, icon: "terminal", disabled: busy, run: input.onNewTab };
	const agentRows = agents.map((ai): NewTabAction => {
		const hint = agentHint(t, ai, input.noFolder);
		return {
			id: `agent:${ai.id}`,
			group: "agent",
			label: ai.name,
			icon: ai.icon,
			disabled: busy || input.startingAgent || hint !== undefined,
			...(hint === undefined ? {} : { hint }),
			run: () => input.onStartAgent(ai.id),
		};
	});
	const sessionRows = hidden.map(
		(s): NewTabAction => ({
			id: `session:${s.session}`,
			group: "session",
			label: s.title || (s.threadId === "" ? t.shellSession : t.aiSession),
			hint: sessionHint(t, s, now),
			...(s.cwd === "" ? {} : { title: s.cwd, keywords: s.cwd }),
			icon: s.threadId === "" ? "terminal" : "ai-session",
			// Offline, or a terminal opening: a reopened tab would only fail to attach.
			disabled: busy,
			run: () => input.onReopen(s.session),
		}),
	);
	return [terminal, ...agentRows, ...sessionRows];
}

/** The entries whose label, hint or keywords hold every word of `query` (case and Vietnamese accents aside). */
export function filterNewTabActions(actions: readonly NewTabAction[], query: string): readonly NewTabAction[] {
	const words = fold(query).split(" ").filter((w) => w !== "");
	if (words.length === 0) return actions;
	return actions.filter((a) => {
		const text = fold([a.label, a.hint ?? "", a.keywords ?? ""].join(" "));
		return words.every((w) => text.includes(w));
	});
}

/** The entries of each group in the menu's order, groups with none left out. */
export function groupNewTabActions(actions: readonly NewTabAction[]): { readonly id: NewTabGroup; readonly actions: readonly NewTabAction[] }[] {
	return NEW_TAB_GROUPS.map((g) => ({ id: g.id, actions: actions.filter((a) => a.group === g.id) })).filter((g) => g.actions.length > 0);
}
