// The wall boards of the office, in HTML (both views): the lobby's notice
// board (staff today, tasks done, session time), Planning's todo counts,
// Audit's tokens and cost ("no numbers yet" rather than zeros, tokens only
// when the AI reports no cost), and QA's passes and failures. Only counts:
// the agent never sends todo text or tool output.
import type { ReactNode } from "react";
import type { RoomCode } from "./office-rooms.ts";
import type { OfficeCopy } from "./office-names.ts";
import type { OfficeState } from "./office-store.ts";

export const BOARD_ROOMS: readonly RoomCode[] = ["LOBBY", "PLANNING", "AUDIT", "QA"];

/** Local midnight of `now` (viewer clock). */
function midnight(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function duration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}` : `0:${String(m).padStart(2, "0")}`;
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: "good" | "bad" | undefined }) {
	return (
		<div className="of-board-row" data-tone={tone}>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	);
}

export function OfficeBoard({ room, state, now, t, locale }: { room: RoomCode; state: OfficeState; now: number; t: OfficeCopy; locale: string }) {
	const s = state.session;
	const count = new Intl.NumberFormat(locale);
	const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
	let title: string;
	let rows: ReactNode;
	switch (room) {
		case "LOBBY": {
			// Machine times on the viewer's clock.
			const today = midnight(now);
			const staffToday = state.visitors.filter((v) => v.enteredAt + state.clockOffset >= today).length;
			title = t.board.lobby;
			rows = (
				<>
					<Row label={t.board.staffToday} value={count.format(staffToday)} />
					<Row label={t.board.tasksDone} value={count.format(s.tasksDone)} />
					<Row label={t.board.sessionTime} value={s.startedAt > 0 ? duration(now - (s.startedAt + state.clockOffset)) : "–"} />
				</>
			);
			break;
		}
		case "PLANNING":
			title = t.board.planning;
			rows = (
				<>
					<Row label={t.board.todoPending} value={count.format(s.todo.pending)} />
					<Row label={t.board.todoInProgress} value={count.format(s.todo.inProgress)} />
					<Row label={t.board.todoDone} value={count.format(s.todo.done)} tone="good" />
				</>
			);
			break;
		case "AUDIT":
			title = t.board.audit;
			rows = !s.usage.available ? (
				<p className="of-board-note">{t.board.noData}</p>
			) : (
				<>
					<Row label={t.board.tokensIn} value={compact.format(s.usage.inputTokens)} />
					<Row label={t.board.tokensOut} value={compact.format(s.usage.outputTokens)} />
					{s.usage.hasCost && <Row label={t.board.cost} value={new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(s.usage.costUsd)} />}
				</>
			);
			break;
		case "QA":
			title = t.board.qa;
			rows = (
				<>
					<Row label={t.board.passed} value={count.format(s.checks.passed)} tone="good" />
					<Row label={t.board.failed} value={count.format(s.checks.failed)} tone={s.checks.failed > 0 ? "bad" : undefined} />
				</>
			);
			break;
		default:
			return null;
	}
	return (
		<section className="of-board" aria-label={title} data-id={`office-board-${room.toLowerCase()}`}>
			<h4>{title}</h4>
			<dl>{rows}</dl>
		</section>
	);
}
