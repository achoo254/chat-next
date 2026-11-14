// Icons drawn by the offline image model (ComfyUI on the home PC) and used as
// CSS masks, so they take the surrounding text color like the line icons do.
// ai-marks/*.webp: AI-generated for the hoandat ecosystem; owned by hoandat,
// all rights reserved (not CC0).
import type { CSSProperties } from "react";
import accountUrl from "./ai-marks/ai-account.webp";
import changesUrl from "./ai-marks/ai-changes.webp";
import agentUrl from "./ai-marks/ai-agent.webp";
import modelUrl from "./ai-marks/ai-model.webp";
import permissionUrl from "./ai-marks/ai-permission.webp";
import projectUrl from "./ai-marks/ai-project.webp";
import sessionUrl from "./ai-marks/ai-session.webp";
import skillsUrl from "./ai-marks/ai-skills.webp";

const MARKS = { agent: agentUrl, session: sessionUrl, project: projectUrl, model: modelUrl, permission: permissionUrl, account: accountUrl, changes: changesUrl, skills: skillsUrl } as const;

export type AiMarkName = keyof typeof MARKS;

/** Decorative; the surrounding control carries the accessible name. */
export function AiMark({ name, small = false }: { name: AiMarkName; small?: boolean }) {
	const url = `url("${MARKS[name]}")`;
	const style: CSSProperties = { WebkitMaskImage: url, maskImage: url };
	return <span className={small ? "ai-mark ai-mark-sm" : "ai-mark"} style={style} aria-hidden="true" />;
}
