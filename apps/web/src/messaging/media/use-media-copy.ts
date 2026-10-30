import { lazyCopy } from "../../i18n/i18n.tsx";
import { viMedia } from "./copy-vi.ts";

/**
 * Copy of the media screens in the current UI language. Vietnamese ships
 * with the media screens; other languages are fetched the first time they
 * are needed (the component suspends meanwhile).
 */
export const useMediaCopy = lazyCopy(viMedia, {
	en: () => import("./copy-en.ts").then((module) => module.enMedia),
	"zh-CN": () => import("./copy-zh-CN.ts").then((module) => module.zhCNMedia),
});
