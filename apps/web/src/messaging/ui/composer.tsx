// Composer: text, emoji, reply, edit, and (R3) files and voice messages.
// Enter sends, Shift+Enter breaks the line, Esc cancels reply or edit, ↑ in
// an empty composer edits your last message (mockups/chat.html#composer-states,
// settings.html#shortcuts). The placeholder says where the message goes; the
// key hint under it shows until the first message sent on this device.
// Sending is optimistic: the core shows the message at once with a clock.
// Dropping the link preview sends the message with no_link_preview, so the
// server attaches none. The paper clip (shown when the server takes media)
// picks photos and videos or any file; pasted images and files dropped on
// the chat join them in the tray above the text, which becomes the caption
// (mockups/media.html#attach). With nothing typed the send button turns
// into the microphone, which records a voice message.
import {
	Suspense,
	lazy,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ChangeEvent,
	type ClipboardEvent,
	type FormEvent,
	type KeyboardEvent,
} from "react";
import { codePointLength } from "@app/core";
import { Icon } from "../../components/icon.tsx";
import { useI18n } from "../../i18n/i18n.tsx";
import { useCopy } from "../copy/use-copy.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useConnection, useMediaLimits, useMessage, useServices } from "../data/services.tsx";
import { addAttachments, attachments, sendAsFiles } from "../media/media-state.ts";
import { PopupMenu } from "./popup-menu.tsx";
import { useCell, useIntent, useUi } from "./ui-context.tsx";

const EmojiPicker = lazy(() => import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })));
// The reply/edit and link preview bars load the first time one shows.
const bars = () => import("./composer-bars.tsx");
const ComposeBar = lazy(() => bars().then((m) => ({ default: m.ComposeBar })));
const PreviewBar = lazy(() => bars().then((m) => ({ default: m.PreviewBar })));
// Files waiting to be sent and the voice recorder load with the first use.
const AttachTray = lazy(() => import("../media/attach-tray.tsx"));
const VoiceRecorder = lazy(() => import("../media/voice-recorder.tsx"));

/** Whether this browser can record a voice message (MediaRecorder and a microphone API). */
function canRecord(): boolean {
	return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

/** "2 GB", "512 MB": the per-file limit next to "File" in the attach menu. */
export function sizeLimitLabel(bytes: number, locale: string): string {
	const gb = bytes / 2 ** 30;
	if (gb >= 1) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(gb)} GB`;
	return `${Math.round(bytes / 2 ** 20)} MB`;
}

const MAX_HEIGHT_PX = 160;
const PREVIEW_DELAY_MS = 400;
const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/i;
const HINT_KEY = "chat:composer-hint-done";

function hintDone(): boolean {
	try {
		return window.localStorage.getItem(HINT_KEY) === "1";
	} catch {
		return false;
	}
}

function markHintDone(): void {
	try {
		window.localStorage.setItem(HINT_KEY, "1");
	} catch {
		// Storage off: the hint shows again next time.
	}
}

interface ComposerProps {
	chatId: number;
	topicId: number;
	/** Channel admins post instead of sending. */
	channel: boolean;
	/** Accessible name of the text box ("Tin nhắn tới …"). */
	label: string;
	placeholder: string;
	disabled?: boolean;
	/** The chat lets this user send media (the server's limit is checked here). */
	media?: boolean;
}

export function Composer({ chatId, topicId, channel, label, placeholder, disabled = false, media = false }: ComposerProps) {
	const copy = useCopy();
	const { locale } = useI18n();
	const limits = useMediaLimits();
	const files = useCell(attachments(chatId, topicId));
	const [attachOpen, setAttachOpen] = useState(false);
	const [recording, setRecording] = useState(false);
	const pickMedia = useRef<HTMLInputElement>(null);
	const pickFiles = useRef<HTMLInputElement>(null);
	const attachButton = useRef<HTMLButtonElement>(null);
	const attachAnchor = useRef<HTMLDivElement>(null);
	// Media is off on the server (upload_size_max 0) or the chat does not allow it: no clip, no mic.
	const mediaOn = media && limits !== null && limits.uploadSizeMax > 0 && !disabled;
	const { source, remote, backend, drafts, store, toasts } = useServices();
	const [hint, setHint] = useState(() => !hintDone());
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

	const sendAttached = async (caption: string) => {
		if (limits === null) return;
		const current = intent;
		const replyToSeq = current?.mode === "reply" ? current.seq : 0;
		const picked = files;
		const cell = attachments(chatId, topicId);
		const asFiles = sendAsFiles(chatId, topicId);
		cell.set([]);
		setText("");
		drafts.set(chatId, "", topicId);
		try {
			const [{ sendFiles }, { releasePreviews }] = await Promise.all([import("../media/send-media.ts"), import("../media/attach-tray.tsx")]);
			const outcome = await sendFiles(source, { chatId, topicId, replyToSeq }, picked, caption, limits, asFiles.get());
			releasePreviews(picked);
			asFiles.set(false);
			// Refused files stay in the tray with their reason.
			if (outcome.refused.length > 0) cell.set(outcome.refused.map((entry) => entry.file));
			cancelIntent();
		} catch {
			cell.set(picked);
			setText(caption);
			drafts.set(chatId, caption, topicId);
			toasts.show(copy.composer.mediaFailed);
		}
	};

	const submit = async (event?: FormEvent) => {
		event?.preventDefault();
		const value = text.trim();
		if (disabled) return;
		if (files.length > 0 && intent?.mode !== "edit") {
			await sendAttached(value);
			return;
		}
		if (value === "") return;
		const limits = await remote.limits().catch(() => ({ messageLengthMax: 0 }));
		if (limits.messageLengthMax > 0 && codePointLength(value) > limits.messageLengthMax) {
			setError(copy.composer.tooLong(limits.messageLengthMax));
			return;
		}
		const current = intent;
		const editing = current?.mode === "edit";
		const noLinkPreview = url !== "" && url === dismissed;
		const deliver = async () => {
			if (current?.mode === "edit") {
				await source.editText(chatId, current.seq, value);
				setText(drafts.get(chatId, topicId));
				return;
			}
			const replyToSeq = current?.mode === "reply" ? current.seq : 0;
			setText("");
			drafts.set(chatId, "", topicId);
			if (topicId !== 0) await backend.sendToTopic(chatId, topicId, value, replyToSeq, noLinkPreview);
			else await source.sendText(chatId, value, { ...(replyToSeq === 0 ? {} : { replyToSeq }), ...(noLinkPreview ? { noLinkPreview } : {}) });
		};
		try {
			await deliver();
			cancelIntent();
			setPreview(null);
			setDismissed("");
			if (hint) {
				markHintDone();
				setHint(false);
			}
		} catch {
			if (!editing) {
				setText(value);
				drafts.set(chatId, value, topicId);
			}
			toasts.show(copy.composer.sendFailed);
		}
	};

	/** ↑ in an empty composer: edit your newest message, when it can still be edited. */
	const editLast = () => {
		const own = store
			.items(chatId)
			.flatMap((item) => (item.kind === "message" ? [item.message] : []))
			.filter(
				(message) =>
					message.fromId === store.selfId &&
					message.text !== "" &&
					message.forward === null &&
					message.action === null &&
					(topicId === 0 || backend.messageTopic(message) === topicId),
			);
		const last = own[own.length - 1];
		if (last === undefined) return;
		remote.limits().then(
			(limits) => {
				if (limits.editTimeLimit > 0 && Date.now() / 1000 - last.date > limits.editTimeLimit) return;
				ui.intents.cell(chatId).set({ mode: "edit", seq: last.seq });
			},
			() => undefined,
		);
	};

	// A pasted image (screenshot) or file joins the tray; pasted text stays text.
	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
		if (!mediaOn || intent?.mode === "edit") return;
		const pasted = [...event.clipboardData.files];
		if (pasted.length === 0 || event.clipboardData.getData("text/plain") !== "") return;
		event.preventDefault();
		addAttachments(chatId, topicId, pasted);
	};

	const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
		const picked = [...(event.target.files ?? [])];
		// Picking the same file again must fire change again.
		event.target.value = "";
		addAttachments(chatId, topicId, picked);
		area.current?.focus();
	};

	const openPicker = (input: HTMLInputElement | null) => {
		setAttachOpen(false);
		input?.click();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape" && intent !== null) {
			event.preventDefault();
			cancelByUser();
			return;
		}
		if (event.key === "ArrowUp" && text === "" && intent === null) {
			event.preventDefault();
			editLast();
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
	const editing = intent?.mode === "edit";
	const withFiles = files.length > 0 && !editing;
	const shownPlaceholder = withFiles ? copy.composer.caption : offline && !disabled ? copy.composer.placeholderOffline : placeholder;
	const empty = text.trim() === "" && !withFiles;
	// With nothing to send the send button becomes the microphone (where recording works).
	const showMic = mediaOn && empty && !editing && canRecord();
	if (recording) {
		return (
			<div className="composer-wrap">
				<Suspense fallback={null}>
					<VoiceRecorder
						target={{ chatId, topicId, replyToSeq: intent?.mode === "reply" ? intent.seq : 0 }}
						onClose={() => {
							setRecording(false);
							cancelIntent();
						}}
					/>
				</Suspense>
			</div>
		);
	}
	return (
		<div className="composer-wrap">
			{withFiles && limits !== null && (
				<div className="compose-extras">
					<Suspense fallback={null}>
						<AttachTray chatId={chatId} topicId={topicId} limits={limits} />
					</Suspense>
				</div>
			)}
			{shownPreview !== null && !editing && !withFiles && (
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
				{mediaOn && limits !== null && (
					<div className="menu-anchor attach-anchor" ref={attachAnchor}>
						<button
							ref={attachButton}
							type="button"
							className="icon-btn"
							aria-label={copy.composer.attach}
							aria-haspopup="menu"
							aria-expanded={attachOpen}
							aria-pressed={attachOpen}
							disabled={editing}
							onClick={() => setAttachOpen((open) => !open)}
						>
							<Icon name="clip" />
						</button>
						{attachOpen && (
							<PopupMenu
								className="attach-menu"
								label={copy.composer.attachMenu}
								boundary={attachAnchor}
								onClose={() => {
									setAttachOpen(false);
									attachButton.current?.focus();
								}}
							>
								<button type="button" role="menuitem" onClick={() => openPicker(pickMedia.current)}>
									<Icon name="photo" />
									{copy.composer.attachMedia}
								</button>
								<button type="button" role="menuitem" onClick={() => openPicker(pickFiles.current)}>
									<Icon name="file" />
									{copy.composer.attachFile}
									<small>{copy.composer.attachMax(sizeLimitLabel(limits.uploadSizeMax, locale))}</small>
								</button>
							</PopupMenu>
						)}
						<input ref={pickMedia} type="file" accept="image/*,video/*" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="pick-media" />
						<input ref={pickFiles} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="pick-files" />
					</div>
				)}
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
					onPaste={onPaste}
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
				{showMic ? (
					<button type="button" className="send" aria-label={copy.composer.record} onClick={() => setRecording(true)}>
						<Icon name="mic" />
					</button>
				) : (
					<button
						type="submit"
						className="send"
						aria-label={editing ? copy.composer.save : channel ? copy.composer.post : copy.composer.send}
						disabled={empty || disabled}
					>
						<Icon name={editing ? "check" : "send"} />
					</button>
				)}
			</form>
			{hint && !editing && !disabled && <p className="composer-hint">{copy.composer.hint}</p>}
		</div>
	);
}
