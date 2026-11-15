// What a way of drawing the office receives (the 2D view here; the 3D scene
// of apps/web/src/office-3d takes the same). Renderers only read: the store's
// state, everyone's place, the layout, the floor shown, the light.
import type { Parsed } from "./office-json.ts";
import type { OfficeAssets } from "./office-assets.ts";
import type { Daypart } from "./office-daypart.ts";
import type { ScreenSize } from "./office-geometry.ts";
import type { OfficeLayout } from "./office-layout.ts";
import type { Placement } from "./office-placement.ts";
import type { FloorLevel } from "./office-rooms.ts";
import type { OfficeState } from "./office-store.ts";

export interface OfficeRendererProps {
	readonly state: OfficeState;
	readonly placements: readonly Placement[];
	readonly layout: OfficeLayout;
	readonly floor: FloorLevel;
	readonly size: ScreenSize;
	readonly daypart: Daypart;
	/** null while loading; an error when missing or out of date (fall back). */
	readonly assets: Parsed<OfficeAssets> | null;
	/** Viewer time. */
	readonly now: number;
	/** The viewer turned the office's sound on (the 3D scene plays it; 2D is silent). */
	readonly sound?: boolean;
}
