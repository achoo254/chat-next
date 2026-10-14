// Small building blocks shared by the messaging screens, ported from the
// approved mockups (mock.css: .avatar, .switch, .choice, dialog, .toast).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { initials } from "../../components/avatar.tsx";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { toneOf } from "../data/format.ts";
import type { Tone } from "../data/pending-backend.ts";
import { useServices, useToast } from "../data/services.tsx";

export type AvatarSize = "xs" | "sm" | "md" | "lg";

interface ChatAvatarProps {
	id: number;
	name: string;
	size?: AvatarSize;
	bot?: boolean;
	online?: boolean;
	tone?: Tone;
}

/** Soft avatar with initials (robot icon for bots); colour follows the id. */
export function ChatAvatar({ id, name, size = "md", bot = false, online = false, tone }: ChatAvatarProps) {
	const classes = ["avatar", size === "md" ? "" : size, `av-${tone ?? toneOf(id)}`, online ? "online" : ""];
	return (
		<span className={classes.filter(Boolean).join(" ")} aria-hidden="true">
			{bot ? <Icon name="robot" small={size !== "md" && size !== "lg"} /> : initials(name)}
		</span>
	);
}

interface ModalProps {
	labelledBy: string;
	onClose: () => void;
	className?: string;
	children: ReactNode;
}

/** Modal dialog on the native <dialog>: focus trap, Esc and backdrop from the browser. */
export function Modal({ labelledBy, onClose, className, children }: ModalProps) {
	const ref = useRef<HTMLDialogElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);
	useEffect(() => {
		const dialog = ref.current;
		if (dialog === null) return;
		if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
		else dialog.setAttribute("open", "");
		return () => {
			if (typeof dialog.close === "function" && dialog.open) dialog.close();
		};
	}, []);
	return (
		<dialog
			ref={ref}
			className={className === undefined ? "modal" : `modal ${className}`}
			aria-labelledby={labelledBy}
			onCancel={(event) => {
				event.preventDefault();
				closeRef.current();
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
