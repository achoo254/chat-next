// A view that keeps to what the phone keyboard leaves visible: the chat of a
// session (header on top, composer at the bottom) and the terminal (its key
// bar above the keyboard). iOS Safari and the PWA keep the layout viewport
// tall and slide the keyboard over it, so the bottom of a "100%" view sits
// under the keyboard; Android Chrome resizes the page (with
// interactive-widget=resizes-content), and then nothing is hidden. Both are
// read from window.visualViewport (as Orca's web shell does): the view takes
// the visible height and top as CSS variables (--vf-h, --vf-t) and
// data-keyboard while something is hidden; the page itself neither scrolls
// nor bounces meanwhile, and goes back to the top when the keyboard closes
// (iOS leaves it scrolled up). Pinch zoom also shrinks the visual viewport:
// it is not taken for a keyboard.
import { useEffect, useState, type RefObject } from "react";

/** Below this many CSS pixels hidden, it is a toolbar or rounding, not a keyboard. */
export const KEYBOARD_MIN_PX = 80;

export interface ViewportBox {
	/** The visible height and its top, in CSS pixels of the layout viewport. */
	readonly height: number;
	readonly top: number;
	/** How much of the layout viewport the keyboard hides (0 when none, or while zoomed). */
	readonly keyboard: number;
}

type ViewportLike = Pick<VisualViewport, "height" | "offsetTop"> & { readonly scale?: number };

/** What the keyboard hides of a layout viewport `innerHeight` tall. */
export function keyboardOcclusion(viewport: ViewportLike, innerHeight: number): number {
	if ((viewport.scale ?? 1) !== 1) return 0;
	const hidden = Math.round(innerHeight - (viewport.height + viewport.offsetTop));
	return hidden >= KEYBOARD_MIN_PX ? hidden : 0;
}

/** The visible box now; the whole window when the browser has no visualViewport. */
export function viewportBox(): ViewportBox {
	const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
	if (viewport === undefined || viewport === null) return { height: typeof window === "undefined" ? 0 : window.innerHeight, top: 0, keyboard: 0 };
	return { height: Math.round(viewport.height), top: Math.round(viewport.offsetTop), keyboard: keyboardOcclusion(viewport, window.innerHeight) };
}

/** The class on <html> that stops the page scrolling and bouncing while the keyboard is open. */
export const KEYBOARD_OPEN_CLASS = "keyboard-open";

/**
 * Keeps `target` to the visible box while `active` (a phone): sets --vf-h and
 * --vf-t on it, data-keyboard while the keyboard hides something, and
 * returns how much it hides. When the keyboard closes the page scrolls back
 * to the top.
 */
export function useViewportFit(target: RefObject<HTMLElement | null>, active: boolean): number {
	const [keyboard, setKeyboard] = useState(0);
	useEffect(() => {
		const el = target.current;
		const viewport = window.visualViewport;
		if (!active || el === null || viewport === null || viewport === undefined) return;
		let open = false;
		const update = () => {
			const box = viewportBox();
			el.style.setProperty("--vf-h", `${box.height}px`);
			el.style.setProperty("--vf-t", `${box.top}px`);
			const now = box.keyboard > 0;
			if (now) el.setAttribute("data-keyboard", "");
			else el.removeAttribute("data-keyboard");
			document.documentElement.classList.toggle(KEYBOARD_OPEN_CLASS, now);
			// iOS leaves the page scrolled where the keyboard pushed it.
			if (open && !now) window.scrollTo(0, 0);
			open = now;
			setKeyboard(box.keyboard);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			document.documentElement.classList.remove(KEYBOARD_OPEN_CLASS);
			el.removeAttribute("data-keyboard");
		};
	}, [target, active]);
	return keyboard;
}

/** A phone: a narrow screen or a coarse pointer (where the on-screen keyboard is). */
export function isPhone(): boolean {
	return typeof window.matchMedia === "function" && (window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(max-width: 760px)").matches);
}
