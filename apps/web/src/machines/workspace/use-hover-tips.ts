import { useEffect, type RefObject } from "react";

/** How long the pointer rests on a button before its tip shows. */
const SHOW_DELAY_MS = 300;
/** Space kept between the tip and the button, and between the tip and the window edge. */
const GAP_PX = 6;

/** The element whose `title` explains a button: the button itself, or a wrapper
 *  around a disabled one (a disabled button gets no pointer events). */
function tipTarget(from: EventTarget | null, root: HTMLElement): HTMLElement | null {
	if (!(from instanceof Element)) return null;
	const el = from.closest<HTMLElement>("[title]");
	if (el === null || !root.contains(el)) return null;
	const explainsButton = el.matches("button") || el.querySelector(":scope > button") !== null;
	return explainsButton && el.title.trim() !== "" ? el : null;
}

/**
 * Shows each button's `title` as a quick tooltip inside `root`. The browser's own
 * tooltip waits about a second and is easy to miss, which left the icon-only
 * buttons unexplained. The tip is fixed to the window, so no scrolling area clips
 * it, and it also shows on keyboard focus. While shown, the `title` is parked in
 * `data-tip` so the browser's tooltip does not show on top of it.
 */
export function useHoverTips(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const host = root.current;
		if (host === null) return;
		const tip = document.createElement("div");
		tip.className = "ws-tip";
		tip.setAttribute("aria-hidden", "true");
		let current: HTMLElement | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const place = (el: HTMLElement) => {
			const box = el.getBoundingClientRect();
			const own = tip.getBoundingClientRect();
			const maxLeft = window.innerWidth - own.width - GAP_PX;
			const left = Math.max(GAP_PX, Math.min(box.left + box.width / 2 - own.width / 2, maxLeft));
			const below = box.bottom + GAP_PX;
			const top = below + own.height <= window.innerHeight - GAP_PX ? below : box.top - own.height - GAP_PX;
			tip.style.left = `${left}px`;
			tip.style.top = `${Math.max(GAP_PX, top)}px`;
		};
		const hide = () => {
			clearTimeout(timer);
			if (current !== null) {
				const text = current.dataset.tip;
				if (text !== undefined && current.title === "") current.title = text;
				delete current.dataset.tip;
				current = null;
			}
			tip.remove();
		};
		const show = (el: HTMLElement, delay: number) => {
			if (el === current) return;
			hide();
			current = el;
			el.dataset.tip = el.title;
			el.title = "";
			timer = setTimeout(() => {
				tip.textContent = el.dataset.tip ?? "";
				document.body.append(tip);
				place(el);
			}, delay);
		};

		const onOver = (event: PointerEvent) => {
			if (event.pointerType === "touch") return;
			const el = tipTarget(event.target, host);
			if (el !== null) show(el, SHOW_DELAY_MS);
		};
		const onOut = (event: PointerEvent) => {
			if (current !== null && !(event.relatedTarget instanceof Node && current.contains(event.relatedTarget))) hide();
		};
		const onFocus = (event: FocusEvent) => {
			const el = event.target instanceof HTMLElement && event.target.matches(":focus-visible") ? tipTarget(event.target, host) : null;
			if (el !== null) show(el, 0);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") hide();
		};

		host.addEventListener("pointerover", onOver);
		host.addEventListener("pointerout", onOut);
		host.addEventListener("pointerdown", hide);
		host.addEventListener("focusin", onFocus);
		host.addEventListener("focusout", hide);
		host.addEventListener("keydown", onKey);
		window.addEventListener("scroll", hide, true);
		window.addEventListener("resize", hide);
		return () => {
			hide();
			host.removeEventListener("pointerover", onOver);
			host.removeEventListener("pointerout", onOut);
			host.removeEventListener("pointerdown", hide);
			host.removeEventListener("focusin", onFocus);
			host.removeEventListener("focusout", hide);
			host.removeEventListener("keydown", onKey);
			window.removeEventListener("scroll", hide, true);
			window.removeEventListener("resize", hide);
		};
	}, [root]);
}
