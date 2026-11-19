// What a synced chat syncs, feature by feature (Chat Bridge, ADR 0023): read-only since
// the one switch (ADR 0024), each feature follows its chat. The info panel reads it to
// know which actions on people and groups the app can do.

export type FeatureDirection = "off" | "in" | "out" | "both";
/** r1: the owner's own state; r2: what other people see; r3: acts on people and groups; re: ephemeral. */
export type FeatureRisk = "r1" | "r2" | "r3" | "re";

export interface BridgeFeatureView {
	readonly feature: string;
	readonly risk: FeatureRisk;
	readonly direction: FeatureDirection;
	/** It follows the chat (always, since ADR 0024). */
	readonly isDefault: boolean;
	readonly canReceive: boolean;
	readonly canSend: boolean;
}
