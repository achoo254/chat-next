// An e-mail address in a message. Tapping it does not open the mail app at
// once: it opens a small menu (email-menu.tsx, loaded on the first tap) to
// copy the address or write to it.
import { Suspense, lazy, useRef, useState, type ReactNode } from "react";

const EmailMenu = lazy(() => import("./email-menu.tsx"));

/** Gap between the address and the menu below it. */
const GAP_PX = 4;

interface OpenMenu {
	readonly x: number;
	readonly y: number;
	readonly host: HTMLElement;
}

export function EmailEntity({ email, children }: { email: string; children: ReactNode }) {
	"use no memo";
	const [menu, setMenu] = useState<OpenMenu | null>(null);
	const anchor = useRef<HTMLButtonElement>(null);
	// A press on the address while its menu is open closes the menu (outside
	// pointerdown) before the click arrives; that click must not reopen it.
	const pressedWhileOpen = useRef(false);
	const isOpen = menu !== null;

	const open = (target: HTMLButtonElement) => {
		const rect = target.getBoundingClientRect();
		setMenu({ x: rect.left, y: rect.bottom + GAP_PX, host: target.closest("dialog") ?? document.body });
	};
	const close = (done: boolean) => {
		setMenu(null);
		if (done) anchor.current?.focus();
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
			{menu !== null && (
				<Suspense fallback={null}>
					<EmailMenu email={email} x={menu.x} y={menu.y} host={menu.host} onClose={close} />
				</Suspense>
			)}
		</>
	);
}
