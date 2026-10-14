// The bars over the composer (mockups/chat.html#composer-states): replying
// to or editing a message (the quote jumps to it, X or Esc cancels) and the
// link preview of the text being typed (X sends without it). Loaded the first
// time one shows.
import { Icon } from "../../components/icon.tsx";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import { messagePreview, userName } from "../data/format.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useMessage, useServices, useUser } from "../data/services.tsx";
import { useIntent } from "./ui-context.tsx";

/** Reply or edit bar over the composer: the quoted message jumps to it, X or Esc cancels. */
export function ComposeBar({ chatId, onCancel }: { chatId: number; onCancel: () => void }) {
	const copy = useScreensCopy();
	const { store } = useServices();
	const intent = useIntent(chatId);
	const target = useMessage(chatId, intent?.seq ?? 0);
	const author = useUser(target != null && target.fromId !== store.selfId ? target.fromId : 0);
	if (intent === null) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	const name = target == null ? "" : target.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser);
	const editing = intent.mode === "edit";
	return (
		<div className="compose-bar">
			<Icon name={editing ? "edit" : "reply"} />
			<button type="button" className="cb-text" onClick={() => store.openWindow(chatId, intent.seq)}>
				<b>{editing ? copy.composerBars.editing : copy.composerBars.replyTo(name)}</b>
				<span>{target == null ? "…" : messagePreview(target, nameOf, copy)}</span>
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
