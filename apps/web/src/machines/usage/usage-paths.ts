// Where the "Hiệu quả" page of a machine lives (router.tsx parses it) and
// which repository key a project opens it on. Kept apart from the page, so
// the sidebar links to it without loading it.
import { folderName } from "../new-session-hints.ts";

/** The usage page of `machine` for repository `key` ("" for every repository). */
export function usagePath(machine: string, key: string): string {
	return key === "" ? `/ai/${machine}/usage` : `/ai/${machine}/usage/${encodeURIComponent(key)}`;
}

/** What a project row needs to open its usage: its linked repository and its workspaces' folders and machines. */
export interface UsageProject {
	/** The canonical key of the linked repository; "" for none. */
	readonly gitRemote: string;
	readonly workspaces: readonly { readonly dir: string; readonly machine: string | null; readonly online: boolean }[];
}

/**
 * The usage page of a project: on the machine of its first online workspace
 * (else its first workspace on a known machine), for its linked repository,
 * else the folder as the machine keys a repository without a remote
 * (`local:<folder>`). Null when no workspace is on a known machine.
 */
export function projectUsagePath(project: UsageProject): string | null {
	const known = project.workspaces.filter((w) => w.machine !== null);
	const pick = known.find((w) => w.online) ?? known[0];
	if (pick === undefined || pick.machine === null) return null;
	const key = project.gitRemote !== "" ? project.gitRemote : `local:${folderName(pick.dir)}`;
	return usagePath(pick.machine, key);
}
