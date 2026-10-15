// Search filters as the screens hold them (mockups/search.html#filters):
// sender, one type (photos, files, links or voice) and a day range in the
// device's time zone. The core takes them as SearchFilters, locally and on
// the server alike.
import type { SearchFilters } from "@app/core";

export type TypeFilter = "photo" | "document" | "link" | "voice";

export const TYPE_FILTERS: readonly TypeFilter[] = ["photo", "document", "link", "voice"];

export interface UiFilters {
	/** 0 = anyone. */
	readonly fromId: number;
	readonly type: TypeFilter | null;
	/** First and last day (local midnight, ms); 0 = no range. */
	readonly fromDay: number;
	readonly toDay: number;
}

export const NO_FILTERS: UiFilters = { fromId: 0, type: null, fromDay: 0, toDay: 0 };

export function anyFilter(filters: UiFilters): boolean {
	return filters.fromId !== 0 || filters.type !== null || filters.fromDay !== 0;
}

/** Local midnight of the day holding `ms`. */
export function startOfDay(ms: number): number {
	const day = new Date(ms);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/** `n` days after the day starting at `dayMs` (local calendar days, DST-safe). */
export function addDays(dayMs: number, n: number): number {
	const day = new Date(dayMs);
	day.setDate(day.getDate() + n);
	return day.getTime();
}

export function toSearchFilters(filters: UiFilters): SearchFilters {
	const out: { -readonly [K in keyof SearchFilters]: SearchFilters[K] } = {};
	if (filters.fromId !== 0) out.fromId = filters.fromId;
	if (filters.type === "link") out.hasLink = true;
	else if (filters.type !== null) out.mediaKind = filters.type;
	if (filters.fromDay !== 0) {
		out.since = Math.floor(filters.fromDay / 1000);
		// Through the last second of the last day.
		out.until = Math.floor(addDays(filters.toDay === 0 ? filters.fromDay : filters.toDay, 1) / 1000) - 1;
	}
	return out;
}

/** "01/10 – 14/10" (or one day), in the user's locale. */
export function rangeLabel(fromDay: number, toDay: number, locale: string, withYear = false): string {
	const format = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", ...(withYear ? { year: "numeric" } : {}) });
	const from = format.format(new Date(fromDay));
	if (toDay === 0 || toDay === fromDay) return from;
	return `${from} – ${format.format(new Date(toDay))}`;
}
