// Composer (R1: text, emoji, reply, edit; attachments arrive with R3).
// Enter sends, Shift+Enter breaks the line, Esc cancels reply or edit
// (mockups/chat.html#composer-states). Sending is optimistic: the core shows
// the message at once with a clock. Dropping the link preview sends the
// message with no_link_preview, so the server attaches none.
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { codePointLength } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useConnection, useMessage, useServices } from "../data/services.tsx";
import { useIntent, useUi } from "./ui-context.tsx";

const EmojiPicker = lazy(() => import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })));
// The reply/edit and link preview bars load the first time one shows.
const bars = () => import("./composer-bars.tsx");
const ComposeBar = lazy(() => bars().then((m) => ({ default: m.ComposeBar })));
const PreviewBar = lazy(() => bars().then((m) => ({ default: m.PreviewBar })));

const MAX_HEIGHT_PX = 160;
const PREVIEW_DELAY_MS = 400;
const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/i;

interface ComposerProps {
	chatId: number;
	topicId: number;
	/** Channel admins post instead of sending. */
	channel: boolean;
	placeholder: string;
	disabled?: boolean;
}

export function Composer({ chatId, topicId, channel, placeholder, disabled = false }: ComposerProps) {
	const copy = useCopy();
	const { source, remote, backend, drafts, toasts } = useServices();
	const ui = useUi();
	const connection = useConnection();
	const intent = useIntent(chatId);
	const editTarget = useMessage(chatId, intent?.mode === "edit" ? intent.seq : 0);
	const [text, setText] = useState(() => drafts.get(chatId, topicId));
	const [picker, setPicker] = useState(false);
	const [preview, setPreview] = useState<LinkPreview | null>(null);
	const [dismissed, setDismissed] = useState("");
	const [error, setError] = useState("");
	const [editingSeq, setEditingSeq] = useState(0);
	const area = useRef<HTMLTextAreaElement>(null);
	const caret = useRef<number | null>(null);

	// Starting an edit loads the message text; leaving it brings the draft back.
	if (intent?.mode === "edit" && editTarget != null && editingSeq !== intent.seq) {
		setEditingSeq(intent.seq);
		setText(editTarget.text);
	} else if (intent?.mode !== "edit" && editingSeq !== 0) {
		setEditingSeq(0);
		setText(drafts.get(chatId, topicId));
	}

	useEffect(() => {
		if (intent !== null) area.current?.focus();
	}, [intent]);

	useLayoutEffect(() => {
		const element = area.current;
		if (element === null) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
		if (caret.current !== null) {
			element.setSelectionRange(caret.current, caret.current);
			caret.current = null;
		}
	}, [text]);

	const url = backend.features.has("linkPreview") ? (URL_IN_TEXT.exec(text)?.[0] ?? "") : "";
	useEffect(() => {
		if (url === "" || url === dismissed) return;
		let active = true;
		const timer = setTimeout(() => {
			backend.composePreview(url).then(
				(found) => {
					if (active) setPreview(found);
				},
				() => {
					if (active) setPreview(null);
				},
			);
		}, PREVIEW_DELAY_MS);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [backend, url, dismissed]);
	const shownPreview = preview !== null && url !== "" && url !== dismissed && preview.url === url ? preview : null;

	const update = (value: string) => {
		setText(value);
		setError("");
		if (intent?.mode !== "edit") drafts.set(chatId, value, topicId);
	};

	const cancelIntent = () => {
		ui.intents.cell(chatId).set(null);
	};

	// X or Esc: the composer keeps focus and says what happened.
	const cancelByUser = () => {
		if (intent === null) return;
		toasts.show(intent.mode === "edit" ? copy.composer.editCancelled : copy.composer.replyCancelled);
		cancelIntent();
		area.current?.focus();
	};

	const submit = async (event?: FormEvent) => {
		event?.preventDefault();
		const value = text.trim();
		if (value === "" || disabled) return;
		const limits = await remote.limits().catch(() => ({ messageLengthMax: 0 }));
		if (limits.messageLengthMax > 0 && codePointLength(value) > limits.messageLengthMax) {
			setError(copy.composer.tooLong(limits.messageLengthMax));
			return;
		}
		const current = intent;
		const noLinkPreview = url !== "" && url === dismissed;
		try {
			if (current?.mode === "edit") {
				await source.editText(chatId, current.seq, value);
				setText(drafts.get(chatId, topicId));
			} else {
				const replyToSeq = current?.mode === "reply" ? current.seq : 0;
				setText("");
				drafts.set(chatId, "", topicId);
				if (topicId !== 0) await backend.sendToTopic(chatId, topicId, value, replyToSeq, noLinkPreview);
				else await source.sendText(chatId, value, { ...(replyToSeq === 0 ? {} : { replyToSeq }), ...(noLinkPreview ? { noLinkPreview } : {}) });
			}
			cancelIntent();
			setPreview(null);
			setDismissed("");
		} catch {
			if (current?.mode !== "edit") {
				setText(value);
				drafts.set(chatId, value, topicId);
			}
			toasts.show(copy.composer.sendFailed);
		}
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape" && intent !== null) {
			event.preventDefault();
			cancelByUser();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	};

	// The picker stays open to pick more; each emoji goes in at the caret.
	const insertEmoji = (emoji: string) => {
		const element = area.current;
		const start = element?.selectionStart ?? text.length;
		const end = element?.selectionEnd ?? text.length;
		caret.current = start + emoji.length;
		update(text.slice(0, start) + emoji + text.slice(end));
	};
	const emojiButton = useRef<HTMLButtonElement>(null);
	const closePicker = () => {
		setPicker(false);
		emojiButton.current?.focus();
	};

	const offline = connection === "offline" || connection === "waiting";
	const label = channel ? copy.composer.channelLabel : copy.composer.label;
	const shownPlaceholder = offline && !disabled ? copy.composer.placeholderOffline : placeholder;
	const empty = text.trim() === "";
	const editing = intent?.mode === "edit";
	return (
		<div className="composer-wrap">
			{shownPreview !== null && !editing && (
				<div className="compose-extras">
					<Suspense fallback={null}>
						<PreviewBar
							preview={shownPreview}
							onRemove={() => {
								setDismissed(url);
								toasts.show(copy.composer.noPreviewDone);
								// The bar goes away with its button: keep typing where you were.
								area.current?.focus();
							}}
						/>
					</Suspense>
				</div>
			)}
			{intent !== null && (
				<Suspense fallback={null}>
					<ComposeBar chatId={chatId} onCancel={cancelByUser} />
				</Suspense>
			)}
			{error !== "" && (
				<div className="composer-error" role="alert">
					{error}
				</div>
			)}
			<form className="composer" onSubmit={(event) => void submit(event)}>
				<label className="sr-only" htmlFor={`draft-${chatId}-${topicId}`}>
					{label}
				</label>
				<textarea
					ref={area}
					id={`draft-${chatId}-${topicId}`}
					rows={1}
					placeholder={shownPlaceholder}
					value={text}
					disabled={disabled}
					onChange={(event: ChangeEvent<HTMLTextAreaElement>) => update(event.target.value)}
					onKeyDown={onKeyDown}
					aria-invalid={error !== ""}
				/>
				<div className="emoji-anchor">
					<button
						ref={emojiButton}
						type="button"
						className="icon-btn"
						aria-label={copy.composer.emoji}
						aria-expanded={picker}
						aria-pressed={picker}
						disabled={disabled}
						onClick={() => setPicker((open) => !open)}
					>
						<Icon name="smile" />
					</button>
					{picker && (
						<Suspense fallback={null}>
							<EmojiPicker mode="insert" onPick={insertEmoji} onClose={closePicker} />
						</Suspense>
					)}
				</div>
				<button
					type="submit"
					className="send"
					aria-label={editing ? copy.composer.save : channel ? copy.composer.post : copy.composer.send}
					disabled={empty || disabled}
				>
					<Icon name={editing ? "check" : "send"} />
				</button>
			</form>
		</div>
	);
}
