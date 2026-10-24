// The app's own notification tone (Web Audio, no sound file): played for
// sound "Nhẹ" (quieter, the system notification is silent) and, when the
// user turned it on, for messages arriving in the chat that is open.
import type { NotificationSound } from "@achoo254/chat-core";

const GAIN: Record<NotificationSound, number> = { default: 0.18, soft: 0.06, off: 0 };
const TONE_HZ = 880;
const TONE_SECONDS = 0.18;

let context: AudioContext | null = null;

/** Plays a short tone at the volume of `sound`; silently does nothing where audio is unavailable or blocked. */
export function playTone(sound: NotificationSound): void {
	const gain = GAIN[sound];
	if (gain === 0 || typeof AudioContext === "undefined") return;
	try {
		context ??= new AudioContext();
		const audio = context;
		const start = audio.currentTime;
		const oscillator = audio.createOscillator();
		const envelope = audio.createGain();
		oscillator.frequency.value = TONE_HZ;
		envelope.gain.setValueAtTime(gain, start);
		envelope.gain.exponentialRampToValueAtTime(0.0001, start + TONE_SECONDS);
		oscillator.connect(envelope).connect(audio.destination);
		oscillator.start(start);
		oscillator.stop(start + TONE_SECONDS);
	} catch {
		// Autoplay rules can refuse audio before the user interacted with the page.
	}
}
