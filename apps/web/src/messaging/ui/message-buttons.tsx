// Buttons under webhook and bot messages (split from message-item.tsx: most
// messages have none).
import type { StoredMessage } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { useServices } from "../data/services.tsx";
import { isAllowedLink, laterLinkOpener, type RichContext } from "./rich-text.tsx";
import { Cell, useCell, useUi } from "./ui-context.tsx";

/** A button as shown: a bot callback or an allowed link. */
type ShownButton =
	| { readonly kind: "callback"; readonly text: string; readonly data: string; readonly key: string }
	| { readonly kind: "url"; readonly text: string; readonly url: string; readonly key: string };

/** Callback buttons waiting for the bot's answer ("chatId:seq:row:column"), across the screen. */
const pressing = new Cell<ReadonlySet<string>>(new Set());

function setPressing(key: string, on: boolean): void {
	const next = new Set(pressing.get());
	if (on) next.add(key);
	else next.delete(key);
	pressing.set(next);
}

/**
 * Buttons under a message (webhooks and bots), row by row. Only links the
 * scheme allowlist accepts are shown; links off the tenant's sites ask
 * before opening, like links in the text. A bot's callback button sends its
 * data to the bot (PressInlineButton) and shows the answer as a toast, or a
 * dialog when the bot asks for one; no answer in 10 seconds reads "Bot không
 * phản hồi".
 */
export default function MessageButtons({ message, ctx }: { message: StoredMessage; ctx: RichContext }) {
	const copy = useCopy();
	const ui = useUi();
	const { bots, toasts } = useServices();
	const waiting = useCell(pressing);
	const { chatId, seq, fromId } = message;
	const rows = message.buttons
		.map((row, rowIndex) =>
			row.flatMap((button, column): ShownButton[] => {
				if (button.callbackData !== undefined) return [{ kind: "callback", text: button.text, data: button.callbackData, key: `${chatId}:${seq}:${rowIndex}:${column}` }];
				if (button.url !== null && isAllowedLink(button.url)) return [{ kind: "url", text: button.text, url: button.url, key: `${rowIndex}:${column}` }];
				return [];
			}),
		)
		.filter((row) => row.length > 0);
	if (rows.length === 0) return null;
	const openLater = laterLinkOpener((url) => ctx.openLink(url));
	const press = (key: string, data: string) => {
		if (pressing.get().has(key)) return;
		setPressing(key, true);
		bots
			.press(chatId, seq, data)
			.then(
				(answer) => {
					if (answer.timedOut) {
						toasts.show(copy.bot.notResponding);
						return;
					}
					if (answer.text !== "") {
						if (answer.showAlert) ui.dialog.set({ kind: "botAlert", botId: fromId, text: answer.text });
						else toasts.show(answer.text);
					}
					if (answer.url !== "") openLater(answer.url);
				},
				() => toasts.show(copy.common.failed),
			)
			.finally(() => setPressing(key, false));
	};
	return (
		<div className="keyboard">
			{rows.map((row, rowIndex) => (
				<div className="kb-row" key={rowIndex}>
					{row.map((button) =>
						button.kind === "callback" ? (
							<button
								key={button.key}
								type="button"
								aria-busy={waiting.has(button.key)}
								onClick={() => press(button.key, button.data)}
							>
								<span>{button.text}</span>
								{waiting.has(button.key) && <span className="sr-only">{copy.bot.waiting}</span>}
							</button>
						) : (
							<a
								key={button.key}
								href={button.url}
								target="_blank"
								rel="noopener noreferrer"
								onClick={(event) => {
									if (button.url.startsWith("mailto:")) return;
									event.preventDefault();
									ctx.openLink(button.url, button.text);
								}}
							>
								<span>{button.text}</span>
								<Icon name="external" small />
								<span className="sr-only">{copy.message.opensExternal}</span>
							</a>
						),
					)}
				</div>
			))}
		</div>
	);
}
