// Paths of a machine's folders, compared the way the machine names them:
// case-insensitive with either slash on Windows, exact elsewhere, a trailing
// separator ignored. A session belongs to the folder holding its working
// directory (the folder itself or one inside it).
import { AGENT_PROJECTS, versionAtLeast } from "./agent-version.ts";

/** The machine keeps folders as projects (tunelo 2.0.7+). */
export function projectsSupported(agentVersion: string | undefined): boolean {
	return versionAtLeast(agentVersion ?? "", AGENT_PROJECTS);
}

const windowsPath = (p: string) => /^[A-Za-z]:/.test(p) || p.includes("\\");

function norm(p: string): string {
	const trimmed = p.replace(/[\\/]+$/, "");
	return windowsPath(p) ? trimmed.toLowerCase().replace(/\//g, "\\") : trimmed;
}

/** The same folder. */
export function samePath(a: string, b: string): boolean {
	const x = norm(a);
	return x !== "" && x === norm(b);
}

/** `dir` is `parent` or inside it. */
export function inFolder(dir: string, parent: string): boolean {
	const d = norm(dir);
	const p = norm(parent);
	if (p === "") return false;
	const sep = windowsPath(parent) ? "\\" : "/";
	return d === p || d.startsWith(p + sep);
}
