// The four looks of Advisor (drawn offline on the GPU, transparent WebP
// 256 px; licence in docs/asset-licenses.md),
// each with its four moods and its main colours (from the idle picture).
// An unknown look id (a newer client's) shows the first look.
import catAnswering from "./assets/cat/answering.webp";
import catIdle from "./assets/cat/idle.webp";
import catSleeping from "./assets/cat/sleeping.webp";
import catThinking from "./assets/cat/thinking.webp";
import owlAnswering from "./assets/owl/answering.webp";
import owlIdle from "./assets/owl/idle.webp";
import owlSleeping from "./assets/owl/sleeping.webp";
import owlThinking from "./assets/owl/thinking.webp";
import robotAnswering from "./assets/robot/answering.webp";
import robotIdle from "./assets/robot/idle.webp";
import robotSleeping from "./assets/robot/sleeping.webp";
import robotThinking from "./assets/robot/thinking.webp";
import suitAnswering from "./assets/suit/answering.webp";
import suitIdle from "./assets/suit/idle.webp";
import suitSleeping from "./assets/suit/sleeping.webp";
import suitThinking from "./assets/suit/thinking.webp";
import type { Mood } from "./advisor-store.ts";

export type LookId = "owl" | "robot" | "suit" | "cat";
/** The pictures drawn: "connecting" shows the thinking one. */
type Picture = "idle" | "thinking" | "answering" | "sleeping";

export interface Look {
	readonly id: LookId;
	/** Body, belly, outline and accent colours. */
	readonly colors: { readonly body: string; readonly belly: string; readonly line: string; readonly accent: string };
	readonly pictures: Readonly<Record<Picture, string>>;
}

export const LOOKS: readonly Look[] = [
	{
		id: "owl",
		colors: { body: "#584B51", belly: "#E6CAA6", line: "#1A2032", accent: "#C89868" },
		pictures: { idle: owlIdle, thinking: owlThinking, answering: owlAnswering, sleeping: owlSleeping },
	},
	{
		id: "robot",
		colors: { body: "#648CAD", belly: "#CFE8F1", line: "#182B50", accent: "#69BED3" },
		pictures: { idle: robotIdle, thinking: robotThinking, answering: robotAnswering, sleeping: robotSleeping },
	},
	{
		id: "suit",
		colors: { body: "#223158", belly: "#FAC9AA", line: "#18172E", accent: "#4D89B9" },
		pictures: { idle: suitIdle, thinking: suitThinking, answering: suitAnswering, sleeping: suitSleeping },
	},
	{
		id: "cat",
		colors: { body: "#F29338", belly: "#EBCDA9", line: "#0F1D2D", accent: "#C35F26" },
		pictures: { idle: catIdle, thinking: catThinking, answering: catAnswering, sleeping: catSleeping },
	},
];

/** The look `id` names; the first look for an unknown one. */
export function lookOf(id: string): Look {
	const first = LOOKS[0];
	if (first === undefined) throw new Error("no Advisor looks");
	return LOOKS.find((look) => look.id === id) ?? first;
}

/** The picture of a mood. */
export function pictureOf(look: Look, mood: Mood): string {
	return look.pictures[mood === "connecting" ? "thinking" : mood];
}
