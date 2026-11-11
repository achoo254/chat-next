// The window a conversation is drawn in: the page itself, or the compact
// (picture-in-picture) window, which has its own document. What depends on
// "is the user looking at this" (marking messages read, the incoming tone)
// reads the visibility of that document, not of the page's.
import { createContext, useContext, useEffect, useState } from "react";

export interface Surface {
	readonly document: Document;
	/** True in the compact window. */
	readonly compact: boolean;
}

const MAIN_SURFACE: Surface = { document, compact: false };

export const SurfaceContext = createContext<Surface>(MAIN_SURFACE);

export function useSurface(): Surface {
	return useContext(SurfaceContext);
}

/** Whether the document this conversation is drawn in is shown (not a background tab or a minimised window). */
export function useSurfaceVisible(): boolean {
	const { document: surfaceDocument } = useSurface();
	const [visible, setVisible] = useState(() => surfaceDocument.visibilityState === "visible");
	useEffect(() => {
		const update = () => setVisible(surfaceDocument.visibilityState === "visible");
		update();
		surfaceDocument.addEventListener("visibilitychange", update);
		return () => surfaceDocument.removeEventListener("visibilitychange", update);
	}, [surfaceDocument]);
	return visible;
}
