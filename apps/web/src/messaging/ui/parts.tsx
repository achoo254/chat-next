// Small building blocks shared by the messaging screens, ported from the
// approved mockups (mock.css: .avatar, .switch, .choice, dialog, .toast).
// The small leaf components skip the compiler's memoization ("use no memo"):
// they are cheap to render, and memoizing them only grows the startup bundle.
import type { Chat, User } from "@app/core";
import { lazy, Suspense, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { initials } from "../../components/avatar.tsx";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { toneOf } from "../data/format.ts";
import type { Tone } from "../data/pending-backend.ts";
import { useServices, useToast } from "../data/services.tsx";

const AvatarPhoto = lazy(() => import("./avatar-photo.tsx"));

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface ChatAvatarProps {
	id: number;
	name: string;
	size?: AvatarSize;
	bot?: boolean;
	/** The user's chat with themselves: a cloud instead of initials. */
	saved?: boolean;
	online?: boolean;
	tone?: Tone;
	/** The user whose profile photo to show (the peer of a private chat) and its file_id (User.photoId); "" for none. */
	photoOf?: number;
	/** A group or channel whose photo to show, with photoId its Chat.photoId; instead of photoOf. */
	chatPhotoOf?: number;
	photoId?: string | undefined;
}

/** The photo props of a chat's avatar: a group's or channel's own photo, the peer's for a private chat, none for the saved chat. */
export function chatPhoto(chat: Pick<Chat, "id" | "type" | "peerUserId" | "photoId">, peer: Pick<User, "photoId"> | null | undefined, saved = false): Pick<ChatAvatarProps, "photoOf" | "chatPhotoOf" | "photoId"> {
	if (saved) return {};
	if (chat.type === "group" || chat.type === "channel") return { chatPhotoOf: chat.id, photoId: chat.photoId ?? "" };
	return { photoOf: chat.peerUserId, photoId: peer?.photoId ?? "" };
}

/** Soft avatar with initials (robot icon for bots, cloud for the saved chat); colour follows the id. */
export function ChatAvatar({ id, name, size = "md", bot = false, saved = false, online = false, tone, photoOf = 0, chatPhotoOf = 0, photoId = "" }: ChatAvatarProps) {
	"use no memo";
	const classes = ["avatar", size === "md" ? "" : size, `av-${tone ?? (saved ? "blue" : toneOf(id))}`, online ? "online" : ""];
	const small = size === "xs" || size === "sm";
	let face: ReactNode = initials(name);
	if (saved) face = <Icon name="cloud" small={small} />;
	else if (bot) face = <Icon name="robot" small={small} />;
	return (
		<span className={classes.filter(Boolean).join(" ")} aria-hidden="true">
			{face}
			{photoId !== "" && (photoOf !== 0 || chatPhotoOf !== 0) && (
				<Suspense fallback={null}>
					<AvatarPhoto
						of={chatPhotoOf !== 0 ? { chat: chatPhotoOf } : { user: photoOf }}
						fileId={photoId}
						large={size === "lg" || size === "xl"}
					/>
				</Suspense>
			)}
		</span>
	);
}

interface ModalProps {
	labelledBy: string;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}

/** Open modals, the topmost last: Esc closes only the topmost one. */
const openModals: HTMLDialogElement[] = [];
/**
 * Where focus goes once no modal is open: the control that opened the first
 * of a chain of dialogs. A dialog opened while focus is nowhere (the member
 * list coming back after its removal confirm) keeps the target of the one
 * it replaced.
 */
let returnFocusTo: HTMLElement | null = null;

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog on the native <dialog>: focus trap and backdrop from the
 * browser. Esc is handled here rather than left to the browser, whose close
 * request may skip the cancel event (a dialog opened without a user gesture,
 * as after a confirm's request finished) and close the element behind
 * React's back. Focus moves into the dialog when it opens and back to the
 * opener when the last one closes.
 */
export function Modal({ labelledBy, onClose, className, children }: ModalProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);
	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body && active.closest("dialog") === null) {
			returnFocusTo = active;
		}
		if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
		else dialog.setAttribute("open", "");
		openModals.push(dialog);
		if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
		const onKey = (event: KeyboardEvent) => {
			// Menus and pickers inside the dialog take Esc first (they prevent it).
			if (event.key !== "Escape" || event.defaultPrevented || openModals[openModals.length - 1] !== dialog) return;
			event.preventDefault();
			closeRef.current();
		};
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("keydown", onKey);
			openModals.splice(openModals.indexOf(dialog), 1);
			if (typeof dialog.close === "function" && dialog.open) dialog.close();
			// Another dialog may open in the same commit; restore only when none did.
			queueMicrotask(() => {
				if (openModals.length > 0) return;
				const target = returnFocusTo;
				const focus = document.activeElement;
				const lost = focus === null || focus === document.body || !focus.isConnected;
				if (target !== null && target.isConnected && lost) target.focus();
			});
		};
	}, []);
	return (
		<dialog
			ref={ref}
			tabIndex={-1}
			className={className === undefined ? "modal" : `modal ${className}`}
			aria-labelledby={labelledBy}
			onCancel={(event) => {
				event.preventDefault();
				closeRef.current();
			}}
			onClose={() => {
				// Closed by the browser without a cancel event: keep React in step.
				// A close event queued by an earlier cleanup (StrictMode mounts
				// effects twice) arrives while the dialog is open again: ignore it.
				const dialog = ref.current;
				if (dialog !== null && !dialog.open && openModals.includes(dialog)) closeRef.current();
			}}
			onClick={(event) => {
				// A click on the backdrop lands on the <dialog> element itself.
				if (event.target === ref.current) closeRef.current();
			}}
		>
			{children}
		</dialog>
	);
}

interface DialogHeadProps {
	id: string;
	title: string;
	onClose?: () => void;
	onBack?: () => void;
	/** Name of the back button when "Quay lại" is not specific enough. */
	backLabel?: string;
	step?: string;
}

export function DialogHead({ id, title, onClose, onBack, backLabel, step }: DialogHeadProps) {
	"use no memo";
	const copy = useCopy();
	return (
		<div className="dlg-head">
			{onBack !== undefined && (
				<button type="button" className="icon-btn" aria-label={backLabel ?? copy.common.back} onClick={onBack}>
					<Icon name="back" />
				</button>
			)}
			<h2 id={id}>{title}</h2>
			{step !== undefined && <span className="step">{step}</span>}
			{onClose !== undefined && (
				<button type="button" className="icon-btn" aria-label={copy.common.close} onClick={onClose}>
					<Icon name="x" />
				</button>
			)}
		</div>
	);
}

interface SwitchProps {
	checked: boolean;
	label: string;
	onChange?: (checked: boolean) => void;
	disabled?: boolean;
	describedBy?: string;
}

export function Switch({ checked, label, onChange, disabled = false, describedBy }: SwitchProps) {
	"use no memo";
	return (
		<button
			type="button"
			className="switch"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			aria-describedby={describedBy}
			disabled={disabled}
			onClick={() => onChange?.(!checked)}
		/>
	);
}

interface ChoiceProps<T extends string> {
	label: string;
	value: T;
	options: readonly { value: T; label: string }[];
	onChange: (value: T) => void;
	disabled?: boolean;
}

/** Segmented choice (mockups: .choice with aria-pressed buttons). */
export function Choice<T extends string>({ label, value, options, onChange, disabled = false }: ChoiceProps<T>) {
	"use no memo";
	return (
		<div className="choice" role="group" aria-label={label}>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					aria-pressed={option.value === value}
					disabled={disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

/** Writes to the clipboard; false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

interface CopyButtonProps {
	text: string;
	label: string;
	copiedLabel: string;
	small?: boolean;
}

/** Icon button that copies `text`; the icon turns into a tick for a moment. */
export function CopyButton({ text, label, copiedLabel, small = false }: CopyButtonProps) {
	const { toasts } = useServices();
	const copy = useCopy();
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className="icon-btn"
			aria-label={copied ? copiedLabel : label}
			onClick={() => {
				void copyText(text).then((ok) => {
					if (ok) {
						setCopied(true);
						toasts.show(copiedLabel);
					} else toasts.show(copy.common.failed);
				});
			}}
		>
			<Icon name={copied ? "check" : "copy"} small={small} />
		</button>
	);
}

/** Bottom toast, announced politely to screen readers. */
export function Toast() {
	const text = useToast();
	return (
		<div className={text === "" ? "toast" : "toast show"} role="status" aria-live="polite">
			{text}
		</div>
	);
}

/** Stable id for label/aria pairs. */
export function useDomId(prefix: string): string {
	return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
