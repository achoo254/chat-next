// Office sounds, off by default (plan decision 3): played for events on the
// floor shown only (the approval chime plays from any floor), and only once
// the viewer turned sound on (that tap also unlocks audio in the browser).
// Uses the sound files the asset file lists when present, else short tones
// made with WebAudio, so sound works before the generated sounds ship.
import type { PeopleEvent } from "../character/office-people.ts";

export type OfficeSound = PeopleEvent | "power-off" | "power-on";

export interface OfficeSfx {
	setEnabled(on: boolean): void;
	play(sound: OfficeSound): void;
	dispose(): void;
}

/** Tone recipes: [frequency Hz, start s, length s] notes, and the wave. */
const TONES: Readonly<Record<OfficeSound, { wave: OscillatorType; notes: readonly (readonly [number, number, number])[]; gain: number }>> = {
	"arrive-lift": { wave: "sine", notes: [[1318, 0, 0.35]], gain: 0.12 },
	"start-work": { wave: "square", notes: [[1900, 0, 0.02], [1700, 0.08, 0.02], [2000, 0.15, 0.02]], gain: 0.025 },
	cheer: { wave: "triangle", notes: [[660, 0, 0.12], [880, 0.12, 0.12], [1320, 0.24, 0.25]], gain: 0.1 },
	smoke: { wave: "sawtooth", notes: [[180, 0, 0.4]], gain: 0.04 },
	approval: { wave: "sine", notes: [[988, 0, 0.18], [784, 0.2, 0.3]], gain: 0.12 },
	"power-off": { wave: "sawtooth", notes: [[220, 0, 0.15], [110, 0.15, 0.35]], gain: 0.06 },
	"power-on": { wave: "triangle", notes: [[330, 0, 0.1], [660, 0.1, 0.2]], gain: 0.07 },
};

/** Fewest milliseconds between two plays of one sound (a burst of tools must not buzz). */
const MIN_GAP_MS = 400;

export function createOfficeSfx(files: ReadonlyMap<string, string>, urlOf: (name: string) => string): OfficeSfx {
	let context: AudioContext | null = null;
	let enabled = false;
	const buffers = new Map<string, AudioBuffer | null>();
	const lastPlayed = new Map<OfficeSound, number>();

	const ensure = (): AudioContext | null => {
		if (context === null && typeof AudioContext === "function") context = new AudioContext();
		if (context?.state === "suspended") void context.resume().catch(() => undefined);
		return context;
	};
	const loadFile = (ctx: AudioContext, name: string, file: string): void => {
		if (buffers.has(name)) return;
		buffers.set(name, null);
		void fetch(urlOf(file))
			.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
			.then((data) => ctx.decodeAudioData(data))
			.then((buffer) => buffers.set(name, buffer))
			.catch((error: unknown) => console.info(`office: sound ${name} not loaded, using a tone`, error));
	};
	const tone = (ctx: AudioContext, sound: OfficeSound): void => {
		const recipe = TONES[sound];
		const start = ctx.currentTime;
		for (const [frequency, at, length] of recipe.notes) {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			osc.type = recipe.wave;
			osc.frequency.value = frequency;
			gain.gain.setValueAtTime(recipe.gain, start + at);
			gain.gain.exponentialRampToValueAtTime(0.0001, start + at + length);
			osc.connect(gain).connect(ctx.destination);
			osc.start(start + at);
			osc.stop(start + at + length + 0.02);
		}
	};
	return {
		setEnabled(on) {
			enabled = on;
			if (!on) return;
			const ctx = ensure();
			if (ctx !== null) for (const [name, file] of files) loadFile(ctx, name, file);
		},
		play(sound) {
			if (!enabled) return;
			const ctx = ensure();
			if (ctx === null) return;
			const now = performance.now();
			if (now - (lastPlayed.get(sound) ?? -Infinity) < MIN_GAP_MS) return;
			lastPlayed.set(sound, now);
			const buffer = buffers.get(sound);
			if (buffer == null) {
				tone(ctx, sound);
				return;
			}
			const node = ctx.createBufferSource();
			node.buffer = buffer;
			node.connect(ctx.destination);
			node.start();
		},
		dispose() {
			void context?.close().catch(() => undefined);
			context = null;
			buffers.clear();
		},
	};
}
