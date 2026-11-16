// The light of the building by the viewer's clock (the session decides the
// people; the viewer's hour decides the light), shared by both views: the 2D
// view picks its day or night picture from `phase`, the 3D scene blends its
// day and night lightmaps by `nightMix`. The building never closes: people
// live in it round the clock (office-life-schedule.ts), so only the hour
// decides the light.

export type DaypartPhase = "day" | "evening" | "night";

export interface Daypart {
	readonly phase: DaypartPhase;
	/** 0 at full day, 1 at full night; continuous across the day. */
	readonly nightMix: number;
}

/** Hours (local, fractional) where the light changes: dusk from 16:30 to 19:00, dawn from 5:00 to 7:00. */
export const DUSK = { start: 16.5, end: 19 } as const;
export const DAWN = { start: 5, end: 7 } as const;

function smooth(t: number): number {
	const c = Math.min(1, Math.max(0, t));
	return c * c * (3 - 2 * c);
}

/** `now` in milliseconds (the injected clock), read in the viewer's time zone. */
export function officeDaypart(now: number): Daypart {
	const d = new Date(now);
	const hour = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
	let nightMix: number;
	if (hour >= DAWN.end && hour < DUSK.start) nightMix = 0;
	else if (hour >= DUSK.start && hour < DUSK.end) nightMix = smooth((hour - DUSK.start) / (DUSK.end - DUSK.start));
	else if (hour >= DAWN.start && hour < DAWN.end) nightMix = 1 - smooth((hour - DAWN.start) / (DAWN.end - DAWN.start));
	else nightMix = 1;
	const phase: DaypartPhase = nightMix < 0.25 ? "day" : nightMix < 0.75 ? "evening" : "night";
	return { phase, nightMix };
}
