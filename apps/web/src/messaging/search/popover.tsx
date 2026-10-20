// A filter popover (mockups/search.html .pop): opens below its chip, takes
// focus, and closes on Esc or a click outside without closing anything
// around it.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

interface PopoverProps {
	id: string;
	label: string;
	className?: string;
	onClose: () => void;
	children: ReactNode;
}

export function Popover({ id, label, className, onClose, children }: PopoverProps) {
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);
	useEffect(() => {
		const box = ref.current;
		// The text field, else the option in use, else the first control.
		const first = box?.querySelector<HTMLElement>("input") ?? box?.querySelector<HTMLElement>("[aria-pressed='true']") ?? box?.querySelector<HTMLElement>("button");
		first?.focus();
		const onDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node) || box === null || box.contains(target)) return;
			// The chip that opened the popover toggles it itself.
			if (target instanceof Element && target.closest(`[aria-controls="${id}"]`) !== null) return;
			closeRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [id]);
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape") return;
		event.preventDefault();
		event.stopPropagation();
		closeRef.current();
	};
	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc pressed on any control inside the popover bubbles here to close it
		<div className={className === undefined ? "sx-pop" : `sx-pop ${className}`} id={id} role="dialog" aria-label={label} ref={ref} onKeyDown={onKeyDown}>
			{children}
		</div>
	);
}
