// "Theo ngày" of the "Hiệu quả" page: the last 30 days as stacked bars, one
// band per repository or model (usage-insights.ts seriesOf), in calls,
// context tokens or (from tunelo 3.30.0) cost. Drawn as plain SVG: one chart
// is not worth a charting library. Each bar's total is its title, and the
// legend names the bands. Hovering (or touching, or arrowing to) a day shows
// its total and each band's share in a tip (chart-tip.tsx).
import type { UsageReport } from "@achoo254/chat-proto/remote/remote";
import { useState } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ChartTip, useChartHover } from "./chart-tip.tsx";
import { count, tokens, usd } from "./usage-format.ts";
import { type ChartMetric, type GroupBy, OTHER, seriesOf } from "./usage-insights.ts";

const W = 600;
const H = 160;
const PAD_LEFT = 44;
const PAD_BOTTOM = 18;
const PAD_TOP = 6;

export interface ChartProps {
	readonly report: UsageReport;
	readonly repoKey: string;
	readonly today: string;
	/** Rows per model came (tunelo 3.30.0+): by model and cost are offered. */
	readonly rich: boolean;
}

export function UsageChart({ report, repoKey, today, rich }: ChartProps) {
	const u = useMachinesCopy().usage;
	const c = u.chart;
	const [by, setBy] = useState<GroupBy>("repo");
	const [metric, setMetric] = useState<ChartMetric>(rich ? "cost" : "context");
	const s = seriesOf(report, repoKey, today, rich ? by : "repo", metric);
	const fmt = (n: number) => (metric === "cost" ? usd(u, n) : metric === "turns" ? count(u, n) : tokens(u, n));
	const totals = s.values.map((v) => v.reduce((a, b) => a + b, 0));
	const top = Math.max(...totals, 0);
	const max = top > 0 ? top * 1.1 : 1;
	const plotH = H - PAD_BOTTOM - PAD_TOP;
	const bw = (W - PAD_LEFT) / s.days.length;
	const name = (g: string) => (g === OTHER ? c.other : g === "" ? "—" : g);
	const dayLabel = (day: string) => {
		const [, m = "", d = ""] = day.split("-");
		return `${Number(d)}/${Number(m)}`;
	};
	const hover = useChartHover(s.days.length, (f) => {
		const i = Math.floor((f * W - PAD_LEFT) / bw);
		return i >= 0 && i < s.days.length ? i : null;
	});
	const hi = hover.index;
	const metrics: { key: ChartMetric; label: string }[] = [
		...(rich ? [{ key: "cost" as const, label: c.cost }] : []),
		{ key: "context", label: c.context },
		{ key: "turns", label: c.turns },
	];
	return (
		<section className="mx-card mx-usage-section" aria-labelledby="usage-chart-title" data-id="usage-chart">
			<div className="mx-usage-section-head">
				<h3 id="usage-chart-title">{c.title}</h3>
				{rich && (
					<Segmented
						label={c.title}
						value={by}
						options={[
							{ key: "repo", label: c.byRepo },
							{ key: "model", label: c.byModel },
						]}
						onChange={setBy}
					/>
				)}
				<Segmented label={c.title} value={metric} options={metrics} onChange={setMetric} />
			</div>
			<div className="mx-usage-plot">
			<svg className="mx-usage-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={c.label(metrics.find((m) => m.key === metric)?.label ?? "")} {...hover.svgProps}>
				{hi !== null && <rect className="mx-usage-hover" x={PAD_LEFT + hi * bw} y={PAD_TOP} width={bw} height={plotH} />}
				{[0, 0.5, 1].map((f) => {
					const y = PAD_TOP + plotH * (1 - f);
					return (
						<g key={f}>
							<line x1={PAD_LEFT} x2={W} y1={y} y2={y} className="mx-usage-grid" />
							<text x={PAD_LEFT - 6} y={y + 3} textAnchor="end">
								{fmt(max * f)}
							</text>
						</g>
					);
				})}
				{s.days.map((day, i) => {
					let y = H - PAD_BOTTOM;
					return (
						<g key={day}>
							{(s.values[i] ?? []).map((v, g) => {
								const h = (v / max) * plotH;
								y -= h;
								return h > 0 ? <rect key={s.groups[g]} x={PAD_LEFT + i * bw + 1} y={y} width={Math.max(1, bw - 2)} height={h} rx={1.5} className={`mx-usage-c${g}`} /> : null;
							})}
							{i % 5 === 0 && (
								<text x={PAD_LEFT + i * bw + bw / 2} y={H - 4} textAnchor="middle">
									{dayLabel(day)}
								</text>
							)}
						</g>
					);
				})}
			</svg>
			{hi !== null && (
				<ChartTip fraction={(PAD_LEFT + (hi + 0.5) * bw) / W}>
					<b>{c.dayTotal(dayLabel(s.days[hi] ?? ""), fmt(totals[hi] ?? 0))}</b>
					{s.groups.length > 1 &&
						s.groups.map((g, gi) => {
							const v = s.values[hi]?.[gi] ?? 0;
							return v > 0 ? (
								<span key={g} className="mx-usage-tip-row">
									<i className={`mx-usage-c${gi}`} aria-hidden="true" />
									<span className="mx-usage-tip-name">{name(g)}</span>
									<span>{fmt(v)}</span>
								</span>
							) : null;
						})}
				</ChartTip>
			)}
			</div>
			<ul className="mx-usage-legend">
				{s.groups.map((g, i) => (
					<li key={g}>
						<i className={`mx-usage-c${i}`} aria-hidden="true" />
						{name(g)}
					</li>
				))}
			</ul>
		</section>
	);
}

export function Segmented<K extends string>({ label, value, options, onChange }: { label: string; value: K; options: readonly { key: K; label: string }[]; onChange: (k: K) => void }) {
	return (
		<div className="mx-usage-seg" role="group" aria-label={label}>
			{options.map((o) => (
				<button key={o.key} type="button" aria-pressed={o.key === value} onClick={() => onChange(o.key)}>
					{o.label}
				</button>
			))}
		</div>
	);
}
