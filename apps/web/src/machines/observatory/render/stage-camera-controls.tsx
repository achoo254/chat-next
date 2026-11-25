// Over the Live Map's scene: the camera's three modes (Tự động / Tự do / Tập
// trung) with where it looks and how often auto moved, the overview map (the
// districts and the camera's view on the whole scene; its view box follows
// the camera through a ref, with no React render per frame), and the status
// legend of the colours the scene uses.
import type { Ref } from "react";
import type { ObservatoryCopy } from "../observatory-copy.ts";
import type { CameraMode } from "./camera-director.ts";
import { PLACE_IDS, type PlaceId, type SceneTable } from "./scene-table.ts";

export interface CameraControlsProps {
	readonly c: ObservatoryCopy;
	readonly mode: CameraMode;
	/** Where it looks (a district's name, "whole scene", "free"). */
	readonly where: string;
	readonly switches: number;
	readonly onMode: (mode: CameraMode) => void;
}

const MODES: readonly CameraMode[] = ["auto", "free", "focus"];

export function CameraControls({ c, mode, where, switches, onMode }: CameraControlsProps) {
	return (
		<div className="lm-camctl" data-id="observe-camera">
			<div className="lm-seg" role="group" aria-label={c.camera.label}>
				{MODES.map((m) => (
					<button key={m} type="button" aria-pressed={mode === m} data-id={`observe-camera-${m}`} onClick={() => onMode(m)}>
						{c.camera[m]}
					</button>
				))}
			</div>
			<span className="lm-camnote" data-id="observe-camera-note">
				{c.camera.note(where, switches)}
			</span>
		</div>
	);
}

export interface MinimapProps {
	readonly c: ObservatoryCopy;
	readonly scene: SceneTable;
	/** Districts the AI works in now (drawn in their colour). */
	readonly active: ReadonlySet<PlaceId>;
	/** The view box, moved by the stage as the camera moves. */
	readonly viewRef: Ref<HTMLDivElement>;
}

const pct = (v: number, of: number): string => `${((v / of) * 100).toFixed(2)}%`;

export function Minimap({ c, scene, active, viewRef }: MinimapProps) {
	const W = scene.space.width;
	const H = scene.space.height;
	return (
		<div className="lm-minimap" aria-label={c.camera.minimap} role="img" data-id="observe-minimap" style={{ aspectRatio: `${W} / ${H}` }}>
			<span className="lm-minimap-title" aria-hidden="true">
				{c.camera.minimap}
			</span>
			{PLACE_IDS.filter((p) => p !== "orchestrator").map((p) => {
				const r = scene.places[p].rect;
				return <i key={p} data-place={p} data-active={active.has(p) || undefined} style={{ left: pct(r.x, W), top: pct(r.y, H), width: pct(r.w, W), height: pct(r.h, H) }} />;
			})}
			<div className="lm-minimap-view" ref={viewRef} />
		</div>
	);
}

export function Legend({ c }: { c: ObservatoryCopy }) {
	return (
		<ul className="lm-legend" aria-label={c.camera.legend} data-id="observe-legend">
			<li data-s="run">{c.camera.legendRun}</li>
			<li data-s="wait">{c.camera.legendWait}</li>
			<li data-s="ok">{c.camera.legendOk}</li>
			<li data-s="err">{c.camera.legendErr}</li>
		</ul>
	);
}
