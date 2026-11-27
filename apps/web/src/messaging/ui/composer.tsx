// Composer: text, emoji, reply, edit, and (R3) files and voice messages.
// Enter sends, Shift+Enter breaks the line, Esc cancels reply or edit, ↑ in
// an empty composer edits your last message (mockups/chat.html#composer-states,
// settings.html#shortcuts). The placeholder says where the message goes; the
// send button's tooltip names the keys.
// Sending is optimistic: the core shows the message at once with a clock.
// Dropping the link preview sends the message with no_link_preview, so the
// server attaches none. The paper clip (shown when the server takes media)
// picks photos and videos or any file, or — where the browser can share the
// screen — takes a screenshot or records the screen (media/screen-*.ts);
// those, pasted images and files dropped on the chat join them in the tray
// above the text, which becomes the caption
// (mockups/media.html#attach). With nothing typed the send button turns
// into the microphone, which records a voice message. In a private chat with
// a bot the bot layer (bots/bot-chat.tsx, loaded with the first bot chat)
// adds the command menu and the bot's reply keyboard; in a group it adds the
// command menu of the group's bots. A draft "@bot_username query" is inline
// mode: the box finds it (bots/inline-token.ts) and the bot's results show as
// a list attached to the box (bots/inline-results.tsx). "/ai question" sent
// opens the chat's AI panel with the question instead: nothing goes into the
// chat. Text the AI panel puts in the box («Đưa vào ô soạn tin») replaces
// the draft.
import { Suspense, lazy, useCallback, useEffect, useEffectEvent, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { codePointLength } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { AiMark } from "../../machines/ai-mark.tsx";
import { hasFinePointer } from "../../components/fine-pointer.ts";
import { PlainTextBox, commandToken, type OpenToken, type PlainTextBoxHandle, type SuggestionTrigger } from "../../components/plain-text-box.tsx";
import { advisorStore, useChatFill } from "../../advisor/advisor-store.ts";
import { useI18n } from "../../i18n/i18n.tsx";
import { inlineToken } from "../bots/inline-token.ts";
import { useScreensCopy } from "../copy/use-screens-copy.ts";
import type { LinkPreview } from "../data/pending-backend.ts";
import { useConnection, useMediaLimits, useMessage, useServices } from "../data/services.tsx";
import { addAttachments, attachments, sendAsFiles } from "../media/media-state.ts";
import { canRecordScreen, canShareScreen, requestScreen, screenKey } from "../media/screen-share.ts";
import type { CaptureTarget } from "../../machines/native-capture.ts";
import { useHubSlot } from "../../machines/link/connection-provider.tsx";
import { sizeLimitLabel } from "../media/size-limit-label.ts";
import { openAiPanel, useCell, useIntent, useUi } from "./ui-context.tsx";

const AttachMenu = lazy(() => import("./attach-menu.tsx"));
const EmojiPicker = lazy(() => import("./emoji-picker.tsx").then((m) => ({ default: m.EmojiPicker })));
// The reply/edit and link preview bars load the first time one shows.
const bars = () => import("./composer-bars.tsx");
const ComposeBar = lazy(() => bars().then((m) => ({ default: m.ComposeBar })));
const PreviewBar = lazy(() => bars().then((m) => ({ default: m.PreviewBar })));
// Files waiting to be sent and the voice recorder load with the first use.
const AttachTray = lazy(() => import("../media/attach-tray.tsx"));
const VoiceRecorder = lazy(() => import("../media/voice-recorder.tsx"));
const ScreenRecorder = lazy(() => import("../media/screen-recorder.tsx"));
const ScreenshotRegion = lazy(() => import("../media/screenshot-region.tsx"));
const BotLayer = lazy(() => import("../bots/bot-chat.tsx").then((m) => ({ default: m.BotLayer })));
// The draft is "@bot_username query": inline mode of that bot.
const InlineResults = lazy(() => import("../bots/inline-results.tsx"));
const GroupBotLayer = lazy(() => import("../bots/bot-chat.tsx").then((m) => ({ default: m.GroupBotLayer })));

/** The bot layer's state for the composer's buttons (bots/bot-chat.tsx BotBar); empty until it loads. */
interface BotBar {
	readonly menu: boolean | null;
	readonly keyboard: boolean | null;
	readonly placeholder: string | null;
	readonly app: string | null;
}

const NO_BOT_BAR: BotBar = { menu: null, keyboard: null, placeholder: null, app: null };

/**
 * The bot buttons each chat showed last, by chat. The composer mounts again
 * for every chat it opens and the bot layer reports its buttons only once it
 * has loaded, so without them the buttons would pop in after the first frame
 * and push the text box aside. Menus are kept closed.
 */
const lastBotBar = new Map<number, BotBar>();

/** What the composer calls in the bot layer (bots/bot-chat.tsx BotActions). */
interface BotActions {
	toggleMenu(): void;
	toggleKeyboard(): void;
	openApp(): void;
	onKey(event: KeyboardEvent): boolean;
}

/** Whether this browser can record a voice message (MediaRecorder and a microphone API). */
function canRecord(): boolean {
	return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

const PREVIEW_DELAY_MS = 400;
const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/i;
/** "/ai", alone or followed by a question: a question for the chat's AI panel, never a message. */
const AI_COMMAND = /^\/ai(?:\s+([\s\S]*))?$/;

/** The question of an "/ai …" draft ("" for "/ai" alone); null for any other text. */
export function aiQuestion(text: string): string | null {
	const match = AI_COMMAND.exec(text.trim());
	return match === null ? null : (match[1] ?? "").trim();
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
	/** The chat sends on to an app that takes a caption only with a photo (Zalo): a caption of other files goes as its own message. */
	captionOnPhotoOnly?: boolean;
	/** Private chat with a bot: the bot's user id (its command menu and reply keyboard); 0 otherwise. */
	botId?: number;
	/** A group: the command menu of its bots. */
	group?: boolean;
}

export function Composer({
	chatId,
	topicId,
	channel,
	label,
	placeholder,
	disabled = false,
	media = false,
	captionOnPhotoOnly = false,
	botId = 0,
	group = false,
}: ComposerProps) {
	const copy = useScreensCopy();
	const { locale } = useI18n();
	const limits = useMediaLimits();
	const files = useCell(attachments(chatId, topicId));
	const [attachOpen, setAttachOpen] = useState(false);
	const [recording, setRecording] = useState(false);
	// The screen share being recorded, asked for in the attach menu's click.
	const [screenShare, setScreenShare] = useState<Promise<MediaStream> | null>(null);
	// The screen share a screenshot is being taken from (its region picked over the page).
	const [screenshot, setScreenshot] = useState<Promise<MediaStream> | null>(null);
	const pickMedia = useRef<HTMLInputElement>(null);
	const pickFiles = useRef<HTMLInputElement>(null);
	const attachButton = useRef<HTMLButtonElement>(null);
	const attachAnchor = useRef<HTMLDivElement>(null);
	// Media is off on the server (upload_size_max 0) or the chat does not allow it: no clip, no mic.
	const mediaOn = media && limits !== null && limits.uploadSizeMax > 0 && !disabled;
	const { source, remote, backend, drafts, store, toasts, transport } = useServices();
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
	const area = useRef<PlainTextBoxHandle>(null);
	// The bot layer: its buttons' state, and its key handling (command menu) asked before the composer's own.
	const [botBar, setBotBarState] = useState<BotBar>(() => lastBotBar.get(chatId) ?? NO_BOT_BAR);
	const setBotBar = useCallback(
		(bar: BotBar, gone = false) => {
			setBotBarState(bar);
			if (!gone) lastBotBar.set(chatId, { ...bar, menu: bar.menu === null ? null : false });
		},
		[chatId],
	);
	const botActions = useRef<BotActions | null>(null);
	// "/command" typed as the whole message, which the bot layer's command menu follows.
	const [command, setCommand] = useState<OpenToken | null>(null);
	const withBots = botId !== 0 || (group && !disabled);
	// "@bot_username query" as the whole draft, whose results list keeps the box's keys (bots/inline-results.tsx).
	const [inline, setInline] = useState<OpenToken | null>(null);
	const inlineKeys = useRef<((event: KeyboardEvent) => boolean) | null>(null);
	const [inlineActive, setInlineActive] = useState<string | null>(null);
	const inlineListId = `inline-results-${chatId}-${topicId}`;
	const suggestions: readonly SuggestionTrigger[] = [
		{ char: "/", find: (value) => (withBots ? commandToken(value) : null), onChange: setCommand, onKeyDown: (event) => botActions.current?.onKey(event) ?? false },
		{ char: "@", find: (value) => inlineToken(value), onChange: setInline, onKeyDown: (event) => inlineKeys.current?.(event) ?? false },
	];

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

	// A chat opens with the caret in its box (the composer is keyed by chat and topic, so this runs on every open).
	useEffect(() => {
		if (hasFinePointer()) area.current?.focus();
	}, []);

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
		if (intent?.mode === "edit") return;
		drafts.set(chatId, value, topicId);
		// Channels post without "đang gõ…"; clearing the draft ends it at once.
		if (!channel) void source.sendTyping(chatId, topicId, value.trim() === "" ? "cancel" : "typing").catch(() => undefined);
	};

	// The chat open here is where Advisor's answer can be put (nothing of it leaves the page).
	useEffect(() => {
		if (disabled) return;
		advisorStore.setChat({ chatId, topicId });
		return () => advisorStore.setChat(null);
	}, [chatId, topicId, disabled]);
	// Advisor's answer goes in after what is typed, for the user to read and send; the box takes the caret.
	const advisorFill = useChatFill(chatId, topicId);
	const takeAdvisorFill = useEffectEvent((fill: { readonly text: string; readonly id: number }) => {
		update(text.trim() === "" ? fill.text : `${text}\n${fill.text}`);
		advisorStore.takeChatFill(chatId, topicId, fill.id);
		area.current?.focus();
	});
	useEffect(() => {
		// Advisor's store is an external system: its text is taken into the box once, when it arrives.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (advisorFill !== undefined && !disabled) takeAdvisorFill(advisorFill);
	}, [advisorFill, disabled]);

	// The AI panel wrote this chat's draft (and its reply) already: the box shows it and takes the caret.
	const composerFill = useCell(ui.composerFill);
	const takeComposerFill = useEffectEvent(() => {
		ui.composerFill.set(null);
		setText(drafts.get(chatId, topicId));
		setError("");
		area.current?.focus();
	});
	useEffect(() => {
		// The fill cell is an external store: its text is taken into the box once, when it arrives.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		if (composerFill !== null && composerFill.chatId === chatId && composerFill.topicId === topicId && !disabled) takeComposerFill();
	}, [composerFill, chatId, topicId, disabled]);

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
			const outcome = await sendFiles(source, { chatId, topicId, replyToSeq }, picked, caption, limits, asFiles.get(), captionOnPhotoOnly);
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
		// "/ai …": the question goes to the chat's AI panel; the box lets go of the command.
		const question = intent?.mode === "edit" ? null : aiQuestion(value);
		if (question !== null) {
			openAiPanel(ui, chatId, { ask: question });
			update("");
			return;
		}
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
		} catch {
			if (!editing) {
				setText(value);
				drafts.set(chatId, value, topicId);
			}
			toasts.show(copy.composer.sendFailed);
		}
	};

	/** A bot command or reply keyboard button: sent as typed by the user, the draft left alone. */
	const sendBotText = (value: string) => {
		// A command picked in a forum group goes to the open topic.
		const sent = topicId !== 0 ? backend.sendToTopic(chatId, topicId, value, 0, false) : source.sendText(chatId, value);
		sent.catch(() => toasts.show(copy.composer.sendFailed));
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
	const onPaste = (event: ClipboardEvent) => {
		if (!mediaOn || intent?.mode === "edit") return;
		const clipboard = event.clipboardData;
		if (clipboard === null) return;
		const pasted = [...clipboard.files];
		if (pasted.length === 0 || clipboard.getData("text/plain") !== "") return;
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

	// Where a screenshot goes: tunelo-capture on this computer (machines/native-capture.ts) or the browser's own.
	// Found when the attach menu opens; a failure of the machine's falls back to the browser for this chat.
	const [captureTarget, setCaptureTarget] = useState<CaptureTarget | null>(null);
	const [nativeBusy, setNativeBusy] = useState(false);
	const slot = useHubSlot();
	useEffect(() => {
		if (!attachOpen || !canShareScreen() || captureTarget?.kind === "web") return;
		let live = true;
		import("../../machines/native-capture.ts")
			.then((m) => m.resolveCaptureTarget(m.hubOf(slot, transport, "")))
			.then(
				(target) => {
					if (live) setCaptureTarget(target);
				},
				() => undefined,
			);
		return () => {
			live = false;
		};
	}, [attachOpen, slot, transport, captureTarget?.kind]);

	/** The screenshot on a machine: its overlay, then the picture into this chat's tray. */
	const nativeScreenshot = (ref: string) => {
		setAttachOpen(false);
		if (nativeBusy) return;
		setNativeBusy(true);
		import("../../machines/native-capture.ts")
			.then((m) => m.captureOn(m.hubOf(slot, transport, ""), ref))
			.then(
				(file) => {
					if (file !== null) addAttachments(chatId, topicId, [file]);
					area.current?.focus();
				},
				() => {
					// The next screenshot of this chat uses the browser's own.
					setCaptureTarget({ kind: "web" });
					toasts.show(copy.composer.nativeShotFailed);
				},
			)
			.finally(() => setNativeBusy(false));
	};

	const pickCaptureMachine = (ref: string | "web") => {
		void import("../../machines/native-capture.ts").then((m) => m.rememberCaptureMachine(ref));
		if (ref === "web") {
			setCaptureTarget({ kind: "web" });
			webScreenshot();
		} else nativeScreenshot(ref);
	};

	const takeScreenshot = () => {
		if (captureTarget?.kind === "native") return nativeScreenshot(captureTarget.machine.ref);
		webScreenshot();
	};

	// The browser shares the screen only from inside the click: ask first, load the capture code after.
	const webScreenshot = () => {
		setAttachOpen(false);
		if (screenshot !== null) return;
		const shared = requestScreen(false);
		// Without this a closed picker would be reported unhandled until the screenshot code loads.
		shared.catch(() => undefined);
		setScreenshot(shared);
	};

	const recordScreen = () => {
		setAttachOpen(false);
		const shared = requestScreen(true);
		// Without this the rejection of a closed picker would be reported unhandled until the recorder loads.
		shared.catch(() => undefined);
		setScreenShare(shared);
	};

	// ⌥S / Alt+S takes a screenshot, ⌥R / Alt+R records the screen, as the attach menu does; the key press is the gesture the browser needs.
	const onScreenKey = useEffectEvent((event: KeyboardEvent) => {
		const key = screenKey(event);
		if (key === null || !mediaOn || intent?.mode === "edit" || recording || screenShare !== null || screenshot !== null) return;
		if (key === "screenshot" ? !canShareScreen() : !canRecordScreen()) return;
		event.preventDefault();
		if (key === "screenshot") takeScreenshot();
		else recordScreen();
	});
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => onScreenKey(event);
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const onKeyDown = (event: KeyboardEvent) => {
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
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void submit();
		}
	};

	// The picker stays open to pick more (the focus stays in it); each emoji goes in at the caret.
	const insertEmoji = (emoji: string) => {
		const box = area.current;
		if (box === null) update(text + emoji);
		else box.insertText(emoji);
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
	if (screenShare !== null) {
		return (
			<div className="composer-wrap">
				<Suspense fallback={null}>
					<ScreenRecorder
						stream={screenShare}
						chatId={chatId}
						topicId={topicId}
						onClose={() => {
							setScreenShare(null);
							area.current?.focus();
						}}
					/>
				</Suspense>
			</div>
		);
	}
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
			{screenshot !== null && (
				<Suspense fallback={null}>
					<ScreenshotRegion
						stream={screenshot}
						chatId={chatId}
						topicId={topicId}
						onClose={() => {
							setScreenshot(null);
							area.current?.focus();
						}}
					/>
				</Suspense>
			)}
			{inline !== null && !editing && !withFiles && (
				<Suspense fallback={null}>
					<InlineResults
						chatId={chatId}
						topicId={topicId}
						draft={`@${inline.query}`}
						listId={inlineListId}
						keysRef={inlineKeys}
						onActive={setInlineActive}
						onSent={() => {
							update("");
							area.current?.focus();
						}}
					/>
				</Suspense>
			)}
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
		<form className={botBar.keyboard === null ? "composer" : "composer with-bot-kb"} onSubmit={(event) => void submit(event)}>
				{botBar.menu !== null && (
					<button
						type="button"
						className="icon-btn"
						aria-label={copy.bot.menu}
						aria-pressed={botBar.menu}
						aria-expanded={botBar.menu}
						aria-controls={`bot-cmds-${chatId}`}
						// The focus stays in the text box, whose "/" token the menu follows.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => botActions.current?.toggleMenu()}
					>
						<AiMark name="commands" />
					</button>
				)}
				{botBar.app !== null && (
					// An icon the size of the others, the bot's own label as its name: switching chats keeps the row in place.
					<button type="button" className="icon-btn" aria-label={botBar.app} title={botBar.app} onClick={() => botActions.current?.openApp()}>
						<Icon name="apps" />
					</button>
				)}
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
							<Suspense fallback={null}>
								<AttachMenu
									boundary={attachAnchor}
									limit={sizeLimitLabel(limits.uploadSizeMax, locale)}
									onMedia={() => openPicker(pickMedia.current)}
									onFiles={() => openPicker(pickFiles.current)}
									onScreenshot={canShareScreen() && captureTarget?.kind !== "choose" ? takeScreenshot : undefined}
									screenshotOn={captureTarget?.kind === "native" ? captureTarget.machine.name : undefined}
									screenshotChoices={captureTarget?.kind === "choose" ? captureTarget.machines : undefined}
									onPickScreenshot={pickCaptureMachine}
									onRecordScreen={canRecordScreen() ? recordScreen : undefined}
									onClose={() => {
										setAttachOpen(false);
										attachButton.current?.focus();
									}}
								/>
							</Suspense>
						)}
						<input ref={pickMedia} type="file" accept="image/*,video/*" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="pick-media" />
						<input ref={pickFiles} type="file" multiple hidden tabIndex={-1} aria-hidden="true" onChange={onPicked} data-testid="pick-files" />
					</div>
				)}
				<PlainTextBox
					ref={area}
					id={`draft-${chatId}-${topicId}`}
					className="composer-field"
					ariaLabel={label}
					enterKeyHint="send"
					placeholder={botBar.placeholder ?? shownPlaceholder}
					value={text}
					disabled={disabled}
					suggestions={suggestions}
					onValueChange={update}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					aria-invalid={error !== ""}
					aria-autocomplete="list"
					aria-controls={inlineActive === null ? undefined : inlineListId}
					aria-activedescendant={inlineActive ?? undefined}
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
				{botBar.keyboard !== null && (
					<button
						type="button"
						className="icon-btn"
						aria-pressed={botBar.keyboard}
						aria-label={botBar.keyboard ? copy.bot.hideKeyboard : copy.bot.showKeyboard}
						onClick={() => botActions.current?.toggleKeyboard()}
					>
						<Icon name="keyboard" />
					</button>
				)}
				{showMic ? (
					<button type="button" className="send" aria-label={copy.composer.record} onClick={() => setRecording(true)}>
						<Icon name="mic" />
					</button>
				) : (
					<button
						type="submit"
						className="send"
						aria-label={editing ? copy.composer.save : channel ? copy.composer.post : copy.composer.send}
						title={copy.composer.keys}
						disabled={empty || disabled}
					>
						<Icon name={editing ? "check" : "send"} />
					</button>
				)}
			</form>
			{botId !== 0 && (
				<Suspense fallback={null}>
					<BotLayer
						chatId={chatId}
						botId={botId}
						text={text}
						token={command}
						setText={update}
						send={sendBotText}
						focus={() => area.current?.focus()}
						box={area}
						onBar={setBotBar}
						actionsRef={botActions}
					/>
				</Suspense>
			)}
			{group && botId === 0 && !disabled && (
				<Suspense fallback={null}>
					<GroupBotLayer
						chatId={chatId}
						text={text}
						token={command}
						setText={update}
						send={sendBotText}
						focus={() => area.current?.focus()}
						box={area}
						onBar={setBotBar}
						actionsRef={botActions}
					/>
				</Suspense>
			)}
		</div>
	);
}
