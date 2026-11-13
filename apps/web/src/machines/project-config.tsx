// A folder's project configuration on the machine (ProjectConfigSet): whether
// the chat sessions there load the folder's own .claude configuration
// (skills, commands, hooks, auto-allowed tools). Off until the user turns it
// on for the folder, from the workspace's settings or from the hint over a
// session that runs without it. A running session switches after its current
// turn. Machines before the per-folder level leave it unset (UNSPECIFIED) and
// answer UNSUPPORTED_REQUEST: the per-session tick stays their way.
import { useState } from "react";
import { ErrorReason, ProjectConfigLevel, type Project } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "./copy-vi.ts";
import { RemoteError, type MachineLink } from "./link/machine-link.ts";
import { MachineIcon } from "./machine-icons.tsx";
import { errorText } from "./use-machines.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

type ConfigLink = Pick<MachineLink, "request">;

/** Turns the folder's configuration on or off; resolves with the level the machine now applies there. */
export async function setProjectConfig(link: ConfigLink, dir: string, on: boolean): Promise<ProjectConfigLevel> {
	const frame = await link.request({ case: "projectConfigSet", value: { dir, level: on ? ProjectConfigLevel.FULL : ProjectConfigLevel.OFF } });
	return frame.body.case === "projectConfig" ? frame.body.value.level : ProjectConfigLevel.UNSPECIFIED;
}

/**
 * Whether a new or reopened session of `project` starts with its own AI
 * configuration ticked: the folder is set to load it (FULL), or the project's
 * defaults say so. The user can still untick it for one session.
 */
export function loadsProjectConfig(project: Project | undefined): boolean {
	return project?.projectConfig === ProjectConfigLevel.FULL || project?.defaults?.projectSettings === true;
}

/** The machine does not know the per-folder level (before it): the per-session tick is the way there. */
export function projectConfigUnsupported(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.UNSUPPORTED_REQUEST;
}

/** What to tell the user when the machine refused to set a folder's level. */
export function projectConfigErrorText(t: MachinesCopy, err: unknown, dir: string, ai: string): string {
	if (err instanceof RemoteError && err.reason === ErrorReason.TRUST_ON_MACHINE) return t.projectConfig.trustOnMachine(err.subject || dir);
	if (projectConfigUnsupported(err)) return t.projectConfig.unsupported;
	return errorText(t, err, ai);
}

/**
 * In a session's header while it runs without its folder's configuration
 * (OFF): a small "Nạp kỹ năng dự án" button turning the folder on in one
 * tap, saying what is missing and what it does in its tooltip.
 * Nothing for a machine that does not say (UNSPECIFIED) or a session that has
 * it (FULL).
 */
export function ProjectConfigHint({ link, level, dir, ai, online }: { link: ConfigLink; level: ProjectConfigLevel; dir: string; ai: string; online: boolean }) {
	const t = useMachinesCopy();
	const pc = t.projectConfig;
	const [state, setState] = useState<{ kind: "idle" | "busy" | "done" } | { kind: "failed"; message: string }>({ kind: "idle" });
	if (level !== ProjectConfigLevel.OFF || dir === "") return null;
	if (state.kind === "done") return <span role="status">· {pc.enabled}</span>;
	if (state.kind === "failed") {
		return (
			<span role="alert" title={state.message}>
				· {state.message}
			</span>
		);
	}
	const enable = () => {
		setState({ kind: "busy" });
		setProjectConfig(link, dir, true).then(
			() => setState({ kind: "done" }),
			(err: unknown) => setState({ kind: "failed", message: projectConfigErrorText(t, err, dir, ai) }),
		);
	};
	return (
		<span data-id="session-project-config">
			<button type="button" className="mx-pc-hint" title={`${pc.notLoaded}. ${pc.enableTitle(dir)}`} disabled={!online || state.kind === "busy"} onClick={enable} data-id="session-project-config-enable">
				<MachineIcon name="spark" small />
				{pc.enable}
			</button>
		</span>
	);
}
