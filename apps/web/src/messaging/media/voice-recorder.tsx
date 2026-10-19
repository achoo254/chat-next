// Voice message recorder, in place of the composer's text row: asks for
// the microphone (the browser prompts the first time), records with
// MediaRecorder while showing the time and the sound level, then sends
// the recording as a voice message with its duration and waveform. Esc or
// X cancels. A refused or missing microphone, or a browser without
// MediaRecorder, says so and leaves the composer as it was.
import { useEffect, useRef, useState } from "react";
import { TYPING_REPEAT_MS } from "@app/core";
import { Icon } from "../../components/screen-icons.tsx";
import { useServices } from "../data/services.tsx";
import { formatDuration } from "./media-format.ts";
import { MediaIcon } from "./media-icons.tsx";
import { sendVoice, type SendTarget } from "./send-media.ts";
import { useMediaCopy } from "./use-media-copy.ts";
import "./media.css";

/** Level samples per second while recording (the waveform's resolution). */
const SAMPLE_MS = 100;
/** Shorter recordings are dropped (a tap on the mic by mistake). */
const MIN_MS = 1000;
/** Bars of the live level meter. */
const LIVE_BARS = 32;

type Phase = { readonly kind: "asking" } | { readonly kind: "recording" } | { readonly kind: "error"; readonly text: string };

/** Whether this browser can record a voice message at all. */
export function canRecord(): boolean {
	return typeof MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function";
}

interface Session {
	readonly stream: MediaStream;
	readonly recorder: MediaRecorder;
	readonly chunks: Blob[];
	readonly levels: number[];
	readonly startedAt: number;
	readonly audio: AudioContext | null;
	readonly analyser: AnalyserNode | null;
}

function stopSession(session: Session | null): void {
	if (session === null) return;
	if (session.recorder.state !== "inactive") session.recorder.stop();
	for (const track of session.stream.getTracks()) track.stop();
	void session.audio?.close().catch(() => undefined);
}

/** A level meter on the microphone; nulls without Web Audio (the message records without a waveform). */
function meter(stream: MediaStream): { audio: AudioContext | null; analyser: AnalyserNode | null } {
	try {
		const audio = new AudioContext();
		const analyser = audio.createAnalyser();
		analyser.fftSize = 512;
		audio.createMediaStreamSource(stream).connect(analyser);
		return { audio, analyser };
	} catch {
		return { audio: null, analyser: null };
	}
}

/** Peak level (0 to 1) of the analyser's current frame. */
function levelOf(analyser: AnalyserNode | null): number {
	if (analyser === null) return 0;
	const data = new Uint8Array(analyser.fftSize);
	analyser.getByteTimeDomainData(data);
	let peak = 0;
	for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
	return peak;
}

export default function VoiceRecorder({ target, onClose }: { target: SendTarget; onClose: () => void }) {
	const copy = useMediaCopy();
	const { source, toasts } = useServices();
	const [phase, setPhase] = useState<Phase>(() => (typeof MediaRecorder === "undefined" ? { kind: "error", text: copy.recorder.unsupported } : { kind: "asking" }));
	const [elapsed, setElapsed] = useState(0);
	const [bars, setBars] = useState<readonly number[]>([]);
	const session = useRef<Session | null>(null);
	const sendButton = useRef<HTMLButtonElement>(null);
	const cancelButton = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (typeof MediaRecorder === "undefined" || typeof navigator.mediaDevices?.getUserMedia !== "function") return;
		let active = true;
		let timer: ReturnType<typeof setInterval> | undefined;
		navigator.mediaDevices.getUserMedia({ audio: true }).then(
			(stream) => {
				if (!active) {
					for (const track of stream.getTracks()) track.stop();
					return;
				}
				const { audio, analyser } = meter(stream);
				const recorder = new MediaRecorder(stream);
				const current: Session = { stream, recorder, chunks: [], levels: [], startedAt: Date.now(), audio, analyser };
				recorder.addEventListener("dataavailable", (event) => {
					if (event.data.size > 0) current.chunks.push(event.data);
				});
				recorder.start(250);
				session.current = current;
				setPhase({ kind: "recording" });
				timer = setInterval(() => {
					current.levels.push(levelOf(current.analyser));
					setElapsed(Date.now() - current.startedAt);
					setBars(current.levels.slice(-LIVE_BARS));
				}, SAMPLE_MS);
			},
			(err: unknown) => {
				if (!active) return;
				const name = err instanceof Error ? err.name : "";
				const text =
					name === "NotAllowedError" || name === "SecurityError" ? copy.recorder.denied : name === "NotFoundError" ? copy.recorder.noMic : copy.recorder.failed;
				setPhase({ kind: "error", text });
			},
		);
		return () => {
			active = false;
			clearInterval(timer);
			stopSession(session.current);
			session.current = null;
		};
	}, [copy]);

	// "đang ghi âm…" for the chat while recording; the core drops repeats.
	const recording = phase.kind === "recording";
	useEffect(() => {
		if (!recording) return;
		const say = (action: "voice" | "cancel") => void source.sendTyping(target.chatId, target.topicId, action).catch(() => undefined);
		say("voice");
		const timer = setInterval(() => say("voice"), TYPING_REPEAT_MS);
		return () => {
			clearInterval(timer);
			say("cancel");
		};
	}, [recording, source, target.chatId, target.topicId]);

	useEffect(() => {
		if (phase.kind === "recording") sendButton.current?.focus();
		else cancelButton.current?.focus();
	}, [phase.kind]);

	const cancel = () => {
		if (phase.kind === "recording") toasts.show(copy.recorder.cancelled);
		onClose();
	};

	const send = () => {
		const current = session.current;
		if (current === null) return;
		const duration = Date.now() - current.startedAt;
		if (duration < MIN_MS) {
			toasts.show(copy.recorder.tooShort);
			onClose();
			return;
		}
		const levels = [...current.levels];
		current.recorder.addEventListener(
			"stop",
			() => {
				const blob = new Blob(current.chunks, { type: current.recorder.mimeType || "audio/webm" });
				sendVoice(source, target, blob, duration, levels).catch(() => toasts.show(copy.recorder.failed));
			},
			{ once: true },
		);
		stopSession(current);
		session.current = null;
		onClose();
	};

	return (
		<div
			className="recorder"
			role="group"
			aria-label={copy.recorder.record}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					cancel();
				}
			}}
		>
			<button ref={cancelButton} type="button" className="icon-btn" aria-label={copy.recorder.cancel} onClick={cancel}>
				<Icon name={phase.kind === "error" ? "x" : "trash"} />
			</button>
			{phase.kind === "recording" ? (
				<>
					<span className="rec-dot" aria-hidden="true" />
					<span className="rec-time" role="timer" aria-label={copy.recorder.recording}>
						{formatDuration(elapsed)}
					</span>
					<span className="rec-wave" aria-hidden="true">
						{bars.map((level, index) => (
							<i key={index} style={{ height: `${Math.max(10, Math.round(level * 100))}%` }} />
						))}
					</span>
				</>
			) : (
				<span className={phase.kind === "error" ? "rec-note err" : "rec-note"} role={phase.kind === "error" ? "alert" : "status"}>
					{phase.kind === "error" ? phase.text : copy.recorder.asking}
				</span>
			)}
			<button ref={sendButton} type="button" className="send" aria-label={copy.recorder.send} disabled={phase.kind !== "recording"} onClick={send}>
				{phase.kind === "recording" ? <Icon name="send" /> : <MediaIcon name="stop" />}
			</button>
		</div>
	);
}
