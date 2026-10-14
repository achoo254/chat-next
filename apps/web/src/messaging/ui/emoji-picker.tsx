// Emoji grid for the composer and the "more reactions" button. The mock has
// the trigger only; the panel reuses the reaction picker look (.react-picker).
import { useEffect, useRef } from "react";
import { useCopy } from "../copy/use-copy.ts";

export const EMOJIS = [
	"👍", "❤️", "😂", "😮", "🙏", "🎉", "😀", "😅",
	"😊", "😍", "🤔", "😢", "😡", "👏", "🙌", "💪",
	"👀", "🔥", "✅", "❌", "⚠️", "🚀", "💯", "👌",
	"🤝", "😴", "🤣", "😎", "🥲", "🙂", "😬", "🤗",
] as const;

interface EmojiPickerProps {
	onPick: (emoji: string) => void;
	onClose: () => void;
}

export function EmojiPicker({ onPick, onClose }: EmojiPickerProps) {
	const copy = useCopy();
	const ref = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	}, [onClose]);

	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
		const onDown = (event: PointerEvent) => {
			if (ref.current !== null && event.target instanceof Node && !ref.current.contains(event.target)) closeRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, []);

	return (
		<div
			ref={ref}
			className="emoji-pop"
			role="group"
			aria-label={copy.emoji.picker}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					closeRef.current();
				}
			}}
		>
			{EMOJIS.map((emoji) => (
				<button key={emoji} type="button" aria-label={emoji} onClick={() => onPick(emoji)}>
					{emoji}
				</button>
			))}
		</div>
	);
}
