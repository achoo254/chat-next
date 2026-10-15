// The date filter (mockups/search.html#filters): quick ranges, and a month
// calendar where two clicks pick a range (weeks start on Monday, no future
// days). Applied only with "Áp dụng"; "Xoá" removes the filter.
import { useState } from "react";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { addDays, rangeLabel, startOfDay } from "./filters.ts";
import { Popover } from "./popover.tsx";

type Quick = "today" | "days7" | "days30" | "custom";

interface DateRangeProps {
	id: string;
	fromDay: number;
	toDay: number;
	/** Today's start (local midnight, ms); passed in so tests and screenshots are stable. */
	today: number;
	onApply: (fromDay: number, toDay: number) => void;
	onClose: () => void;
}

function quickOf(fromDay: number, toDay: number, today: number): Quick {
	if (fromDay === 0 || toDay !== today) return "custom";
	if (fromDay === today) return "today";
	if (fromDay === addDays(today, -6)) return "days7";
	if (fromDay === addDays(today, -29)) return "days30";
	return "custom";
}

export function DateRange({ id, fromDay, toDay, today, onApply, onClose }: DateRangeProps) {
	const copy = useScreensCopy();
	const t = copy.search.range;
	const { locale } = useI18n();
	const [start, setStart] = useState(fromDay);
	const [end, setEnd] = useState(toDay);
	const shown = new Date(end !== 0 ? end : start !== 0 ? start : today);
	const [month, setMonth] = useState({ year: shown.getFullYear(), month: shown.getMonth() });
	const [quick, setQuick] = useState<Quick>(quickOf(fromDay, toDay, today));

	const pickQuick = (kind: Quick) => {
		setQuick(kind);
		if (kind === "custom") return;
		const from = kind === "today" ? today : addDays(today, kind === "days7" ? -6 : -29);
		setStart(from);
		setEnd(today);
		const now = new Date(today);
		setMonth({ year: now.getFullYear(), month: now.getMonth() });
	};
	const pickDay = (day: number) => {
		setQuick("custom");
		if (start === 0 || end !== 0) {
			setStart(day);
			setEnd(0);
		} else if (day < start) {
			setStart(day);
		} else {
			setEnd(day);
		}
	};

	const first = new Date(month.year, month.month, 1);
	const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
	// Monday-first: Sunday (0) goes last.
	const leading = (first.getDay() + 6) % 7;
	const todayDate = new Date(today);
	const thisMonth = month.year === todayDate.getFullYear() && month.month === todayDate.getMonth();
	const moveMonth = (delta: number) => setMonth(({ year, month: m }) => ({ year: m + delta < 0 ? year - 1 : m + delta > 11 ? year + 1 : year, month: (m + delta + 12) % 12 }));
	const last = end !== 0 ? end : start;
	const label = start === 0 ? t.none : end === 0 ? t.pickEnd(rangeLabel(start, 0, locale, true)) : rangeLabel(start, end, locale, true);

	return (
		<Popover id={id} label={t.label} className="sx-dates" onClose={onClose}>
			<div className="choice quick" role="group" aria-label={t.quick}>
				{(["today", "days7", "days30", "custom"] as const).map((kind) => (
					<button key={kind} type="button" aria-pressed={quick === kind} onClick={() => pickQuick(kind)}>
						{t[kind]}
					</button>
				))}
			</div>
			<div className="cal-head">
				<button type="button" className="icon-btn flip-x" aria-label={t.prevMonth} onClick={() => moveMonth(-1)}>
					<Icon name="chevron-right" />
				</button>
				<b>{t.month(month.month + 1, month.year)}</b>
				<button type="button" className="icon-btn" aria-label={t.nextMonth} disabled={thisMonth} onClick={() => moveMonth(1)}>
					<Icon name="chevron-right" />
				</button>
			</div>
			<div className="cal" role="grid" aria-label={t.month(month.month + 1, month.year)}>
				{t.weekdays.map((weekday) => (
					<span key={weekday} className="wd" role="columnheader">
						{weekday}
					</span>
				))}
				{Array.from({ length: leading }, (_, index) => (
					<span key={`pad-${index}`} />
				))}
				{Array.from({ length: daysInMonth }, (_, index) => {
					const day = startOfDay(new Date(month.year, month.month, index + 1).getTime());
					const edge = day === start || day === end;
					const inside = end !== 0 && day > start && day < end;
					const classes = [edge ? "edge" : "", inside ? "in" : "", day === today ? "today" : ""].filter(Boolean).join(" ");
					return (
						<button
							key={day}
							type="button"
							className={classes === "" ? undefined : classes}
							aria-label={t.day(index + 1, month.month + 1)}
							aria-pressed={edge || inside}
							disabled={day > today}
							onClick={() => pickDay(day)}
						>
							{index + 1}
						</button>
					);
				})}
			</div>
			<div className="pop-foot">
				<span className="muted">{label}</span>
				<button type="button" className="btn btn-sm" onClick={() => onApply(0, 0)}>
					{t.clear}
				</button>
				<button type="button" className="btn btn-sm btn-primary" disabled={start === 0} onClick={() => onApply(start, last)}>
					{t.apply}
				</button>
			</div>
		</Popover>
	);
}
