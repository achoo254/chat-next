// The 3D way of drawing the office (chooseRenderer in office-view.tsx loads
// this lazily). It first checks for hardware WebGL2 without loading any 3D
// code; without it, or when the 3D view fails to start or loses its GPU
// context, it shows the 2D office instead. React only wraps the canvas: the
// scene (office-world.ts, its own chunk with Babylon) reads the same props
// through `update`, and the HTML over it (names, speech bubbles, boards, the
// meeting room's "+N") is rendered here and moved by the scene each frame.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Office2D } from "../machines/office/office-2d.tsx";
import { BOARD_ROOMS, OfficeBoard } from "../machines/office/office-boards.tsx";
import { lineOf } from "../machines/office/office-conversations.ts";
import { markerView, personColor, workGroup, type OfficeCopy } from "../machines/office/office-names.ts";
import type { Placement } from "../machines/office/office-placement.ts";
import type { OfficeRendererProps } from "../machines/office/office-renderer.ts";
import { useMachinesCopy } from "../machines/use-machines-copy.ts";
import { hardware3DAvailable, office3DFlags, type Office3DFlags } from "./office-flags.ts";
import type { OfficeWorld } from "./office-world.ts";
import { useOfficeWorld } from "./use-office-world.ts";
import "./office-3d.css";

type ColorStyle = CSSProperties & { "--of-color": string };

/** "+N" of the meeting room: employees sitting there for want of a desk. */
function waitingForDesks(placements: readonly Placement[]): number {
	return placements.filter((p) => p.room === "MEETING" && p.member !== null && !p.member.nested && p.member.desk === null).length;
}

function Person({ p, t, line, bind }: { p: Placement; t: OfficeCopy; line: string | null; bind: (id: string, el: HTMLElement | null) => void }) {
	const { status, name, label, bubble, talking } = markerView(t, p, line);
	const id = `person:${p.key}`;
	const style: ColorStyle = { "--of-color": personColor(p) };
	return (
		<div
			className="of-marker of3d-pin"
			data-status={status}
			data-kind={p.kind}
			data-service={p.actor?.service?.kind}
			data-group={workGroup(p)}
			data-anchor={p.anchorId}
			style={style}
			title={label}
			data-id={`office-person-${p.key}`}
			hidden
			ref={(el) => {
				bind(id, el);
				return () => bind(id, null);
			}}
		>
			{bubble !== "" && (
				<span className="of-bubble" data-talk={talking ? "" : undefined}>
					{bubble}
				</span>
			)}
			<span className="of3d-tag">
				<span className="of-dot" aria-hidden="true">
					{status === "slow" ? "⌛" : ""}
				</span>
				<span className="of-name">{name}</span>
			</span>
			<span className="sr-only">{label === name ? "" : label.slice(name.length)}</span>
		</div>
	);
}

function Office3D({ props, flags, onFail }: { props: OfficeRendererProps; flags: Office3DFlags; onFail: () => void }) {
	const copy = useMachinesCopy();
	const t = copy.office;
	const host = useRef<HTMLDivElement>(null);
	const { status, world } = useOfficeWorld(host, props, flags, t.floorNames[props.floor]);
	const worldRef = useRef<OfficeWorld | null>(null);
	const pins = useRef(new Map<string, HTMLElement>());
	useEffect(() => {
		if (status === "failed") onFail();
	}, [status, onFail]);
	useEffect(() => {
		worldRef.current = world;
		if (world === null) return;
		for (const [id, el] of pins.current) world.bind(id, el);
	}, [world]);
	useEffect(() => {
		world?.update(props, props.sound === true);
	}, [world, props]);
	const bind = (id: string, el: HTMLElement | null): void => {
		if (el === null) pins.current.delete(id);
		else pins.current.set(id, el);
		worldRef.current?.bind(id, el);
	};
	const boards = props.layout.floors.flatMap((f) => f.anchors.filter((a) => a.kind === "board" && a.room !== null && BOARD_ROOMS.includes(a.room)));
	const overflow = waitingForDesks(props.placements);
	return (
		<div className="of-stage of3d" ref={host} data-power={props.state.power} data-daypart={props.daypart.phase} data-renderer="3d" data-ready={status === "ready"}>
			<div className="of3d-layer">
				{boards.map((a) =>
					a.room === null ? null : (
						<div
							key={a.id}
							className="of-board-pin of3d-pin of3d-board"
							hidden
							ref={(el) => {
								bind(`board:${a.id}`, el);
								return () => bind(`board:${a.id}`, null);
							}}
						>
							<OfficeBoard room={a.room} state={props.state} now={props.now} t={t} locale={copy.usage.locale} />
						</div>
					),
				)}
				{overflow > 0 && (
					<span
						className="of-overflow of3d-pin of3d-overflow"
						aria-label={t.overflowLabel(overflow)}
						title={t.overflowLabel(overflow)}
						data-id="office-overflow"
						hidden
						ref={(el) => {
							bind("board:overflow", el);
							return () => bind("board:overflow", null);
						}}
					>
						{t.overflow(overflow)}
					</span>
				)}
				{props.placements.map((p) => (
					<Person key={p.key} p={p} t={t} line={lineOf(props.talks, p.key, props.now)} bind={bind} />
				))}
			</div>
			{status === "loading" && (
				<p className="of3d-loading" role="status">
					{t.loading}
				</p>
			)}
		</div>
	);
}

/** The 3D office, or the 2D one where 3D cannot run. */
export default function OfficeCanvas(props: OfficeRendererProps) {
	const [flags] = useState(() => office3DFlags(window.location.search));
	const [capable] = useState(() => hardware3DAvailable(flags));
	const [failed, setFailed] = useState(false);
	const [onFail] = useState(() => () => setFailed(true));
	if (!capable || failed) return <Office2D {...props} />;
	return <Office3D props={props} flags={flags} onFail={onFail} />;
}
