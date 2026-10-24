// The menu of an e-mail address in a message (email-entity.tsx), loaded on
// the first tap: copy the address or write to it (a plain mailto: link, as
// mail links open everywhere else in the app). It floats over the page (a
// portal into `host`), is kept inside the window, closes when the page
// scrolls, and works with the keyboard like every PopupMenu: focus on the
// first item, arrows, Esc.
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { copyText } from "./parts.tsx";
import { PopupMenu } from "./popup-menu.tsx";

/** Gap kept between the menu and the edges of the window. */
const EDGE_PX = 8;

export interface EmailMenuProps {
	readonly email: string;
	/** Where the menu opens, in viewport pixels. */
	readonly x: number;
	readonly y: number;
	/** The element the menu is portaled into: the open <dialog>, or the body. */
	readonly host: HTMLElement;
	/** `done`: a choice or Esc, after which focus goes back to the address; otherwise an outside press or a scroll. */
	readonly onClose: (done: boolean) => void;
}

export default function EmailMenu({ email, x, y, host, onClose }: EmailMenuProps) {
	"use no memo";
	const copy = useCopy();
	const { toasts } = useServices();
	const floating = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);

	// Keep the menu inside the window (measured after layout, before paint).
	useLayoutEffect(() => {
		const element = floating.current;
		if (element === null) return;
		const rect = element.getBoundingClientRect();
		element.style.left = `${Math.max(EDGE_PX, Math.min(x, window.innerWidth - rect.width - EDGE_PX))}px`;
		element.style.top = `${Math.max(EDGE_PX, Math.min(y, window.innerHeight - rect.height - EDGE_PX))}px`;
	}, [x, y]);

	// The menu sits at the address on screen; scrolling would leave it behind.
	useEffect(() => {
		const onScroll = () => closeRef.current(false);
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, []);

	const stop = (event: SyntheticEvent) => event.stopPropagation();
	const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onClose(true);
		}
	};
	const copyAddress = () => {
		onClose(true);
		void copyText(email).then((ok) => toasts.show(ok ? copy.message.emailCopied : copy.common.failed));
	};

	return createPortal(
		// React events bubble out of a portal to the message, whose long press and right click open its own
		// menu: the menu's gestures stop here. Esc closes it with focus back on the address.
		<div
			className="entity-menu"
			ref={floating}
			style={{ left: x, top: y }}
			onKeyDownCapture={onKeyDownCapture}
			onContextMenu={stop}
			onTouchStart={stop}
		>
			{/* An outside press closes the menu where the user pressed, without moving focus. */}
			<PopupMenu label={copy.message.emailMenu(email)} onClose={() => onClose(false)}>
				<button type="button" role="menuitem" onClick={copyAddress}>
					<Icon name="copy" />
					{copy.message.copyEmail}
				</button>
				<a role="menuitem" href={`mailto:${email}`} onClick={() => onClose(true)}>
					<Icon name="send" />
					{copy.message.sendMail}
				</a>
			</PopupMenu>
		</div>,
		host,
	);
}
