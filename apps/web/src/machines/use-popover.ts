// Open state of a small menu that closes on a click outside it or Escape.
import { useEffect, useRef, useState } from "react";

export function usePopover<T extends HTMLElement = HTMLDivElement>() {
	const [open, setOpen] = useState(false);
	const ref = useRef<T>(null);
	useEffect(() => {
		if (!open) return;
		const onDown = (event: PointerEvent) => {
			if (ref.current !== null && !ref.current.contains(event.target as Node)) setOpen(false);
		};
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);
	return { open, setOpen, ref };
}
