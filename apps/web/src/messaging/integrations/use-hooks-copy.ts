import { lazyCopy } from "../../i18n/i18n.tsx";
import { viHooks } from "./copy-vi.ts";

/**
 * Copy of the webhook screens in the current UI language. Vietnamese ships
 * with the webhook screens; other languages are fetched the first time they
 * are needed (the screen suspends meanwhile).
 */
export const useHooksCopy = lazyCopy(viHooks, {
	en: () => import("./copy-en.ts").then((module) => module.enHooks),
	"zh-CN": () => import("./copy-zh-CN.ts").then((module) => module.zhCNHooks),
});
