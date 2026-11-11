// What a machine's page says about updating tunelo, from what the machine
// reports (MachineInfo.agentUpdate) and the progress it sends while it updates.
import { AgentUpdatePhase, type AgentUpdateProgress, type MachineInfo } from "@achoo254/chat-proto/remote/remote";

export type UpdateView =
	/** The machine's tunelo is from before it could update from a device. */
	| { kind: "manual" }
	/** This tunelo cannot replace its own file here (run from source, or nothing restarts it). */
	| { kind: "unsupported" }
	| { kind: "upToDate" }
	| { kind: "available"; version: string }
	| { kind: "working"; phase: "downloading" | "verifying" | "installing"; version: string; percent: number | null }
	| { kind: "restarting"; version: string }
	| { kind: "failed"; message: string };

/** The first tunelo that updates itself on a device's request. */
export const AGENT_SELF_UPDATE = [2, 3, 0] as const;

export function downloadPercent(progress: Pick<AgentUpdateProgress, "received" | "total">): number | null {
	if (progress.total <= 0n) return null;
	return Math.min(100, Number((progress.received * 100n) / progress.total));
}

export function updateView(info: MachineInfo, progress: AgentUpdateProgress | null): UpdateView {
	const update = info.agentUpdate;
	if (progress !== null) {
		const { phase, version } = progress;
		if (phase === AgentUpdatePhase.FAILED) return { kind: "failed", message: progress.message };
		// The machine restarts: until it is back on the new version this stays.
		if (phase === AgentUpdatePhase.RESTARTING && info.agentVersion !== version) return { kind: "restarting", version };
		const active = phase === AgentUpdatePhase.DOWNLOADING || phase === AgentUpdatePhase.VERIFYING || phase === AgentUpdatePhase.INSTALLING;
		// A machine that says it is not updating (the link dropped mid-way) shows what it holds instead.
		if (active && update?.updating !== false) {
			const step = phase === AgentUpdatePhase.VERIFYING ? "verifying" : phase === AgentUpdatePhase.INSTALLING ? "installing" : "downloading";
			return { kind: "working", phase: step, version, percent: step === "downloading" ? downloadPercent(progress) : null };
		}
	}
	if (update === undefined) return { kind: "manual" };
	if (update.updating) return { kind: "working", phase: "downloading", version: update.latestVersion, percent: null };
	if (!update.supported) return { kind: "unsupported" };
	if (update.latestVersion !== "") return { kind: "available", version: update.latestVersion };
	return { kind: "upToDate" };
}
