// The sounds of life in the camera's view (off by default, like every office
// sound): loops while someone in view runs on a treadmill, watches TV or sleeps
// (a bed, or dozing off over a stuck tool), and short cues now and then while
// someone punches the bag, eats or watches TV. Only the asset file's sound
// files play (no tones: a missing file is silence). lifeSoundsWanted is the
// decision, pure for tests; createLifeSounds plays it with WebAudio.
import type { Pose } from "../character/anim-groups.ts";
import type { SoundFile } from "../scene/scene-assets.ts";

export type LifeLoop = "treadmill" | "tv-show" | "snore";
export type LifeCue = "punch" | "cutlery" | "cheer-tv";

/** How often a cue repeats while its act goes on, seconds. */
export const CUE_EVERY: Readonly<Record<LifeCue, number>> = { punch: 1.2, cutlery: 5, "cheer-tv": 25 };

export interface HeardPerson {
	/** In the camera's view. */
	readonly visible: boolean;
	readonly pose: Pose;
	readonly dozing: boolean;
}

const LOOP_OF: Partial<Record<Pose, LifeLoop>> = { run: "treadmill", watch: "tv-show", "watch-low": "tv-show", dance: "tv-show", sleep: "snore" };
const CUE_OF: Partial<Record<Pose, LifeCue>> = { punch: "punch", eat: "cutlery", "sit-eat": "cutlery", watch: "cheer-tv", "watch-low": "cheer-tv" };

/** The loops and cues the people in the camera's view call for. */
export function lifeSoundsWanted(people: readonly HeardPerson[]): { readonly loops: ReadonlySet<LifeLoop>; readonly cues: ReadonlySet<LifeCue> } {
	const loops = new Set<LifeLoop>();
	const cues = new Set<LifeCue>();
	for (const p of people) {
		if (!p.visible) continue;
		const loop = p.dozing ? "snore" : LOOP_OF[p.pose];
		if (loop !== undefined) loops.add(loop);
		const cue = CUE_OF[p.pose];
		if (cue !== undefined) cues.add(cue);
	}
	return { loops, cues };
}

export interface LifeSounds {
	setEnabled(on: boolean): void;
	frame(seconds: number, people: readonly HeardPerson[]): void;
	dispose(): void;
}

/** Played softer than the event sounds: life is the background of the background. */
const LIFE_GAIN = 0.3;
const NAMES: readonly (LifeLoop | LifeCue)[] = ["treadmill", "tv-show", "snore", "punch", "cutlery", "cheer-tv"];

export function createLifeSounds(sounds: ReadonlyMap<string, SoundFile>, urlOf: (name: string) => string): LifeSounds {
	let context: AudioContext | null = null;
	let enabled = false;
	const buffers = new Map<string, AudioBuffer>();
	const playing = new Map<LifeLoop, AudioBufferSourceNode>();
	const lastCue = new Map<LifeCue, number>();

	const load = (ctx: AudioContext): void => {
		for (const name of NAMES) {
			const file = sounds.get(name);
			if (file === undefined || buffers.has(name)) continue;
			void fetch(urlOf(file.file))
				.then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
				.then((data) => ctx.decodeAudioData(data))
				.then((buffer) => buffers.set(name, buffer))
				.catch((error: unknown) => console.info(`office: sound ${name} not loaded`, error));
		}
	};
	const start = (ctx: AudioContext, name: string, loop: boolean): AudioBufferSourceNode | null => {
		const buffer = buffers.get(name);
		if (buffer === undefined) return null;
		const node = ctx.createBufferSource();
		const gain = ctx.createGain();
		node.buffer = buffer;
		node.loop = loop;
		gain.gain.value = LIFE_GAIN;
		node.connect(gain).connect(ctx.destination);
		node.start();
		return node;
	};
	const stopAll = (): void => {
		for (const node of playing.values()) node.stop();
		playing.clear();
	};
	return {
		setEnabled(on) {
			enabled = on;
			if (!on) {
				stopAll();
				return;
			}
			if (context === null && typeof AudioContext === "function") context = new AudioContext();
			if (context !== null) load(context);
		},
		frame(seconds, people) {
			const ctx = context;
			if (!enabled || ctx === null) return;
			const wanted = lifeSoundsWanted(people);
			for (const [loop, node] of playing) {
				if (wanted.loops.has(loop)) continue;
				node.stop();
				playing.delete(loop);
			}
			for (const loop of wanted.loops) {
				if (playing.has(loop)) continue;
				const node = start(ctx, loop, true);
				if (node !== null) playing.set(loop, node);
			}
			for (const cue of wanted.cues) {
				if (seconds - (lastCue.get(cue) ?? -Infinity) < CUE_EVERY[cue]) continue;
				lastCue.set(cue, seconds);
				start(ctx, cue, false);
			}
		},
		dispose() {
			stopAll();
			void context?.close().catch(() => undefined);
			context = null;
			buffers.clear();
		},
	};
}
