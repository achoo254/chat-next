// The session's timeline under the Live Map: marks coloured by the station
// most events of each stretch were at (failures and findings stand out),
// a slider to drag or click to a moment, play/pause, the event before or
// after, the speed (1x, 4x, 16x; silences over 10 s play in 1 s), and "Live"
// to follow the session again. Live, the slider sits at the end. Keys while
// the bar has focus: Space plays or pauses, Left/Right go to the event
// before or after. A session older than 90 days has no events left: the bar
// is off and says so. On a phone the bar is compact (live-map-drawer.css).
// The bar only reports cursors (replay-controller.ts); the view rebuilds the
// scene at the cursor's moment.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { clock } from "./drill-format.ts";
import { useObservatoryCopy } from "./observatory-copy.ts";
import { cursorAt, eventStep, goLive, nextSpeed, played, togglePlay, type ReplayCursor, type ReplayMark, type ReplayTimeline } from "./replay-controller.ts";
import "./live-map-drawer.css";

/** How often a playing bar moves its cursor. */
export const PLAY_TICK_MS = 100;

export interface ReplayBarProps {
	readonly timeline: ReplayTimeline;
	readonly marks: readonly ReplayMark[];
	readonly cursor: ReplayCursor;
	readonly onCursor: (cursor: ReplayCursor) => void;
	/** Older events are still being asked: replaying waits. */
	readonly loading: boolean;
	/** Only the session's totals are left (DETAIL_RETENTION_MS). */
	readonly expired: boolean;
	/** The replay starts at the oldest event held, not at the session's start. */
	readonly partial: boolean;
	/** Live events that arrived while replaying. */
	readonly held: number;
}

export function ReplayBar({ timeline, marks, cursor, onCursor, loading, expired, partial, held }: ReplayBarProps) {
	const c = useObservatoryCopy();
	const latest = useRef({ cursor, timeline, onCursor });
	useEffect(() => {
		latest.current = { cursor, timeline, onCursor };
	});
	const playing = cursor.mode === "replay" && cursor.playing;
	useEffect(() => {
		if (!playing) return;
		let last = Date.now();
		const timer = window.setInterval(() => {
			const now = Date.now();
			const current = latest.current;
			const next = played(current.cursor, current.timeline, now - last);
			// The next tick may come before React renders this one: it plays on from here.
			latest.current = { ...current, cursor: next };
			current.onCursor(next);
			last = now;
		}, PLAY_TICK_MS);
		return () => window.clearInterval(timer);
	}, [playing]);

	if (expired)
		return (
			<div className="lmd-bar" data-id="lmd-replay" data-state="expired">
				<p className="lmd-note" role="status">
					{c.replay.expired}
				</p>
			</div>
		);

	const at = cursor.mode === "replay" ? cursor.at : timeline.end;
	const span = Math.max(1, timeline.end - timeline.start);
	const ready = !loading && timeline.end > timeline.start;
	const step = (direction: -1 | 1): void => onCursor(cursorAt(cursor, timeline, eventStep(timeline, at, direction)));
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
		if (!ready) return;
		if (e.key === " ") {
			e.preventDefault();
			onCursor(togglePlay(cursor, timeline));
		} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
			e.preventDefault();
			step(e.key === "ArrowLeft" ? -1 : 1);
		}
	};

	return (
		<div className="lmd-bar" role="toolbar" aria-label={c.replay.label} data-id="lmd-replay" data-state={cursor.mode} onKeyDown={onKeyDown}>
			<div className="lmd-bar-controls">
				<span className="lmd-bar-title">{c.replay.title}</span>
				<button type="button" className="btn btn-sm mx-btn-ghost" aria-label={c.replay.previous} data-id="lmd-prev" disabled={!ready} onClick={() => step(-1)}>
					⏮
				</button>
				<button type="button" className="btn btn-sm" data-id="lmd-play" disabled={!ready} onClick={() => onCursor(togglePlay(cursor, timeline))}>
					{playing ? c.replay.pause : c.replay.play}
				</button>
				<button type="button" className="btn btn-sm mx-btn-ghost" aria-label={c.replay.next} data-id="lmd-next" disabled={!ready} onClick={() => step(1)}>
					⏭
				</button>
				<span className="lmd-bar-time" data-id="lmd-position">
					{c.replay.position(clock(c, at), clock(c, timeline.end))}
				</span>
				<button type="button" className="btn btn-sm mx-btn-ghost" data-id="lmd-speed" title={c.replay.silence} onClick={() => onCursor(nextSpeed(cursor))}>
					{c.replay.speed(cursor.speed)}
				</button>
				<button type="button" className="btn btn-sm mx-btn-ghost" data-id="lmd-live" aria-pressed={cursor.mode === "live"} disabled={cursor.mode === "live"} onClick={() => onCursor(goLive(cursor))}>
					{c.replay.live}
				</button>
			</div>
			<div className="lmd-track">
				<div className="lmd-marks" aria-hidden="true">
					{marks.map((m) => (
						<span
							key={m.start}
							className="lmd-mark"
							data-station={m.station}
							data-failed={m.failed || undefined}
							data-bottleneck={m.bottleneck || undefined}
							style={{ left: `${((m.start - timeline.start) / span) * 100}%`, width: `${((m.end - m.start) / span) * 100}%` }}
						/>
					))}
				</div>
				<input
					type="range"
					className="lmd-slider"
					aria-label={c.replay.slider}
					aria-valuetext={clock(c, at)}
					data-id="lmd-slider"
					min={timeline.start}
					max={timeline.end}
					step={1}
					value={at}
					disabled={!ready}
					onChange={(e) => onCursor(cursorAt(cursor, timeline, Number(e.currentTarget.value)))}
				/>
			</div>
			<p className="lmd-note lmd-bar-notes">
				{loading && <span role="status">{c.replay.loading}</span>}
				{partial && <span>{c.replay.partial(clock(c, timeline.start))}</span>}
				{cursor.mode === "replay" && held > 0 && <span data-id="lmd-held">{c.replay.held(held)}</span>}
				<span className="lmd-keys">{c.replay.keys}</span>
			</p>
		</div>
	);
}
