import { lazyCopy } from "../../i18n/i18n.tsx";
import { viBots } from "./copy-vi.ts";

/**
 * Copy of the bot screens in the current UI language. Vietnamese ships with
 * the bot screens; other languages are fetched the first time they are needed
 * (the screen suspends meanwhile).
 */
export const useBotsCopy = lazyCopy(viBots, {
	en: () => import("./copy-en.ts").then((module) => module.enBots),
	"zh-CN": () => import("./copy-zh-CN.ts").then((module) => module.zhCNBots),
});
