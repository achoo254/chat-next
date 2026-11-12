// Speech to text for the terminal's mic button, by the browser's own speech
// recognition (Safari and Chrome: webkitSpeechRecognition). Each final
// phrase goes to the terminal as typed text, never with Enter, so the user
// reads it before sending. A browser without it shows no mic button.
import { useEffect, useRef, useState } from "react";

interface RecognitionResult {
	readonly isFinal: boolean;
	readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
	readonly resultIndex: number;
	readonly results: ArrayLike<RecognitionResult>;
}
interface Recognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((event: RecognitionEvent) => void) | null;
	onend: (() => void) | null;
	onerror: ((event: { readonly error: string }) => void) | null;
	start(): void;
	stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
	if (typeof window === "undefined") return undefined;
	const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** The speech language for an app locale ("vi" → "vi-VN"). */
export function speechLang(locale: string): string {
	if (locale === "vi") return "vi-VN";
	if (locale.startsWith("zh")) return "zh-CN";
	return "en-US";
}

/** Joins phrases as speech gives them: one space between, none before the first. */
export function phraseText(phrase: string, first: boolean): string {
	const text = phrase.trim();
	if (text === "") return "";
	return first ? text : ` ${text}`;
}

export interface Dictation {
	readonly supported: boolean;
	readonly listening: boolean;
	/** The phrase heard so far, before it is final. */
	readonly interim: string;
	/** Why it stopped on its own ("not-allowed" when the microphone is refused), else "". */
	readonly error: string;
	toggle(): void;
}

export function useDictation(locale: string, onText: (text: string) => void): Dictation {
	const ctor = recognitionCtor();
	const [listening, setListening] = useState(false);
	const [interim, setInterim] = useState("");
	const [error, setError] = useState("");
	const current = useRef<Recognition | null>(null);
	const sentAny = useRef(false);
	const send = useRef(onText);
	useEffect(() => {
		send.current = onText;
	});
	useEffect(() => () => current.current?.stop(), []);

	const toggle = () => {
		if (ctor === undefined) return;
		if (current.current !== null) {
			current.current.stop();
			return;
		}
		const rec = new ctor();
		rec.lang = speechLang(locale);
		rec.continuous = true;
		rec.interimResults = true;
		sentAny.current = false;
		rec.onresult = (event) => {
			let pending = "";
			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				if (result === undefined) continue;
				if (result.isFinal) {
					const text = phraseText(result[0].transcript, !sentAny.current);
					if (text !== "") {
						send.current(text);
						sentAny.current = true;
					}
				} else pending += result[0].transcript;
			}
			setInterim(pending);
		};
		rec.onerror = (event) => setError(event.error);
		rec.onend = () => {
			current.current = null;
			setListening(false);
			setInterim("");
		};
		current.current = rec;
		setError("");
		setListening(true);
		try {
			rec.start();
		} catch {
			current.current = null;
			setListening(false);
		}
	};

	return { supported: ctor !== undefined, listening, interim, error, toggle };
}
