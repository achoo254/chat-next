// Screen recorder, in place of the composer's text row while recording:
// the screen was asked for in the attach menu's click (screen-share.ts);
// where the browser can crop a recording (Chrome, Edge) the live screen
// first fills the page to drag the region to record (region-select.tsx),
// then this records it with MediaRecorder while showing the time. Stop — or the
// browser's own "stop sharing" — puts the video in the tray above the
// composer to caption and send; X or Esc throws it away. A refused or
// failed share says so; the recording stops itself at MAX_MS.
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { TYPING_REPEAT_MS } from "@achoo254/chat-core";
import { Icon } from "../../components/screen-icons.tsx";
import { useServices } from "../data/services.tsx";
import { formatDuration } from "./media-format.ts";
import { MediaIcon } from "./media-icons.tsx";
import { addAttachments } from "./media-state.ts";
import { canCropRecording, croppedTrack, recordingFile, recordingType, stopStream, type Rect } from "./screen-capture.ts";
import { refusedShare } from "./screen-share.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

const RegionSelect = lazy(() => import("./region-select.tsx"));

/** A recording stops itself this long after it started (the chunks are held in memory). */
export const MAX_MS = 30 * 60 * 1000;
/** About 2.5 Mbit/s: a screen stays readable, half an hour stays under 600 MB. */
const VIDEO_BITS_PER_SECOND = 2_500_000;
const TICK_MS = 250;

type Phase =
	| { readonly kind: "asking" }
	| { readonly kind: "selecting"; readonly shared: MediaStream; readonly video: HTMLVideoElement; readonly width: number; readonly height: number }
	| { readonly kind: "recording" }
	| { readonly kind: "error"; readonly text: string };

interface Session {
	/** The share: stopping it ends the recording (and a cropped track made from it). */
	readonly shared: MediaStream;
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
	stopStream(current.shared);
}

/** The picking preview lets go of the share (the recording keeps it). */
function releaseVideo(video: HTMLVideoElement): void {
	video.srcObject = null;
}

/** A playing video of the share, once it knows its size; null when no frame comes. */
async function liveVideo(shared: MediaStream): Promise<HTMLVideoElement | null> {
	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = shared;
	await video.play().catch(() => undefined);
	if (video.videoWidth > 0) return video;
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), 5000);
		video.addEventListener(
			"loadedmetadata",
			() => {
				clearTimeout(timer);
				resolve(video.videoWidth > 0 ? video : null);
			},
			{ once: true },
		);
	});
}

export default function ScreenRecorder({ stream, chatId, topicId, onClose }: ScreenRecorderProps) {
	const copy = useMediaCopy();
	const { source, toasts } = useServices();
	const [phase, setPhase] = useState<Phase>({ kind: "asking" });
	const [elapsed, setElapsed] = useState(0);
	const session = useRef<Session | null>(null);
	/** The share while its region is being picked, stopped if the recorder goes away first. */
	const picking = useRef<MediaStream | null>(null);
	const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const stopButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);
	// Read by the share's listeners, which outlive a render.
	const latest = useRef({ chatId, topicId, onClose, toasts, copy });
	useEffect(() => {
		latest.current = { chatId, topicId, onClose, toasts, copy };
	});

	/** Ends the recording; `keep` puts the video in the tray. */
	const finish = (keep: boolean) => {
		const current = session.current;
		session.current = null;
		clearInterval(timer.current);
		const { chatId: chat, topicId: topic, toasts: toast, copy: text } = latest.current;
		stopSession(
			current,
			keep
				? (file) => {
						if (file.size > 0) addAttachments(chat, topic, [file]);
						else toast.show(text.screenRecorder.failed);
					}
				: undefined,
		);
	};

	/** Starts recording the share, cropped to `region` when one was picked. */
	const begin = (shared: MediaStream, region: Rect | null) => {
		picking.current = null;
		let recorder: MediaRecorder;
		try {
			const [track] = shared.getVideoTracks();
			// A region: its cropped video with the share's sound; otherwise the share as it is.
			const recorded =
				region === null || track === undefined ? shared : new MediaStream([croppedTrack(track, region), ...shared.getAudioTracks()]);
			const mimeType = recordingType();
			recorder = new MediaRecorder(recorded, { ...(mimeType === "" ? {} : { mimeType }), videoBitsPerSecond: VIDEO_BITS_PER_SECOND });
		} catch {
			stopStream(shared);
			setPhase({ kind: "error", text: latest.current.copy.screenRecorder.failed });
			return;
		}
		const current: Session = { shared, recorder, chunks: [], startedAt: Date.now() };
		recorder.addEventListener("dataavailable", (event) => {
			if (event.data.size > 0) current.chunks.push(event.data);
		});
		// The browser's "stop sharing" ends the share: keep what was recorded.
		for (const track of shared.getVideoTracks()) {
			track.addEventListener("ended", () => {
				if (session.current !== current) return;
				finish(true);
				latest.current.onClose();
			});
		}
		recorder.start(1000);
		session.current = current;
		setPhase({ kind: "recording" });
		timer.current = setInterval(() => {
			const ms = Date.now() - current.startedAt;
			setElapsed(ms);
			if (ms >= MAX_MS && session.current === current) {
				latest.current.toasts.show(latest.current.copy.screenRecorder.maxReached);
				finish(true);
				latest.current.onClose();
			}
		}, TICK_MS);
	};
	const beginShared = useEffectEvent(begin);
	const closeRefused = useEffectEvent(() => onClose());

	useEffect(() => {
		let active = true;
		stream.then(
			async (shared) => {
				if (!active) {
					stopStream(shared);
					return;
				}
				// Where the browser cannot crop a recording, the whole share is recorded.
				const video = canCropRecording() ? await liveVideo(shared) : null;
				if (!active) {
					stopStream(shared);
					return;
				}
				if (video === null) {
					beginShared(shared, null);
					return;
				}
				picking.current = shared;
				// Stopping the share while picking the region is a cancel.
				for (const track of shared.getVideoTracks()) {
					track.addEventListener("ended", () => {
						if (picking.current === shared) closeRefused();
					});
				}
				setPhase({ kind: "selecting", shared, video, width: video.videoWidth, height: video.videoHeight });
			},
			(err: unknown) => {
				if (!active) return;
				if (refusedShare(err)) closeRefused();
				else setPhase({ kind: "error", text: copy.screenRecorder.failed });
			},
		);
		return () => {
			active = false;
			clearInterval(timer.current);
			if (picking.current !== null) stopStream(picking.current);
			picking.current = null;
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
		if (phase.kind === "selecting") stopStream(phase.shared);
		picking.current = null;
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
					{phase.kind === "error" ? phase.text : phase.kind === "selecting" ? copy.screenRecorder.selecting : copy.screenRecorder.asking}
				</span>
			)}
			{phase.kind === "selecting" && (
				<Suspense fallback={null}>
					<RegionSelect
						media={phase.video}
						width={phase.width}
						height={phase.height}
						mode="record"
						onConfirm={(region) => {
							releaseVideo(phase.video);
							begin(phase.shared, region);
						}}
						onCancel={cancel}
					/>
				</Suspense>
			)}
			<button ref={stopButton} type="button" className="send" aria-label={copy.screenRecorder.stop} disabled={phase.kind !== "recording"} onClick={stop}>
				<MediaIcon name="stop" />
			</button>
		</div>
	);
}
