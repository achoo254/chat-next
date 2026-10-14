// Composer (R1: text, emoji, reply, edit; attachments arrive with R3).
// Enter sends, Shift+Enter breaks the line, Esc cancels reply or edit.
// Sending is optimistic: the core shows the message at once with a clock.
import { Suspense, lazy, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { codePointLength } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useCopy } from "../copy/use-copy.ts";
import { messagePreview, userName } from "../data/format.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useConnection, useMessage, useServices, useUser } from "../data/services.tsx";
import { useIntent, useUi } from "./ui-context.tsx";

const EmojiPicker = lazy(() => import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })));

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

function IntentBar({ chatId, onCancel }: { chatId: number; onCancel: () => void }) {
	const copy = useCopy();
	const { store } = useServices();
	const intent = useIntent(chatId);
	const target = useMessage(chatId, intent?.seq ?? 0);
	const author = useUser(target != null && target.fromId !== store.selfId ? target.fromId : 0);
	if (intent === null) return null;
	const nameOf = (id: number) => userName(store.user(id), store.selfId, copy, id);
	const name = target == null ? "" : target.fromId === store.selfId ? copy.common.you : (author?.name ?? copy.message.unknownUser);
	const editing = intent.mode === "edit";
	return (
		<div className="lp-compose intent">
			<Icon name={editing ? "edit" : "reply"} small />
			<span className="lp-text">
				<b>{editing ? copy.composer.editing : copy.composer.replyTo(name)}</b>
				<span>{target == null ? "…" : messagePreview(target, nameOf, copy)}</span>
			</span>
			<button
				type="button"
				className="icon-btn"
				aria-label={editing ? copy.composer.cancelEdit : copy.composer.cancelReply}
				onClick={onCancel}
			>
				<Icon name="x" small />
			</button>
		</div>
	);
}

function PreviewBar({ preview, onRemove }: { preview: LinkPreview; onRemove: () => void }) {
	const copy = useCopy();
	return (
		<div className="lp-compose">
			<Icon name="link" small />
			<span className="lp-text">
				<b>{preview.site}</b>
				<span>{preview.title}</span>
			</span>
			<button type="button" className="icon-btn" aria-label={copy.composer.noPreview} onClick={onRemove}>
				<Icon name="x" small />
			</button>
		</div>
	);
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
		try {
			if (current?.mode === "edit") {
				await source.editText(chatId, current.seq, value);
				setText(drafts.get(chatId, topicId));
			} else {
				const replyToSeq = current?.mode === "reply" ? current.seq : 0;
				setText("");
				drafts.set(chatId, "", topicId);
				if (topicId !== 0) await backend.sendToTopic(chatId, topicId, value, replyToSeq);
				else await source.sendText(chatId, value, replyToSeq === 0 ? {} : { replyToSeq });
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
			cancelIntent();
			return;
		}
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			void submit();
		}
	};

	const insertEmoji = (emoji: string) => {
		const element = area.current;
		const start = element?.selectionStart ?? text.length;
		const end = element?.selectionEnd ?? text.length;
		caret.current = start + emoji.length;
		update(text.slice(0, start) + emoji + text.slice(end));
		setPicker(false);
		element?.focus();
	};

	const offline = connection === "offline" || connection === "waiting";
	const label = channel ? copy.composer.channelLabel : copy.composer.label;
	const shownPlaceholder = offline && !disabled ? copy.composer.placeholderOffline : placeholder;
	const empty = text.trim() === "";
	return (
		<div className="composer-wrap">
			{(intent !== null || shownPreview !== null) && (
				<div className="compose-extras">
					<IntentBar chatId={chatId} onCancel={cancelIntent} />
					{shownPreview !== null && intent?.mode !== "edit" && (
						<PreviewBar
							preview={shownPreview}
							onRemove={() => {
								setDismissed(url);
								toasts.show(copy.composer.noPreviewDone);
							}}
						/>
					)}
				</div>
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
						type="button"
						className="icon-btn"
						aria-label={copy.composer.emoji}
						aria-expanded={picker}
						disabled={disabled}
						onClick={() => setPicker((open) => !open)}
					>
						<Icon name="smile" />
					</button>
					{picker && (
						<Suspense fallback={null}>
							<EmojiPicker onPick={insertEmoji} onClose={() => setPicker(false)} />
						</Suspense>
					)}
				</div>
				<button type="submit" className="send" aria-label={channel ? copy.composer.post : copy.composer.send} disabled={empty || disabled}>
					<Icon name="send" />
				</button>
			</form>
		</div>
	);
}
