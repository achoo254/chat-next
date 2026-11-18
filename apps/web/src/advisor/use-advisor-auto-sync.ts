// Automatic Advisor is one switch of the account (AdvisorProfile.auto_session)
// that each machine keeps its own copy of (AdvisorSetAuto). A device that has
// a link open to a machine brings that machine's copy in line with the
// account's: nothing is sent before the profile is the user's own (the
// defaults would switch machines off), nor to a machine that cannot take it
// (offline, MCP off, an older tunelo), nor twice in a row for the same value.
import { useEffect } from "react";
import { useAdvisorProfile, useAdvisorProfileLoaded } from "../messaging/data/services.tsx";
import type { MachineView } from "../machines/use-machines.ts";

/** A machine asked for a value is not asked again for it for this long (the answer is the machine's next info). */
const RETRY_MS = 15_000;
const asked = new Map<string, { readonly on: boolean; readonly at: number }>();

/** Whether the machine can take the switch now, and the value it holds. */
export function autoStateOf(view: MachineView): { readonly reachable: boolean; readonly auto: boolean } {
	const advisor = view.state.info?.advisor;
	return { reachable: view.state.status.kind === "open" && advisor !== undefined && advisor.available, auto: advisor?.auto ?? false };
}

export function useAdvisorAutoSync(views: readonly MachineView[]): void {
	const loaded = useAdvisorProfileLoaded();
	const wanted = useAdvisorProfile().autoSession;
	useEffect(() => {
		if (!loaded) return;
		const now = Date.now();
		for (const view of views) {
			const { reachable, auto } = autoStateOf(view);
			if (!reachable || auto === wanted) continue;
			const before = asked.get(view.entry.ref);
			if (before !== undefined && before.on === wanted && now - before.at < RETRY_MS) continue;
			asked.set(view.entry.ref, { on: wanted, at: now });
			view.link.request({ case: "advisorSetAuto", value: { on: wanted } }).catch(() => undefined);
		}
	}, [loaded, wanted, views]);
}
