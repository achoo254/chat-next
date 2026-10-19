// The bars over the composer (mockups/chat.html#composer-states): replying
// to or editing a message (the quote jumps to it, X or Esc cancels) and the
// link preview of the text being typed (X sends without it). Loaded the first
// time one shows.
import { Icon } from "../../components/screen-icons.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { messagePreview, namedUserIds } from "../data/format.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useChat, useMessage, useServices } from "../data/services.tsx";
import { useNameOf } from "./chat-row.tsx";
import { useIntent } from "./ui-context.tsx";

/** Reply or edit bar over the composer: the quoted message jumps to it, X or Esc cancels. */
export function ComposeBar({ chatId, onCancel }: { chatId: number; onCancel: () => void }) {
	const copy = useScreensCopy();
	const { store } = useServices();
	const intent = useIntent(chatId);
	const target = useMessage(chatId, intent?.seq ?? 0);
	const channel = useChat(chatId)?.type === "channel";
	const nameOf = useNameOf(target == null ? [] : namedUserIds(target));
	if (intent === null) return null;
	const name = target == null ? "" : nameOf(target.fromId);
	const editing = intent.mode === "edit";
	return (
		<div className="compose-bar">
			<Icon name={editing ? "edit" : "reply"} />
			<button type="button" className="cb-text" onClick={() => store.openWindow(chatId, intent.seq)}>
				<b>{editing ? copy.composerBars.editing : copy.composerBars.replyTo(name)}</b>
				<span>{target == null ? "…" : messagePreview(target, nameOf, copy, channel)}</span>
			</button>
			<span className="kbd" aria-hidden="true">
				Esc
			</span>
			<button type="button" className="icon-btn" aria-label={editing ? copy.composerBars.cancelEdit : copy.composerBars.cancelReply} onClick={onCancel}>
				<Icon name="x" />
			</button>
		</div>
	);
}

export function PreviewBar({ preview, onRemove }: { preview: LinkPreview; onRemove: () => void }) {
	const copy = useScreensCopy();
	return (
		<div className="lp-compose">
			<Icon name="link" small />
			<span className="lp-text">
				<b>{preview.site}</b>
				<span>{preview.title}</span>
			</span>
			<button type="button" className="icon-btn" aria-label={copy.composerBars.noPreview} onClick={onRemove}>
				<Icon name="x" small />
			</button>
		</div>
	);
}
