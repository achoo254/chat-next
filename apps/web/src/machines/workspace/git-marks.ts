// How a git state shows in the Explorer and in Source Control: the one
// letter Orca and VS Code use (U, A, M, D, R, C, T), a tone the stylesheet
// colours (workspace.css .ws-git-*), and its spoken name.
import { GitFileState } from "@achoo254/chat-proto/remote/remote";
import type { PanelCopy } from "./panel-copy-vi.ts";

export type GitTone = "untracked" | "added" | "modified" | "deleted" | "renamed" | "conflicted";

export interface GitMark {
	readonly letter: string;
	readonly tone: GitTone;
	readonly label: string;
}

/** The mark of a state; null for UNSPECIFIED (unchanged or outside git). */
export function gitMark(state: GitFileState, labels: PanelCopy["explorer"]["git"]): GitMark | null {
	switch (state) {
		case GitFileState.UNTRACKED:
			return { letter: "U", tone: "untracked", label: labels.untracked };
		case GitFileState.ADDED:
			return { letter: "A", tone: "added", label: labels.added };
		case GitFileState.MODIFIED:
			return { letter: "M", tone: "modified", label: labels.modified };
		case GitFileState.DELETED:
			return { letter: "D", tone: "deleted", label: labels.deleted };
		case GitFileState.RENAMED:
			return { letter: "R", tone: "renamed", label: labels.renamed };
		case GitFileState.CONFLICTED:
			return { letter: "C", tone: "conflicted", label: labels.conflicted };
		case GitFileState.TYPE_CHANGED:
			return { letter: "T", tone: "modified", label: labels.typeChanged };
		default:
			return null;
	}
}
