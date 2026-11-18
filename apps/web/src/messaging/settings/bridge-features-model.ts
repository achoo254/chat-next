// What a synced chat can sync, feature by feature (Chat Bridge, ADR 0023): the
// types the settings panel shows and the quick levels. No React, so it is tested
// on its own; the server decides what an app supports, this only reads it.

export type FeatureDirection = "off" | "in" | "out" | "both";
/** r1: the owner's own state; r2: what other people see; r3: acts on people and groups; re: ephemeral. */
export type FeatureRisk = "r1" | "r2" | "r3" | "re";

export interface BridgeFeatureView {
	readonly feature: string;
	readonly risk: FeatureRisk;
	readonly direction: FeatureDirection;
	/** The owner never set it: it follows the messages of the chat. */
	readonly isDefault: boolean;
	readonly canReceive: boolean;
	readonly canSend: boolean;
}

export type FeatureLevel = "readonly" | "personal" | "full";
export const FEATURE_LEVELS: readonly FeatureLevel[] = ["readonly", "personal", "full"];

const ORDER: readonly FeatureDirection[] = ["off", "in", "out", "both"];

/** The directions the app can do for a feature, in display order. */
export function allowedDirections(f: Pick<BridgeFeatureView, "canReceive" | "canSend">): readonly FeatureDirection[] {
	return ORDER.filter((d) => d === "off" || (d === "in" && f.canReceive) || (d === "out" && f.canSend) || (d === "both" && f.canReceive && f.canSend));
}

/** The nearest direction the app can do at or below `wanted`: both, else in, else off (out only when asked for). */
function clip(f: BridgeFeatureView, wanted: FeatureDirection): FeatureDirection {
	const allowed = allowedDirections(f);
	if (allowed.includes(wanted)) return wanted;
	if (wanted === "both") return allowed.includes("in") ? "in" : allowed.includes("out") ? "out" : "off";
	return "off";
}

/**
 * What a quick level sets, by feature (only features whose direction would change):
 * - readonly: everything comes in, nothing goes out;
 * - personal: your own state (r1) goes both ways, the rest comes in;
 * - full: your own state and what others see (r2) go both ways.
 * Acting on people and groups (r3) and typing are never part of a level: they stay as they are.
 */
export function levelChanges(features: readonly BridgeFeatureView[], level: FeatureLevel): ReadonlyMap<string, FeatureDirection> {
	const out = new Map<string, FeatureDirection>();
	for (const f of features) {
		if (f.risk === "r3" || f.risk === "re") continue;
		const wanted: FeatureDirection =
			f.feature === "messages"
				? level === "full"
					? "both"
					: "in"
				: level === "readonly"
					? "in"
					: level === "personal"
						? f.risk === "r1"
							? "both"
							: "in"
						: "both";
		const next = clip(f, wanted);
		if (next !== f.direction) out.set(f.feature, next);
	}
	return out;
}

/** Whether turning a feature to `direction` sends something to the other app that acts on people (asks first). */
export function needsConfirm(f: BridgeFeatureView, direction: FeatureDirection): boolean {
	return f.risk === "r3" && (direction === "out" || direction === "both") && f.direction !== direction;
}
