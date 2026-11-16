// Who Advisor is to this user: the name from their profile (the default
// name of the UI language when they left it empty), its look and its tone.
// The mascot and the session's verdict cards read it alike.
import type { AdvisorTone } from "@achoo254/chat-core";
import { useAdvisorProfile } from "../messaging/data/services.tsx";
import { lookOf, type Look } from "./looks.ts";
import { useAdvisorCopy } from "./use-advisor-copy.ts";

export interface AdvisorIdentity {
	readonly name: string;
	readonly look: Look;
	readonly tone: AdvisorTone;
}

export function useAdvisorIdentity(): AdvisorIdentity {
	const t = useAdvisorCopy();
	const profile = useAdvisorProfile();
	const name = profile.name.trim() === "" ? t.defaultName : profile.name;
	return { name, look: lookOf(profile.lookId), tone: profile.tone };
}
