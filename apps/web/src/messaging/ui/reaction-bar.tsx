// Zalo-style quick reactions: a short row over a message's emoji button,
// shown while the pointer rests on that button. It loads with the message
// menu's chunk (with its styles and the screens copy for the names) once the
// pointer first reaches an emoji button, so it adds nothing to the start.
import type { StoredMessage } from "@achoo254/chat-core";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { useServices } from "../data/services.tsx";
import "./reaction-bar.css";

export default function ReactionBar({ chatId, seq, reactions }: { chatId: number; seq: number; reactions: StoredMessage["reactions"] }) {
	"use no memo";
	const chosen = reactions.find((reaction) => reaction.chosen)?.emoji;
	const copy = useScreensCopy();
	const names = copy.menu.reactionNames;
	const { remote, toasts } = useServices();
	const react = (emoji: string) => {
		remote.setReaction(chatId, seq, chosen === emoji ? "" : emoji).catch(() => toasts.show(copy.common.failed));
	};
	return (
		<div className="react-bar" role="group" aria-label={copy.menu.quickReactions}>
			{Object.keys(names).map((emoji) => (
				<button
					key={emoji}
					type="button"
					tabIndex={-1}
					aria-label={names[emoji] ?? emoji}
					aria-pressed={chosen === emoji}
					title={names[emoji] ?? emoji}
					onClick={() => react(emoji)}
				>
					{emoji}
				</button>
			))}
		</div>
	);
}
