// Screen recorder, in place of the composer's text row while recording:
// the screen was asked for in the attach menu's click (screen-share.ts),
// this records it with MediaRecorder while showing the time. Stop — or the
// browser's own "stop sharing" — puts the video in the tray above the
// composer to caption and send; X or Esc throws it away. A refused or
// failed share says so; the recording stops itself at MAX_MS.
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { TYPING_REPEAT_MS } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useServices } from "../data/services.tsx";
import { formatDuration } from "./media-format.ts";
import { MediaIcon } from "./media-icons.tsx";
import { addAttachments } from "./media-state.ts";
import { recordingFile, recordingType, stopStream } from "./screen-capture.ts";
import { refusedShare } from "./screen-share.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

/** A recording stops itself this long after it started (the chunks are held in memory). */
export const MAX_MS = 30 * 60 * 1000;
/** About 2.5 Mbit/s: a screen stays readable, half an hour stays under 600 MB. */
const VIDEO_BITS_PER_SECOND = 2_500_000;
const TICK_MS = 250;

type Phase = { readonly kind: "asking" } | { readonly kind: "recording" } | { readonly kind: "error"; readonly text: string };

interface Session {
	readonly stream: MediaStream;
	readonly recorder: MediaRecorder;
	readonly chunks: Blob[];
	readonly startedAt: number;
}

interface ScreenRecorderProps {
	/** The share the attach menu asked for. */
	stream: Promise<MediaStream>;
	chatId: number;
	topicId: number;
	onClose: () => void;
}

/** Stops a recording; `onFile` gets the video once the recorder has flushed (none when thrown away). */
function stopSession(current: Session | null, onFile?: (file: File) => void): void {
	if (current === null) return;
	if (onFile !== undefined) {
		current.recorder.addEventListener("stop", () => onFile(recordingFile(current.chunks, current.recorder.mimeType)), { once: true });
	}
	if (current.recorder.state !== "inactive") current.recorder.stop();
	stopStream(current.stream);
}

export default function ScreenRecorder({ stream, chatId, topicId, onClose }: ScreenRecorderProps) {
	const copy = useMediaCopy();
	const { source, toasts } = useServices();
	const [phase, setPhase] = useState<Phase>({ kind: "asking" });
	const [elapsed, setElapsed] = useState(0);
	const session = useRef<Session | null>(null);
	const stopButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);

	/** Ends the recording; `keep` puts the video in the tray. */
	const finish = (keep: boolean) => {
		const current = session.current;
		session.current = null;
		stopSession(
			current,
			keep
				? (file) => {
						if (file.size > 0) addAttachments(chatId, topicId, [file]);
						else toasts.show(copy.screenRecorder.failed);
					}
				: undefined,
		);
	};

	// The browser's "stop sharing", or the length limit: keep what was recorded.
	const endShare = useEffectEvent((limit: boolean) => {
		if (limit) toasts.show(copy.screenRecorder.maxReached);
		finish(true);
		onClose();
	});
	const closeRefused = useEffectEvent(() => onClose());

	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setInterval> | undefined;
		stream.then(
			(shared) => {
				if (!active) {
					stopStream(shared);
					return;
				}
				let recorder: MediaRecorder;
				try {
					const mimeType = recordingType();
					recorder = new MediaRecorder(shared, { ...(mimeType === "" ? {} : { mimeType }), videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
				} catch {
					stopStream(shared);
					setPhase({ kind: "error", text: copy.screenRecorder.failed });
					return;
				}
				const current: Session = { stream: shared, recorder, chunks: [], startedAt: Date.now() };
				recorder.addEventListener("dataavailable", (event) => {
					if (event.data.size > 0) current.chunks.push(event.data);
				});
				for (const track of shared.getVideoTracks()) {
					track.addEventListener("ended", () => {
						if (session.current === current) endShare(false);
					});
				}
				recorder.start(1000);
				session.current = current;
				setPhase({ kind: "recording" });
				timer = setInterval(() => {
					const ms = Date.now() - current.startedAt;
					setElapsed(ms);
					if (ms >= MAX_MS && session.current === current) endShare(true);
				}, TICK_MS);
			},
			(err: unknown) => {
				if (!active) return;
				if (refusedShare(err)) closeRefused();
				else setPhase({ kind: "error", text: copy.screenRecorder.failed });
			},
		);
		return () => {
			active = false;
			clearInterval(timer);
			// Leaving the chat mid-recording throws the recording away.
			stopSession(session.current);
			session.current = null;
		};
	}, [stream, copy]);

	// "đang quay video…" for the chat while recording; the core drops repeats.
	const recording = phase.kind === "recording";
	useEffect(() => {
		if (!recording) return;
		const say = (action: "video" | "cancel") => void source.sendTyping(chatId, topicId, action).catch(() => undefined);
		say("video");
		const timer = setInterval(() => say("video"), TYPING_REPEAT_MS);
		return () => {
			clearInterval(timer);
			say("cancel");
		};
	}, [recording, source, chatId, topicId]);

	useEffect(() => {
		if (phase.kind === "recording") stopButton.current?.focus();
		else cancelButton.current?.focus();
	}, [phase.kind]);

	const cancel = () => {
		if (phase.kind === "recording") toasts.show(copy.screenRecorder.cancelled);
		finish(false);
		onClose();
	};

	const stop = () => {
		finish(true);
		onClose();
	};

	return (
		// eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Esc pressed on any recorder button bubbles here to cancel the recording
		<div
			className="recorder"
			role="group"
			aria-label={copy.screenRecorder.record}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					cancel();
				}
			}}
		>
			<button ref={cancelButton} type="button" className="icon-btn" aria-label={copy.screenRecorder.cancel} onClick={cancel}>
				<Icon name={phase.kind === "error" ? "x" : "trash"} />
			</button>
			{phase.kind === "recording" ? (
				<>
					<span className="rec-dot" aria-hidden="true" />
					<span className="rec-time" role="timer" aria-label={copy.screenRecorder.recording}>
						{formatDuration(elapsed)}
					</span>
					<span className="rec-note">{copy.screenRecorder.hint}</span>
				</>
			) : (
				<span className={phase.kind === "error" ? "rec-note err" : "rec-note"} role={phase.kind === "error" ? "alert" : "status"}>
					{phase.kind === "error" ? phase.text : copy.screenRecorder.asking}
				</span>
			)}
			<button ref={stopButton} type="button" className="send" aria-label={copy.screenRecorder.stop} disabled={phase.kind !== "recording"} onClick={stop}>
				<MediaIcon name="stop" />
			</button>
		</div>
	);
}
