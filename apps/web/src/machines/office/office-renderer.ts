// What a way of drawing the office receives (the 2D view here; the 3D scene
// of apps/web/src/office-3d takes the same). Renderers only read: the store's
// state, everyone's place, the layout, the framing asked for, the light.
import type { Talk } from "./office-conversations.ts";
import type { Parsed } from "./office-json.ts";
import type { OfficeAssets } from "./office-assets.ts";
import type { Daypart } from "./office-daypart.ts";
import type { ScreenSize } from "./office-geometry.ts";
import type { OfficeLayout } from "./office-layout.ts";
import type { Placement } from "./office-placement.ts";
import type { OfficeState } from "./office-store.ts";

export type OfficeFraming = "work" | "overview";

export interface OfficeRendererProps {
	readonly state: OfficeState;
	readonly placements: readonly Placement[];
	/** Residents talking now (office-conversations.ts): who walks to whom, and the lines. */
	readonly talks: readonly Talk[];
	readonly layout: OfficeLayout;
	/**
	 * How much of the plan the viewer asked to see: `work` the work zone (on a portrait phone its six desks), `overview`
	 * the most of the plan the screen may show (the whole plan on a wide screen). A phone opens on `work`, a wide screen
	 * on `overview`. The 3D scene animates the camera when it changes; the viewer's own pan and zoom stay until it does.
	 */
	readonly framing: OfficeFraming;
	readonly size: ScreenSize;
	readonly daypart: Daypart;
	/** null while loading; an error when missing or out of date (fall back). */
	readonly assets: Parsed<OfficeAssets> | null;
	/** Viewer time. */
	readonly now: number;
	/** The viewer turned the office's sound on (the 3D scene plays it; 2D is silent). */
	readonly sound?: boolean;
}
