// The line under the last message while a turn runs: what it does (thinking,
// writing, running a tool, waiting for the user), how long the turn has run
// and the output tokens so far when the AI reports them (tunelo 2.5.0+,
// ThreadActivity). A session running elsewhere on the machine shows only
// what the machine can tell of it: its running tool and how long ago it was
// last active. Older machines keep the plain "working" line.
//
// The clock ticks here and only here: the activity is kept out of the link's
// state, so neither the session list nor the messages render again for it.
import { useSyncExternalStore } from "react";
import { ActivityPhase, type ThreadActivity, type ThreadSummary } from "@achoo254/chat-proto/remote/remote";
import { useI18n } from "../i18n/i18n.tsx";
import type { MachinesCopy } from "./copy-vi.ts";
import type { MachineLink } from "./link/machine-link.ts";
import { clockText, useNow } from "./transcript/run-time.ts";
import { useMachinesCopy } from "./use-machines-copy.ts";

/** Where the line reads the latest activity of a thread from. */
export type ActivitySource = Pick<MachineLink, "activity" | "onActivity">;

/** An activity this much older than the running turn belongs to an earlier turn. */
const STALE_MS = 2_000;

export interface ActivityLineProps {
	source: ActivitySource;
	threadId: string;
	thread: ThreadSummary | null;
	/** A turn the machine runs is under way (or waits for the user). */
	running: boolean;
	/** The machine sends ThreadActivity (tunelo 2.5.0+). */
	live: boolean;
	/** When the running turn began, from the transcript (Unix ms); null when unknown. */
	startedAt: number | null;
	/** A prompt waits for the user. */
	waiting: boolean;
	/** The AI's answer is streaming in. */
	streaming: boolean;
	ai: string;
}

/** A count as the locale writes it short ("8.7K", "8,7 N", "8.7千"). */
export function tokenCount(n: bigint, locale: string): string {
	try {
		return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(Number(n));
	} catch {
		return String(n);
	}
}

/** What the running turn does, in words. */
export function phaseText(t: MachinesCopy, activity: Pick<ThreadActivity, "phase" | "tool"> | undefined): string {
	switch (activity?.phase) {
		case ActivityPhase.WRITING:
			return t.transcript.activity.writing;
		case ActivityPhase.TOOL:
			return activity.tool === "" ? t.transcript.activity.thinking : t.transcript.activity.tool(activity.tool);
		case ActivityPhase.WAITING:
			return t.transcript.activity.waiting;
		default:
			return t.transcript.activity.thinking;
	}
}

export function ActivityLine({ source, threadId, thread, running, live, startedAt, waiting, streaming, ai }: ActivityLineProps) {
	const t = useMachinesCopy();
	const { locale } = useI18n();
	const latest = useSyncExternalStore(source.onActivity, () => source.activity(threadId));
	const elsewhere = !running && thread?.busyElsewhere === true;
	const activity = latest !== undefined && (startedAt === null || Number(latest.turnStartedAt) + STALE_MS >= startedAt) ? latest : undefined;
	// The plain line of older machines: only while nothing else shows that the AI works.
	const plain = running && !live && !waiting && !streaming;
	const from = elsewhere ? Number(thread.elsewhereActiveAt) : activity !== undefined ? Number(activity.turnStartedAt) : startedAt;
	const shown = elsewhere || (running && live) || plain;
	const now = useNow(shown && from !== null && from > 0);
	if (!shown) return null;
	const clock = from !== null && from > 0 ? clockText(now - from, t, locale) : "";
	let label: string;
	let parts: string[];
	if (elsewhere) {
		label = t.transcript.activity.elsewhere;
		parts = [label, thread.previewTool === "" ? "" : t.transcript.activity.tool(thread.previewTool), clock === "" ? "" : t.transcript.activity.lastActive(clock)];
	} else if (live) {
		label = phaseText(t, activity);
		const tokens = activity?.outputTokens;
		parts = [label, clock, tokens === undefined ? "" : t.transcript.activity.tokens(tokenCount(tokens, locale))];
	} else {
		label = t.chat.typing(ai);
		parts = clock === "" ? [] : [t.transcript.working(clock)];
	}
	const text = parts.filter((p) => p !== "").join(" · ");
	return (
		<div className="mx-typing" role="status" aria-label={label} data-activity={elsewhere ? "elsewhere" : live ? "live" : "plain"}>
			<i />
			<i />
			<i />
			{text !== "" && <span className="mx-typing-time">{text}</span>}
		</div>
	);
}
