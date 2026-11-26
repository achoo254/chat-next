// The chat's suggestion to compact, above its status line, once the context
// of the session's latest turn nears the threshold of the machine's "Context
// lớn" rule: at that point every next turn sends the whole history again. It
// sends /compact as if typed, for an AI that compacts. Dismissed per thread
// on this device until the context falls below the threshold again (after a
// compaction), so it comes back for the next time the session grows.
import { useEffect, useState } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import type { SessionMeter } from "./session-meter.ts";
import { tokens } from "./usage-format.ts";

const KEY = "chat.contextHintDismissed:";

function read(key: string): boolean {
	try {
		return window.localStorage.getItem(key) === "1";
	} catch {
		return false;
	}
}

function write(key: string, on: boolean): void {
	try {
		if (on) window.localStorage.setItem(key, "1");
		else window.localStorage.removeItem(key);
	} catch {
		// Storage off: the hint simply comes back next time.
	}
}

export interface ContextHintProps {
	readonly meter: SessionMeter;
	/** Machine and thread, for remembering a dismissal. */
	readonly scope: string;
	/** The AI compacts (ProviderCapabilities.compaction) and the session can take a message now. */
	readonly canCompact: boolean;
	readonly onCompact: () => void;
}

export function ContextHint({ meter, scope, canCompact, onCompact }: ContextHintProps) {
	const u = useMachinesCopy().usage;
	const m = u.meter;
	const key = KEY + scope;
	// Bumped on a dismissal, so the page reads the stored choice again.
	const [, setRound] = useState(0);
	const dismissed = read(key);
	// Below the threshold again (compacted, or a new conversation): the next time counts afresh.
	useEffect(() => {
		if (!meter.near) write(key, false);
	}, [meter.near, key]);
	if (!meter.near || dismissed || meter.context === null) return null;
	return (
		<div className="mx-warn mx-context-hint" role="note" data-id="session-context-hint">
			<p>{m.contextNear(tokens(u, meter.context))}</p>
			<div className="mx-context-hint-actions">
				{canCompact && (
					<button type="button" className="btn btn-sm btn-primary" onClick={onCompact}>
						{m.compact}
					</button>
				)}
				<button
					type="button"
					className="btn btn-sm"
					onClick={() => {
						write(key, true);
						setRound((r) => r + 1);
					}}
				>
					{m.dismiss}
				</button>
			</div>
		</div>
	);
}
