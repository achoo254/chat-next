// The one mark of a work state, shared by every place that shows one: the AI
// Agent column (session, workspace, project and loose-folder rows) and the AI's
// tab in the terminal. All of them read the state from the sessions the machine
// reports (project-tree.ts threadStatus, statusOf, runningAi), never from what a program
// prints, so they agree with each other and with what the AI really does.
import { MachineIcon, type MachineIconName } from "./machine-icons.tsx";
import type { WorkStatus } from "./project-tree.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/**
 * A row's own icon (folder, branch, the AI's spark), or its state in its place
 * while it has one to show: the AI's own loading mark (`ai`: its id) or a
 * spinner, check, alert or cross; dimmed while offline. One column carries
 * both, so a calm list wastes no space on an empty status column. `who` (the
 * AI's name on a session) leads the label.
 */
export function StatusGlyph({ status, icon, who, ai, offline = false, detail }: { status: WorkStatus; icon: MachineIconName; who?: string; ai?: string | undefined; offline?: boolean; detail?: string }) {
	const t = useMachinesCopy();
	const p = t.agent.projects;
	const state = offline ? p.offlineStatus(detail ?? p.status[status]) : (detail ?? p.status[status]);
	const label = who === undefined ? state : `${who} · ${state}`;
	const run = status === "running" ? runGlyph(ai) : undefined;
	return (
		<span className={`mx-glyph ${status}`} data-ai={run?.ai} data-offline={offline ? "" : undefined} role="img" aria-label={label} title={label}>
			<MachineIcon name={run?.icon ?? GLYPHS[status] ?? icon} small />
		</span>
	);
}

/** Each AI's own loading mark, by its id; machines.css gives each its motion. */
const RUN_GLYPHS: Record<string, MachineIconName> = { claude: "run-claude", antigravity: "run-antigravity", codex: "run-codex" };

/** What a running row shows: the AI's own mark (and its id, for the motion), or the plain spinner for an AI without one or for a set run by several AIs. */
export function runGlyph(ai: string | undefined): { icon: MachineIconName; ai: string | undefined } {
	const icon = ai === undefined ? undefined : RUN_GLYPHS[ai];
	return icon === undefined ? { icon: "spinner", ai: undefined } : { icon, ai };
}

// Held by a terminal is calm, not work: the row keeps its own icon, as idle does, since its second line already shows the terminal icon.
const GLYPHS: Partial<Record<WorkStatus, MachineIconName>> = { need: "alert-circle", failed: "x-circle", running: "spinner", done: "check-circle" };

/**
 * A terminal program's title without the state mark an AI puts in front of it
 * (Claude Code: "✳ Claude Code" idle, a braille spinner "⠐ …" or "✻ …" while
 * it works): the tab shows the state with StatusGlyph, from the session, so the
 * program's own mark would only say it twice, and not always in step.
 */
export function aiTabTitle(title: string): string {
	// Only the frames Claude Code draws (braille spinner U+2800–U+28FF, · ✢ ✳ ✶ ✻ ✽), followed by a space: "✨ Ý mới" or "*nháp*" stay as they are.
	return title.replace(/^[⠀-⣿·✢✳✶✻✽]+\s+/u, "").trim();
}
