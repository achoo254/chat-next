// The machine's Claude profiles as every AI Agent screen shows them. A
// machine on tunelo 2.0.2+ announces them whole (MachineProfile) whenever
// anything changes, from any device or its own terminal, so the status bar,
// the account menu and the machine's page follow without asking. An older
// machine never does: then the list is asked once (ProfileList) and kept
// from the answers of the requests made here.
import { useCallback, useEffect, useState } from "react";
import type { ClaudeProfile, Frame, MachineProfile, ProfileListResult, ThreadInfo } from "@achoo254/chat-proto/remote/remote";
import type { MachineLink } from "./link/machine-link.ts";

type FrameBody = Parameters<MachineLink["request"]>[0];

export function listOf(frame: Frame): ProfileListResult | null {
	return frame.body.case === "profileListResult" ? frame.body.value : null;
}

export interface Profiles {
	/** The profiles and the machine's pick; null until known. */
	readonly list: ProfileListResult | null;
	/** Sends a profile request; its answer (a ProfileListResult) replaces the list until the machine announces the next. */
	readonly request: (body: FrameBody) => Promise<void>;
	/** Asks the list again (a machine that does not announce it). */
	readonly reload: () => void;
}

export function useProfiles(link: MachineLink, announced: MachineProfile | null, online: boolean): Profiles {
	const [asked, setAsked] = useState<ProfileListResult | null>(null);
	const [round, setRound] = useState(0);
	useEffect(() => {
		// A machine that announces its profiles needs no question.
		if (!online || announced !== null) return;
		let live = true;
		link.request({ case: "profileList", value: {} }).then(
			(frame) => {
				const next = listOf(frame);
				if (live && next !== null) setAsked(next);
			},
			// Unknown on this machine (no Claude, or offline meanwhile): nothing to show.
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [link, online, announced, round]);
	const request = useCallback(
		async (body: FrameBody) => {
			const next = listOf(await link.request(body));
			if (next !== null) setAsked(next);
		},
		[link],
	);
	const reload = useCallback(() => setRound((n) => n + 1), []);
	return { list: announced?.profiles ?? asked, request, reload };
}

/** The profile `id` ("" for the default one) in `list`. */
export function profileById(list: ProfileListResult | null, id: string): ClaudeProfile | undefined {
	return list?.profiles.find((p) => p.id === id);
}

/** The profile a session runs with: as the machine announced it, else as the session reported it, else the machine's pick. */
export function sessionProfileId(announced: MachineProfile | null, threadId: string, info: ThreadInfo | undefined, list: ProfileListResult | null): string {
	const session = announced?.sessions.find((s) => s.threadId === threadId);
	if (session !== undefined) return session.profileId;
	if (info !== undefined && (info.profileId !== "" || info.account !== undefined)) return info.profileId;
	return list?.selectedId ?? "";
}

/** The session moves to the machine's profile once its turn ends. */
export function switchPending(announced: MachineProfile | null, threadId: string, info: ThreadInfo | undefined): boolean {
	return announced?.sessions.find((s) => s.threadId === threadId)?.switchPending ?? info?.profileSwitchPending ?? false;
}

/** A profile can be picked for the machine: an added one must still be signed in. */
export function usable(profile: ClaudeProfile): boolean {
	return profile.id === "" || profile.signedIn;
}
