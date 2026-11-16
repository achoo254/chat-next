// The office without WebGL (and the first way it is drawn): the floor's
// picture rendered from the 3D scene (day or night by the viewer's hour,
// desktop or phone framing), with each person's status dot, name and speech
// bubble in HTML at the projected point of their anchor (a resident walking
// over for a talk shows at the anchor of the one they talk to, their lines in
// the bubble in turn), and the rooms' boards at their board anchors. A phone pans the picture sideways. Without
// a valid asset file (not baked yet, or baked from another layout) the
// floor's rooms show as cards on a plain background, people listed in each.
import type { CSSProperties } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ASSETS_BASE, type AssetView } from "./office-assets.ts";
import { BOARD_ROOMS, OfficeBoard } from "./office-boards.tsx";
import { lineOf, talkOf } from "./office-conversations.ts";
import { markerView, personColor, type OfficeCopy } from "./office-names.ts";
import type { Placement } from "./office-placement.ts";
import type { OfficeRendererProps } from "./office-renderer.ts";
import type { RoomCode } from "./office-rooms.ts";

type ColorStyle = CSSProperties & { "--of-color": string; "--of-stack"?: number };

/** "+N" of the meeting room: employees sitting there for want of a desk (the store's overflow, once they got there). */
function waitingForDesks(placements: readonly Placement[]): number {
	return placements.filter((p) => p.room === "MEETING" && p.member !== null && !p.member.nested && p.member.desk === null).length;
}

function Marker({ p, t, line, placed }: { p: Placement; t: OfficeCopy; line: string | null; placed?: { x: number; y: number; stack: number; anchor: string } }) {
	const { status, name, label, bubble, talking } = markerView(t, p, line);
	const style: ColorStyle = { "--of-color": personColor(p) };
	if (placed !== undefined) {
		style.left = `${placed.x}%`;
		style.top = `${placed.y}%`;
		style["--of-stack"] = placed.stack;
	}
	return (
		<div className="of-marker" data-status={status} data-kind={p.kind} data-service={p.actor?.service?.kind} data-anchor={placed?.anchor ?? p.anchorId} style={style} title={label} data-id={`office-person-${p.key}`}>
			<span className="of-dot" aria-hidden="true">
				{status === "slow" ? "⌛" : ""}
			</span>
			<span className="of-name">{name}</span>
			<span className="sr-only">{label === name ? "" : label.slice(name.length)}</span>
			{bubble !== "" && (
				<span className="of-bubble" data-talk={talking ? "" : undefined}>
					{bubble}
				</span>
			)}
		</div>
	);
}

function Overflow({ n, t, at }: { n: number; t: OfficeCopy; at?: { x: number; y: number } }) {
	if (n <= 0) return null;
	const style: CSSProperties | undefined = at === undefined ? undefined : { left: `${at.x}%`, top: `${at.y}%` };
	return (
		<span className="of-overflow" style={style} aria-label={t.overflowLabel(n)} title={t.overflowLabel(n)} data-id="office-overflow">
			{t.overflow(n)}
		</span>
	);
}

function Picture({ view, props, t, locale }: { view: AssetView; props: OfficeRendererProps; t: OfficeCopy; locale: string }) {
	const { placements, talks, floor, daypart, state, layout, now } = props;
	const file = daypart.phase === "day" ? view.day : view.night;
	const stacks = new Map<string, number>();
	const shown = placements.filter((p) => p.floor === floor);
	const rooms = layout.floors.find((f) => f.level === floor)?.anchors ?? [];
	const meeting = rooms.find((a) => a.room === "MEETING" && a.kind === "meeting");
	const meetingAt = meeting === undefined ? undefined : view.anchors.get(meeting.id);
	return (
		<div className="of-scroll" data-id="office-picture">
			<div className="of-picture" style={{ aspectRatio: `${view.width} / ${view.height}` }}>
				<img src={`${ASSETS_BASE}${file}`} alt="" draggable={false} />
				{rooms
					.filter((a) => a.kind === "board" && a.room !== null && BOARD_ROOMS.includes(a.room))
					.map((a) => {
						const at = view.anchors.get(a.id);
						if (at === undefined || a.room === null) return null;
						return (
							<div key={a.id} className="of-board-pin" style={{ left: `clamp(var(--of-board-half), ${at[0]}%, calc(100% - var(--of-board-half)))`, top: `${at[1]}%` }}>
								<OfficeBoard room={a.room} state={state} now={now} t={t} locale={locale} />
							</div>
						);
					})}
				{shown.map((p) => {
					// The visitor of a talk stands at the host's place.
					const talk = talkOf(talks, p.key);
					const anchorId = talk !== null && talk.visitor === p.key ? talk.hostAnchor : p.anchorId;
					const at = view.anchors.get(anchorId);
					if (at === undefined) return null;
					const stack = stacks.get(anchorId) ?? 0;
					stacks.set(anchorId, stack + 1);
					return <Marker key={p.key} p={p} t={t} line={lineOf(talks, p.key, now)} placed={{ x: at[0], y: at[1], stack, anchor: anchorId }} />;
				})}
				{meetingAt !== undefined && <Overflow n={waitingForDesks(placements)} t={t} at={{ x: meetingAt[0], y: meetingAt[1] }} />}
			</div>
		</div>
	);
}

function RoomCards({ props, t, locale }: { props: OfficeRendererProps; t: OfficeCopy; locale: string }) {
	const { placements, talks, floor, layout, state, now } = props;
	const rooms: readonly RoomCode[] = layout.floors.find((f) => f.level === floor)?.rooms.map((r) => r.room) ?? [];
	return (
		<div className="of-grid" data-id="office-rooms">
			{rooms.map((room) => {
				const here = placements.filter((p) => p.room === room);
				return (
					<section key={room} className="of-room" data-room={room} data-id={`office-room-${room.toLowerCase()}`} aria-label={t.rooms[room]}>
						<h3>
							<span>{t.rooms[room]}</span>
							{room === "MEETING" && <Overflow n={waitingForDesks(placements)} t={t} />}
						</h3>
						{here.length === 0 ? (
							<p className="of-room-empty">{t.empty}</p>
						) : (
							<ul className="of-people">
								{here.map((p) => (
									<li key={p.key}>
										<Marker p={p} t={t} line={lineOf(talks, p.key, now)} />
									</li>
								))}
							</ul>
						)}
						{BOARD_ROOMS.includes(room) && <OfficeBoard room={room} state={state} now={now} t={t} locale={locale} />}
					</section>
				);
			})}
		</div>
	);
}

export function Office2D(props: OfficeRendererProps) {
	const copy = useMachinesCopy();
	const t = copy.office;
	const view = props.assets?.ok === true ? props.assets.value.floors.get(props.floor)?.[props.size] : undefined;
	return (
		<div className="of-stage" data-power={props.state.power} data-daypart={props.daypart.phase} data-renderer="2d">
			{view === undefined ? <RoomCards props={props} t={t} locale={copy.usage.locale} /> : <Picture view={view} props={props} t={t} locale={copy.usage.locale} />}
		</div>
	);
}
