// Where a turn ended: one short line ("Xong · 1 phút 17 giây · 32 tool ·
// 3 file"); when the machine reported the turn's numbers, the line opens to
// show them: model, tokens, cache, context, time waiting on the API, model
// round trips and the cost at API prices (an estimate: a subscription plan
// is not charged it).
import { TurnState, type TurnItem } from "@achoo254/chat-proto/remote/remote";
import type { MachinesCopy } from "../copy-vi.ts";
import { MachineIcon } from "../machine-icons.tsx";

/** 45,2 giây · 1 phút 17 giây · 1 giờ 3 phút. */
export function durationText(ms: number, t: MachinesCopy, locale: string): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 59.95) return t.transcript.seconds(seconds.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
	const whole = Math.round(seconds);
	if (whole < 3600) return t.transcript.minutes(Math.floor(whole / 60), whole % 60);
	const minutes = Math.round(whole / 60);
	return t.transcript.hours(Math.floor(minutes / 60), minutes % 60);
}

/** The turn's line: its outcome, how long it took, and the tools and files of it. */
export function turnText(turn: TurnItem, tools: number, files: number, t: MachinesCopy, locale: string): string {
	if (turn.state === TurnState.INTERRUPTED) return t.transcript.turnInterrupted;
	if (turn.state !== TurnState.COMPLETED) return t.transcript.turnFailed;
	const parts = [durationText(Number(turn.durationMs), t, locale)];
	if (tools > 0) parts.push(t.transcript.turnTools(tools));
	if (files > 0) parts.push(t.transcript.turnFiles(files));
	return t.transcript.turnDone(parts.join(" · "));
}

/** The machine reported more than the duration (tunelo 2.0.11+ with Claude). */
export function hasTurnDetails(turn: TurnItem): boolean {
	return turn.model !== "" || turn.inputTokens > 0n || turn.outputTokens > 0n || turn.durationApiMs > 0n || turn.costUsdEstimate > 0 || turn.contextWindow > 0n;
}

export function costText(usd: number, locale: string): string {
	return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
}

interface TurnLineProps {
	turn: TurnItem;
	tools: number;
	files: number;
	t: MachinesCopy;
	locale: string;
}

export function TurnLine({ turn, tools, files, t, locale }: TurnLineProps) {
	const text = turnText(turn, tools, files, t, locale);
	const failed = turn.state === TurnState.FAILED;
	if (!hasTurnDetails(turn)) return <div className={failed ? "mx-line error" : "mx-line"}>{text}</div>;
	const n = (v: bigint | number) => Number(v).toLocaleString(locale);
	const rows: [string, string][] = [];
	if (turn.model !== "") rows.push([t.transcript.turnModel, turn.model]);
	if (turn.inputTokens > 0n || turn.outputTokens > 0n) rows.push([t.transcript.turnTokens, t.transcript.turnTokensValue(n(turn.inputTokens), n(turn.outputTokens))]);
	if (turn.cacheReadTokens > 0n || turn.cacheWriteTokens > 0n) {
		rows.push([t.transcript.turnCache, t.transcript.turnCacheValue(n(turn.cacheReadTokens), n(turn.cacheWriteTokens))]);
	}
	if (turn.contextWindow > 0n) {
		const share = (Number(turn.contextTokens) / Number(turn.contextWindow)).toLocaleString(locale, { style: "percent", maximumFractionDigits: 0 });
		rows.push([t.transcript.turnContext, t.transcript.turnContextValue(share, n(turn.contextTokens), n(turn.contextWindow))]);
	}
	if (turn.durationApiMs > 0n) rows.push([t.transcript.turnApi, durationText(Number(turn.durationApiMs), t, locale)]);
	if (turn.numTurns > 0) rows.push([t.transcript.turnRounds, n(turn.numTurns)]);
	return (
		<details className="mx-turn">
			<summary className={failed ? "mx-line error" : "mx-line"} title={t.transcript.turnDetails}>
				<span>{text}</span>
				<MachineIcon name="chevron-right" small />
			</summary>
			<dl>
				{rows.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>{v}</dd>
					</div>
				))}
				{turn.costUsdEstimate > 0 && (
					<div>
						<dt>{t.transcript.turnCost}</dt>
						<dd>
							{t.transcript.turnCostValue(costText(turn.costUsdEstimate, locale))}
							<small>{t.transcript.turnCostNote}</small>
						</dd>
					</div>
				)}
			</dl>
		</details>
	);
}
