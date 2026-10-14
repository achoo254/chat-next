// A small action menu (mockups: .menu with role="menu"): focus moves to the
// first item, arrow keys move between items, Esc or a click outside closes
// it. Used by the topic, member and chat list row menus.
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";

interface PopupMenuProps {
	label: string;
	className?: string;
	style?: CSSProperties;
	/** Clicks inside this element do not close the menu (a submenu next to it). */
	boundary?: RefObject<HTMLElement | null>;
	onClose: () => void;
	children: ReactNode;
}

export function PopupMenu({ label, className, style, boundary, onClose, children }: PopupMenuProps) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
		const onDown = (event: PointerEvent) => {
			const inside = boundary?.current ?? ref.current;
			if (inside !== null && event.target instanceof Node && !inside.contains(event.target)) closeRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [boundary]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			// Keeps an enclosing dialog open: Esc closes only the menu.
			event.preventDefault();
			event.stopPropagation();
			closeRef.current();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
		const index = items.findIndex((item) => item === document.activeElement);
		items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
	};
	return (
		<div className={className === undefined ? "menu" : `menu ${className}`} role="menu" ref={ref} aria-label={label} style={style} onKeyDown={onKeyDown}>
			{children}
		</div>
	);
}
