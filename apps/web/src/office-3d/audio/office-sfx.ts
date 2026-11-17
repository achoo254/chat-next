// Office sounds, off by default (plan decision 3): played for events of the
// people in the camera's view only (the approval chime plays wherever the
// person is), and only once
// the viewer turned sound on (that tap also unlocks audio in the browser).
// Uses the sound files the asset file lists when present (its names are the
// sounds' own, mapped to scene events by SOUND_FILES), else short tones made
// with WebAudio, so sound works before (or without) a generated sound. Event
// sounds play once even when the file is a loop.
import type { PeopleEvent } from "../character/office-people.ts";
import type { SoundFile } from "../scene/scene-assets.ts";

export type OfficeSound = PeopleEvent | "power-off" | "power-on";

export interface OfficeSfx {
	setEnabled(on: boolean): void;
	play(sound: OfficeSound): void;
	dispose(): void;
}

/** Tone recipes: [frequency Hz, start s, length s] notes, and the wave. */
const TONES: Readonly<Record<OfficeSound, { wave: OscillatorType; notes: readonly (readonly [number, number, number])[]; gain: number }>> = {
	"start-work": { wave: "square", notes: [[1900, 0, 0.02], [1700, 0.08, 0.02], [2000, 0.15, 0.02]], gain: 0.025 },
	cheer: { wave: "triangle", notes: [[660, 0, 0.12], [880, 0.12, 0.12], [1320, 0.24, 0.25]], gain: 0.1 },
	smoke: { wave: "sawtooth", notes: [[180, 0, 0.4]], gain: 0.04 },
	approval: { wave: "sine", notes: [[988, 0, 0.18], [784, 0.2, 0.3]], gain: 0.12 },
	"power-off": { wave: "sawtooth", notes: [[220, 0, 0.15], [110, 0.15, 0.35]], gain: 0.06 },
	"power-on": { wave: "triangle", notes: [[330, 0, 0.1], [660, 0.1, 0.2]], gain: 0.07 },
};

/**
 * The asset file's sound names each event uses, best first: keys when work starts, the
 * crowd's cheer on a pass, a puff of steam for the failure's smoke, the phone ringing for an approval waiting on the
 * viewer, the light switch on power changes. An event with none of its names in the file plays its tone.
 */
export const SOUND_FILES: Readonly<Record<OfficeSound, readonly string[]>> = {
	"start-work": ["typing"],
	cheer: ["cheer"],
	smoke: ["steam-puff"],
	approval: ["phone-ring", "stamp"],
	"power-off": ["light-switch"],
	"power-on": ["light-switch"],
};

/** Scene sound → file, for the events the asset file has a sound for. */
export function eventSoundFiles(sounds: ReadonlyMap<string, SoundFile>): Map<OfficeSound, string> {
	const out = new Map<OfficeSound, string>();
	for (const [event, names] of Object.entries(SOUND_FILES) as [OfficeSound, readonly string[]][]) {
		const found = names.map((name) => sounds.get(name)).find((s) => s !== undefined);
		if (found !== undefined) out.set(event, found.file);
	}
	return out;
}

/** Generated sounds are mastered loud; the office is background. */
const FILE_GAIN = 0.5;

/** Fewest milliseconds between two plays of one sound (a burst of tools must not buzz). */
const MIN_GAP_MS = 400;

/** `files`: scene sound → file under the asset folder (eventSoundFiles). */
export function createOfficeSfx(files: ReadonlyMap<OfficeSound, string>, urlOf: (name: string) => string): OfficeSfx {
	let context: AudioContext | null = null;
	let enabled = false;
	const buffers = new Map<OfficeSound, AudioBuffer | null>();
	const lastPlayed = new Map<OfficeSound, number>();

	const ensure = (): AudioContext | null => {
		if (context === null && typeof AudioContext === "function") context = new AudioContext();
		if (context?.state === "suspended") void context.resume().catch(() => undefined);
		return context;
	};
	const loadFile = (ctx: AudioContext, name: OfficeSound, file: string): void => {
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
			const gain = ctx.createGain();
			node.buffer = buffer;
			gain.gain.value = FILE_GAIN;
			node.connect(gain).connect(ctx.destination);
			node.start();
		},
		dispose() {
			void context?.close().catch(() => undefined);
			context = null;
			buffers.clear();
		},
	};
}
