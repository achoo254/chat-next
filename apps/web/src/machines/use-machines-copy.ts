import { lazyCopy } from "../i18n/i18n.tsx";
import { viMachines } from "./copy-vi.ts";

/**
 * Copy of the AI Agent screens in the current UI language. Vietnamese
 * ships with the screens; other languages load the first time they are
 * needed (the screen suspends meanwhile).
 */
export const useMachinesCopy = lazyCopy(viMachines, {
	en: () => import("./copy-en.ts").then((module) => module.enMachines),
	"zh-CN": () => import("./copy-zh-CN.ts").then((module) => module.zhCNMachines),
});
