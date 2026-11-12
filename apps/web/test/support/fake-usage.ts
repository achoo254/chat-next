// A machine's usage side in memory, for the visual harness and the browser
// test of "Hiệu quả": a report of the last 90 days (made-up numbers for the
// demo project's folder), the rules' switches and deleting the ledger. Never
// imported by production code.
import { create } from "@bufbuild/protobuf";
import { UsageReportSchema, UsageRule, type Frame } from "@achoo254/chat-proto/remote/remote";
import type { Body } from "../machines/fake-machine.ts";

const pad = (n: number): string => String(n).padStart(2, "0");
const dayBefore = (days: number): string => {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export class FakeUsage {
	/** Usage requests the device sent, in order. */
	readonly seen: string[] = [];
	deleted = false;
	readonly switches: { rule: UsageRule; enabled: boolean; experimental: boolean }[] = [
		{ rule: UsageRule.CONTEXT, enabled: true, experimental: false },
		{ rule: UsageRule.TURNS, enabled: true, experimental: false },
		{ rule: UsageRule.MECHANICAL, enabled: true, experimental: true },
		{ rule: UsageRule.SUBAGENTS, enabled: true, experimental: false },
	];

	/** @param repoKey the key the demo's rows carry (the folder's `local:<name>`). */
	constructor(private readonly repoKey: string) {}

	private report(from: string, to: string) {
		const row = (daysAgo: number, mainTurns: number, meanContext: number, appTurns: number) => ({
			repoKey: this.repoKey,
			day: dayBefore(daysAgo),
			inputTokens: 1_200n,
			cacheReadTokens: BigInt(mainTurns * meanContext),
			cacheWriteTokens: 40_000n,
			outputTokens: 18_000n,
			mainTurns,
			subagentTurns: 6,
			sessions: 2,
			appTurns,
			meanContext: BigInt(meanContext),
			medianContext: BigInt(meanContext),
			p90Context: BigInt(meanContext * 2),
		});
		const hint = (daysAgo: number, rule: UsageRule, value: number, notified: boolean) => {
			const at = Date.now() - daysAgo * 86_400_000;
			return { rule, sessionId: `demo-session-${rule}`, repoKey: this.repoKey, turn: 41, at: BigInt(at), value: BigInt(value), experimental: rule === UsageRule.MECHANICAL, notifiedAt: BigInt(notified ? at + 60_000 : 0) };
		};
		const on = (rule: UsageRule) => this.switches.find((s) => s.rule === rule)?.enabled === true;
		return create(UsageReportSchema, {
			from,
			to,
			utcOffsetMinutes: 420,
			lastScanAt: BigInt(Date.now() - 4 * 60_000),
			shape: { usageRatio: 1 },
			days: this.deleted ? [] : [row(45, 80, 380_000, 10), row(12, 60, 300_000, 20), row(2, 40, 260_000, 18), row(1, 25, 240_000, 9)],
			suggestions: this.deleted ? [] : [hint(2, UsageRule.CONTEXT, 412_000, true), hint(1, UsageRule.MECHANICAL, 812, false)].filter((h) => on(h.rule)),
		});
	}

	/** The answer to a usage request; undefined for any other frame. */
	handle(frame: Frame): Body[] | undefined {
		const b = frame.body;
		switch (b.case) {
			case "usageReportRequest":
				this.seen.push(b.case);
				return [{ case: "usageReport", value: this.report(b.value.from, b.value.to) }];
			case "usageSettingsGet":
				this.seen.push(b.case);
				return [{ case: "usageSettings", value: { rules: this.switches } }];
			case "usageSettingsSet":
				this.seen.push(b.case);
				for (const change of b.value.rules) {
					const s = this.switches.find((x) => x.rule === change.rule);
					if (s !== undefined) s.enabled = change.enabled;
				}
				return [{ case: "usageSettings", value: { rules: this.switches } }];
			case "usageDelete":
				this.seen.push(b.case);
				this.deleted = true;
				return [{ case: "ack", value: {} }];
			default:
				return undefined;
		}
	}
}
