// An e-mail address in a message. Tapping it does not open the mail app at
// once: a small menu offers to copy the address or to write to it (a plain
// mailto: link, as mail links open everywhere else in the app). The menu
// floats over the page (a portal, inside the open <dialog> when there is
// one, so it stays above it), is kept inside the window, closes when the
// page scrolls, and works with the keyboard like every PopupMenu: focus on
// the first item, arrows, Esc back to the address.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { copyText } from "./parts.tsx";
import { PopupMenu } from "./popup-menu.tsx";

/** Gap kept between the menu and the edges of the window, and below the address. */
const EDGE_PX = 8;
const GAP_PX = 4;

interface OpenMenu {
	readonly x: number;
	readonly y: number;
	readonly host: HTMLElement;
}

export function EmailEntity({ email, children }: { email: string; children: ReactNode }) {
	"use no memo";
	const copy = useCopy();
	const { toasts } = useServices();
	const [menu, setMenu] = useState<OpenMenu | null>(null);
	const anchor = useRef<HTMLButtonElement>(null);
	const floating = useRef<HTMLDivElement>(null);
	// A press on the address while its menu is open closes the menu (outside
	// pointerdown) before the click arrives; that click must not reopen it.
	const pressedWhileOpen = useRef(false);

	// Keep the menu inside the window (measured after layout, before paint).
	useLayoutEffect(() => {
		const element = floating.current;
		if (menu === null || element === null) return;
		const rect = element.getBoundingClientRect();
		element.style.left = `${Math.max(EDGE_PX, Math.min(menu.x, window.innerWidth - rect.width - EDGE_PX))}px`;
		element.style.top = `${Math.max(EDGE_PX, Math.min(menu.y, window.innerHeight - rect.height - EDGE_PX))}px`;
	}, [menu]);

	// The menu sits at the address on screen; scrolling would leave it behind.
	const isOpen = menu !== null;
	useEffect(() => {
		if (!isOpen) return;
		const onScroll = () => setMenu(null);
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, [isOpen]);

	const open = (target: HTMLButtonElement) => {
		const rect = target.getBoundingClientRect();
		const host = target.closest("dialog") ?? document.body;
		setMenu({ x: rect.left, y: rect.bottom + GAP_PX, host });
	};
	/** Closes the menu after a choice or Esc, with focus back on the address. */
	const done = () => {
		setMenu(null);
		anchor.current?.focus();
	};
	const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") anchor.current?.focus();
	};
	const stop = (event: SyntheticEvent) => event.stopPropagation();
	const copyAddress = () => {
		done();
		void copyText(email).then((ok) => toasts.show(ok ? copy.message.emailCopied : copy.common.failed));
	};

	return (
		<>
			<button
				ref={anchor}
				type="button"
				className="entity"
				aria-haspopup="menu"
				aria-expanded={isOpen}
				onPointerDown={() => {
					pressedWhileOpen.current = isOpen;
				}}
				onClick={(event) => {
					if (pressedWhileOpen.current) pressedWhileOpen.current = false;
					else open(event.currentTarget);
				}}
			>
				{children}
			</button>
			{menu !== null &&
				createPortal(
					// React events bubble out of a portal to the message, whose long press and right click open its own
					// menu: the menu's gestures stop here. Esc on its way to the menu puts focus back on the address.
					<div
						className="entity-menu"
						ref={floating}
						style={{ left: menu.x, top: menu.y }}
						onKeyDownCapture={onKeyDownCapture}
						onContextMenu={stop}
						onTouchStart={stop}
					>
						{/* An outside press closes the menu where the user pressed, without moving focus. */}
						<PopupMenu label={copy.message.emailMenu(email)} onClose={() => setMenu(null)}>
							<button type="button" role="menuitem" onClick={copyAddress}>
								<Icon name="copy" />
								{copy.message.copyEmail}
							</button>
							<a role="menuitem" href={`mailto:${email}`} onClick={done}>
								<Icon name="send" />
								{copy.message.sendMail}
							</a>
						</PopupMenu>
					</div>,
					menu.host,
				)}
		</>
	);
}
