// A machine's sessions by project (tunelo 2.0.7+): each project in the
// machine's order (pinned first) with the sessions in its folder or below
// it; sessions in no project go to "Khác", grouped by folder as before.
import type { Project, ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { AGENT_PROJECTS, versionAtLeast } from "./agent-version.ts";
import { sortForList } from "./link/machine-link.ts";

export function projectsSupported(agentVersion: string | undefined): boolean {
	return versionAtLeast(agentVersion ?? "", AGENT_PROJECTS);
}

const windowsPath = (p: string) => /^[A-Za-z]:/.test(p) || p.includes("\\");

function norm(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, "");
	return windowsPath(p) ? trimmed.toLowerCase().replace(/\//g, "\\") : trimmed;
}

/** `dir` is `parent` or inside it. */
export function inFolder(dir: string, parent: string): boolean {
	const d = norm(dir);
	const p = norm(parent);
	if (p === "") return false;
	const sep = windowsPath(parent) ? "\\" : "/";
	return d === p || d.startsWith(p + sep);
}

export interface ProjectGroup {
	readonly project: Project;
	readonly threads: ThreadSummary[];
}

/** Sessions by project (the deepest project holding the folder), and the rest. */
export function byProject(threads: readonly ThreadSummary[], projects: readonly Project[]): { groups: ProjectGroup[]; other: ThreadSummary[] } {
	const groups = projects.map((project) => ({ project, threads: [] as ThreadSummary[] }));
	const other: ThreadSummary[] = [];
	for (const thread of sortForList(threads)) {
		const holders = groups.filter((g) => inFolder(thread.dir, g.project.dir));
		const deepest = holders.sort((a, b) => b.project.dir.length - a.project.dir.length)[0];
		if (deepest === undefined) other.push(thread);
		else deepest.threads.push(thread);
	}
	return { groups, other };
}

/** A project's second line: branch, changed files, ahead/behind. */
export function gitLine(project: Project, changed: (n: number) => string): string {
	const git = project.git;
	if (git === undefined || !git.git) return "";
	const parts = [git.branch];
	if (git.changed > 0) parts.push(changed(git.changed));
	if (git.ahead > 0 || git.behind > 0) parts.push(`↑${git.ahead} ↓${git.behind}`);
	return parts.filter((p) => p !== "").join(" · ");
}
