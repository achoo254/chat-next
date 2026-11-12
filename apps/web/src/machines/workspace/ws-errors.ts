// What to tell the user about a refused workspace request: as the AI Agent
// screens word every reason (machine-errors.ts, the panel's git and secret
// file reasons included), but for the two the panel words for a workspace.
import { ErrorReason } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../copy-vi.ts";
import { RemoteError } from "../link/machine-link.ts";
import { machineErrorText } from "../machine-errors.ts";
import type { PanelCopy } from "./panel-copy-vi.ts";

/**
 * The panel's own sentence where the shared one fits the session view, not a
 * workspace: an outside path, and an older machine (it needs tunelo 2.7.0).
 */
function panelReason(p: PanelCopy["errors"], err: RemoteError): string | undefined {
	switch (err.reason) {
		case ErrorReason.PATH_OUTSIDE_FOLDER:
			return p.pathOutside;
		case ErrorReason.UNSUPPORTED_REQUEST:
			return p.needsUpdate;
		default:
			return undefined;
	}
}

/** The sentence for a failed workspace request. */
export function wsErrorText(p: PanelCopy, t: MachinesCopy, err: unknown, ai: string): string {
	if (err instanceof RemoteError) {
		const own = panelReason(p.errors, err);
		if (own !== undefined) return own;
	}
	return machineErrorText(t, err, ai);
}

/** The machine refused because the request names a secret file it did not get consent for: the paths it lists. */
export function unconfirmedSensitive(err: unknown): string[] | null {
	if (!(err instanceof RemoteError) || err.reason !== ErrorReason.SENSITIVE_FILE_NOT_CONFIRMED) return null;
	return err.subject.split("\n").filter((line) => line !== "");
}

/** The machine refused a commit on a detached HEAD without consent. */
export function isDetachedRefusal(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.GIT_DETACHED_HEAD;
}

/** The machine is too old for the panel (it does not know Ws* requests). */
export function needsAgentUpdate(err: unknown): boolean {
	return err instanceof RemoteError && err.reason === ErrorReason.UNSUPPORTED_REQUEST;
}
