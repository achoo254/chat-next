// The account's TypeSafe key follows the user to every machine this device
// links to: a machine without a key (and without its own) or with an older
// account key gets the newest one handed on by a machine that holds it
// (advisor-account-key.ts), and a machine holding an account key set no later
// than its removal (AdvisorProfile.key_removed_at) has it removed. Nothing
// runs before the profile is the user's own (the default removal time 0 would
// let a removed key spread), and nothing is asked twice in a row.
import { useEffect } from "react";
import { AdvisorKeySource } from "@achoo254/chat-proto/remote/remote";
import { useAdvisorProfile, useAdvisorProfileLoaded, useServices } from "../messaging/data/services.tsx";
import type { MachineLink } from "../machines/link/machine-link.ts";
import type { MachineView } from "../machines/use-machines.ts";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import { handOffAccountKey, planKeySync } from "./advisor-account-key.ts";

/** The same request to the same machine waits this long before it is asked again (its answer is the machine's next info). */
const RETRY_MS = 15_000;
/** Requests asked lately on each link, by the key they were about. A new link starts with none. */
const asked = new WeakMap<MachineLink, Map<string, number>>();

/** Asks once per RETRY_MS for the same thing on a link; true when it is asked now. */
function askOnce(link: MachineLink, what: string, now: number): boolean {
	let mine = asked.get(link);
	if (mine === undefined) {
		mine = new Map();
		asked.set(link, mine);
	}
	const before = mine.get(what);
	if (before !== undefined && now - before < RETRY_MS) return false;
	mine.set(what, now);
	return true;
}

export function useAdvisorKeySync(views: readonly MachineView[]): void {
	const loaded = useAdvisorProfileLoaded();
	const removedAt = useAdvisorProfile().keyRemovedAt;
	const { toasts } = useServices();
	const t = useMachinesCopy();
	useEffect(() => {
		if (!loaded) return;
		const now = Date.now();
		const plan = planKeySync(views, removedAt);
		for (const { view, key } of plan.stale) {
			if (!askOnce(view.link, `remove:${key.fingerprint}:${key.setAt}`, now)) continue;
			view.link.request({ case: "advisorRemoveKey", value: { source: AdvisorKeySource.ACCOUNT } }).catch(() => undefined);
		}
		const source = plan.source;
		if (source === null) return;
		for (const { view } of plan.targets) {
			if (!askOnce(view.link, `share:${source.key.fingerprint}:${source.key.setAt}`, now)) continue;
			handOffAccountKey(source.view, view).then(
				() => toasts.show(t.advisorKeySynced(view.entry.name)),
				// Asked again after RETRY_MS while the machine still needs it.
				() => undefined,
			);
		}
	}, [loaded, removedAt, views, toasts, t]);
}
