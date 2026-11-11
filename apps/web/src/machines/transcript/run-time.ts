// How long something has been running, and how long a tool may run: the
// clock beside a running tool ("Đã chạy 1 phút 5 giây · timeout 6 phút 40 giây")
// and beside the working indicator of a turn.
import { useEffect, useState } from "react";
import type { MachinesCopy } from "../copy-vi.ts";
import { durationText } from "../cards/turn-line.tsx";

const TICK_MS = 1000;

/** The time now, renewed every second while `active`; frozen otherwise. */
export function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		// The first look at once: the time kept from before it turned active is stale.
		const first = setTimeout(() => setNow(Date.now()), 0);
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => {
			clearTimeout(first);
			clearInterval(timer);
		};
	}, [active]);
	return now;
}

/** Whole seconds under a minute, else the minutes and hours of durationText. */
export function clockText(ms: number, t: MachinesCopy, locale: string): string {
	const whole = Math.max(0, Math.floor(ms / 1000));
	return whole < 60 ? t.transcript.seconds(String(whole)) : durationText(whole * 1000, t, locale);
}

/**
 * The timeout the call asked for, in ms (the "timeout" of a shell call's
 * input); undefined when it gave none. Read from the text, as the input is
 * shortened when large and may not parse whole.
 */
export function toolTimeoutMs(input: string): number | undefined {
	const found = /"timeout"\s*:\s*(\d+)/.exec(input);
	const ms = found?.[1] === undefined ? 0 : Number(found[1]);
	return ms > 0 ? ms : undefined;
}
