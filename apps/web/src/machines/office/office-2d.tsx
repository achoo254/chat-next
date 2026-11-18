// The office without WebGL (and the first way it is drawn): the picture of the
// whole plan rendered from the 3D scene (day or night by the viewer's hour,
// desktop or phone framing) in a frame that scrolls, with each person's status
// dot, name and speech bubble in HTML at the projected point of their anchor
// (a resident walking over for a talk shows at the anchor of the one they talk
// to, their lines in the bubble in turn), and the rooms' boards at their board
// anchors. The `work` framing enlarges the picture so the work zone fills the
// frame and scrolls to it (again whenever the frame changes size, a phone
// turned); the `overview` framing fits the whole picture. Without
// a valid asset file (not baked yet, or baked from another layout) the rooms
// show as cards on a plain background, grouped by zone, people listed in each.
import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useMachinesCopy } from "../use-machines-copy.ts";
import { ASSETS_BASE, type AssetView } from "./office-assets.ts";
import { lineOf, talkOf } from "./office-conversations.ts";
import { projectPoint, type ScreenSize } from "./office-geometry.ts";
import type { OfficeLayout, ZoneId } from "./office-layout.ts";
import { markerView, personColor, workGroup, type OfficeCopy } from "./office-names.ts";
import type { Placement } from "./office-placement.ts";
import type { OfficeFraming, OfficeRendererProps } from "./office-renderer.ts";

type ColorStyle = CSSProperties & { "--of-color": string; "--of-stack"?: number };
type PictureStyle = CSSProperties & { "--of-aspect": number; "--of-zoom-x": number; "--of-zoom-y": number };

/** The zone the `work` framing opens on: the director's, the shared work room's and the meeting room's. */
export const WORK_ZONE: ZoneId = "a";
/** Head height over the floor (metres): the box of a zone takes in the people standing in it, not only its floor. */
const PERSON_HEIGHT = 1.8;

/** Part of a picture in percent of its width and height from the top left. */
export interface PictureBox {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/** Where `zone` lands on the picture of `size`: the box around its floor's corners and the heads over them, projected by the default camera. */
export function zoneBox(layout: OfficeLayout, size: ScreenSize, zone: ZoneId): PictureBox | null {
	const rect = layout.zones.find((z) => z.id === zone)?.rect;
	if (rect === undefined) return null;
	const [x0, z0, x1, z1] = rect;
	const points: (readonly [number, number])[] = [];
	for (const x of [x0, x1]) for (const z of [z0, z1]) for (const y of [0, PERSON_HEIGHT]) points.push(projectPoint(layout.camera, layout.camera.views[size], x, y, z));
	const xs = points.map((p) => p[0]);
	const ys = points.map((p) => p[1]);
	return { left: Math.max(0, Math.min(...xs)), top: Math.max(0, Math.min(...ys)), right: Math.min(100, Math.max(...xs)), bottom: Math.min(100, Math.max(...ys)) };
}

/**
 * How the picture sits in its frame: how many frame widths (and frame heights over the picture's) the zoomed picture may
 * span, and the point of the picture to centre. The `work` framing zooms until the work zone fills the frame on its
 * binding side; the `overview` framing fits the whole plan.
 */
export function pictureFraming(layout: OfficeLayout, size: ScreenSize, framing: OfficeFraming): { readonly zoomX: number; readonly zoomY: number; readonly focus: readonly [number, number] } {
	const box = framing === "work" ? zoneBox(layout, size, WORK_ZONE) : null;
	if (box === null || box.right <= box.left || box.bottom <= box.top) return { zoomX: 1, zoomY: 1, focus: [50, 50] };
	return { zoomX: 100 / (box.right - box.left), zoomY: 100 / (box.bottom - box.top), focus: [(box.left + box.right) / 2, (box.top + box.bottom) / 2] };
}

/** "+N" of the meeting room: employees sitting there for want of a desk (the store's overflow, once they got there). */
function waitingForDesks(placements: readonly Placement[]): number {
	return placements.filter((p) => p.room === "MEETING" && p.member !== null && !p.member.nested && p.member.desk === null).length;
}

/** What a marker needs to open its person's panel: whether it is the chosen one and what a press does (the chairman is nobody to inspect). */
interface Pick {
	readonly selected: boolean;
	readonly onPick: (key: string) => void;
}

function Marker({ p, t, line, placed, pick }: { p: Placement; t: OfficeCopy; line: string | null; placed?: { x: number; y: number; stack: number; anchor: string }; pick?: Pick | undefined }) {
	const { status, name, label, bubble, talking } = markerView(t, p, line);
	const style: ColorStyle = { "--of-color": personColor(p) };
	if (placed !== undefined) {
		style.left = `${placed.x}%`;
		style.top = `${placed.y}%`;
		style["--of-stack"] = placed.stack;
	}
	return (
		<div
			className="of-marker"
			data-status={status}
			data-kind={p.kind}
			data-service={p.actor?.service?.kind}
			data-group={workGroup(p)}
			data-anchor={placed?.anchor ?? p.anchorId}
			style={style}
			title={label}
			data-id={`office-person-${p.key}`}
			data-selected={pick?.selected === true ? "" : undefined}
		>
			{pick !== undefined && p.kind !== "chairman" ? (
				<button type="button" className="of-pick" aria-pressed={pick.selected} aria-label={t.inspector.openHint(name)} onClick={() => pick.onPick(p.key)}>
					<span className="of-dot" aria-hidden="true">
						{status === "slow" ? "⌛" : ""}
					</span>
					<span className="of-name">{name}</span>
				</button>
			) : (
				<>
					<span className="of-dot" aria-hidden="true">
						{status === "slow" ? "⌛" : ""}
					</span>
					<span className="of-name">{name}</span>
				</>
			)}
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

/** The pick of a person from the renderer's props: none without a view that listens (the tests of the plain drawing). */
function pickOf(props: OfficeRendererProps, key: string): Pick | undefined {
	const onSelect = props.onSelect;
	return onSelect === undefined ? undefined : { selected: props.selectedKey === key, onPick: onSelect };
}

function Picture({ view, props, t }: { view: AssetView; props: OfficeRendererProps; t: OfficeCopy }) {
	const { placements, talks, daypart, layout, now, size, framing } = props;
	const file = daypart.phase === "day" ? view.day : view.night;
	const stacks = new Map<string, number>();
	const meeting = layout.anchors.find((a) => a.room === "MEETING" && a.kind === "meeting");
	const meetingAt = meeting === undefined ? undefined : view.anchors.get(meeting.id);
	const { zoomX, zoomY, focus } = pictureFraming(layout, size, framing);
	const [focusX, focusY] = focus;
	const frameRef = useRef<HTMLDivElement>(null);
	const pictureRef = useRef<HTMLDivElement>(null);
	// Centre the framing's point when the framing changes and whenever the frame changes size (a phone turned, a window
	// resized); the viewer's own scrolling stays until then.
	useLayoutEffect(() => {
		const frame = frameRef.current;
		const picture = pictureRef.current;
		if (frame === null || picture === null) return;
		const centre = (): void => {
			frame.scrollLeft = Math.max(0, (focusX / 100) * picture.offsetWidth - frame.clientWidth / 2);
			frame.scrollTop = Math.max(0, (focusY / 100) * picture.offsetHeight - frame.clientHeight / 2);
		};
		centre();
		if (typeof ResizeObserver !== "function") return;
		let last = { width: frame.clientWidth, height: frame.clientHeight };
		const observer = new ResizeObserver(() => {
			const now = { width: frame.clientWidth, height: frame.clientHeight };
			if (now.width === last.width && now.height === last.height) return;
			last = now;
			centre();
		});
		observer.observe(frame);
		return () => observer.disconnect();
	}, [focusX, focusY, zoomX, zoomY]);
	const style: PictureStyle = { aspectRatio: `${view.width} / ${view.height}`, "--of-aspect": view.width / view.height, "--of-zoom-x": zoomX, "--of-zoom-y": zoomY };
	return (
		<div className="of-scroll" ref={frameRef} data-id="office-picture">
			<div className="of-picture" ref={pictureRef} style={style}>
				<img src={`${ASSETS_BASE}${file}`} alt="" draggable={false} />
				{placements.map((p) => {
					// The visitor of a talk stands at the host's place.
					const talk = talkOf(talks, p.key);
					const anchorId = talk !== null && talk.visitor === p.key ? talk.hostAnchor : p.anchorId;
					const at = view.anchors.get(anchorId);
					if (at === undefined) return null;
					const stack = stacks.get(anchorId) ?? 0;
					stacks.set(anchorId, stack + 1);
					return <Marker key={p.key} p={p} t={t} line={lineOf(talks, p.key, now)} placed={{ x: at[0], y: at[1], stack, anchor: anchorId }} pick={pickOf(props, p.key)} />;
				})}
				{meetingAt !== undefined && <Overflow n={waitingForDesks(placements)} t={t} at={{ x: meetingAt[0], y: meetingAt[1] }} />}
			</div>
		</div>
	);
}

function RoomCards({ props, t }: { props: OfficeRendererProps; t: OfficeCopy }) {
	const { placements, talks, layout, now } = props;
	return (
		<div className="of-zones" data-id="office-rooms">
			{layout.zones.map((zone) => (
				<section key={zone.id} className="of-zone" data-zone={zone.id} data-id={`office-zone-${zone.id}`} aria-label={t.zones[zone.id]}>
					<h3 className="of-zone-name">{t.zones[zone.id]}</h3>
					<div className="of-grid">
						{zone.rooms.map((room) => {
							const here = placements.filter((p) => p.room === room);
							return (
								<section key={room} className="of-room" data-room={room} data-id={`office-room-${room.toLowerCase()}`} aria-label={t.rooms[room]}>
									<h4 className="of-room-name">
										<span>{t.rooms[room]}</span>
										{room === "MEETING" && <Overflow n={waitingForDesks(placements)} t={t} />}
									</h4>
									{here.length === 0 ? (
										<p className="of-room-empty">{t.empty}</p>
									) : (
										<ul className="of-people">
											{here.map((p) => (
												<li key={p.key}>
													<Marker p={p} t={t} line={lineOf(talks, p.key, now)} pick={pickOf(props, p.key)} />
												</li>
											))}
										</ul>
									)}
								</section>
							);
						})}
					</div>
				</section>
			))}
		</div>
	);
}

export function Office2D(props: OfficeRendererProps) {
	const copy = useMachinesCopy();
	const t = copy.office;
	const view = props.assets?.ok === true ? props.assets.value.views[props.size] : undefined;
	return (
		// A press on nothing (the picture, a room card's blank) closes the panel; names are buttons and keep the press for themselves; Esc and the panel's own button close it from the keyboard.
		// eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
		<div
			className="of-stage"
			onClick={(e) => {
				if (props.selectedKey != null && !(e.target as Element).closest("button")) props.onSelect?.(null);
			}}
			data-power={props.state.power}
			data-daypart={props.daypart.phase}
			data-renderer="2d"
			data-view={view === undefined ? "rooms" : "picture"}
			data-framing={props.framing}
		>
			{view === undefined ? <RoomCards props={props} t={t} /> : <Picture view={view} props={props} t={t} />}
		</div>
	);
}
