// Where the open Mini App shows on the chat screen (mockups/bots.html#mini-app,
// #mini-app-minimized, mobile.html#mini-app). The container sits in the app
// grid in the info column's place (mini-app.css: an overlay like that column
// below 1100px, full screen when narrow). Minimized, a chip brings it back:
// at the top of the conversation on wide screens, a pill floating just above
// the composer when narrow, or a pill floating on the screen when no
// conversation shows. Both come with the Mini App's code, loaded on first use.
import { Suspense, lazy, useSyncExternalStore } from "react";
import { useCell, useUi, type Ui } from "./ui-context.tsx";

const MiniApp = lazy(() => import("../bots/mini-app.tsx"));
const MiniAppChip = lazy(() => import("../bots/mini-app.tsx").then((m) => ({ default: m.MiniAppChip })));

const NARROW_QUERY = "(max-width: 760px)";

function isNarrow(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

function subscribeNarrow(listener: () => void): () => void {
	if (typeof window.matchMedia !== "function") return () => undefined;
	const media = window.matchMedia(NARROW_QUERY);
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}

/** The open Mini App's container; stays mounted while minimized so its frame keeps running. */
export function MiniAppLayer({ ui }: { ui: Ui }) {
	"use no memo";
	const open = useCell(ui.miniApp);
	if (open === null) return null;
	return (
		<Suspense fallback={null}>
			<MiniApp key={open.request.id} request={open.request} minimized={open.minimized} />
		</Suspense>
	);
}

/**
 * A place for the minimized Mini App's chip: "top" of a conversation (wide
 * screens), "bar" just above its composer (narrow), or "screen" while no
 * conversation shows. Each renders only where it applies, so one chip shows.
 */
export function MiniAppChipSlot({ place }: { place: "top" | "bar" | "screen" }) {
	"use no memo";
	const ui = useUi();
	const open = useCell(ui.miniApp);
	const narrow = useSyncExternalStore(subscribeNarrow, isNarrow);
	if (open === null || !open.minimized) return null;
	if ((place === "top" && narrow) || (place === "bar" && !narrow)) return null;
	const chip = (
		<Suspense fallback={null}>
			<MiniAppChip request={open.request} floating={place !== "top"} />
		</Suspense>
	);
	// A box of no height between the messages and the composer: the pill floats above it, never over the send button.
	return place === "bar" ? <div className="ma-pill-dock">{chip}</div> : chip;
}
