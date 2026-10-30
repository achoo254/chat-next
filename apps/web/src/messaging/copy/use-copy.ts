import { lazyCopy } from "../../i18n/i18n.tsx";
import { vi } from "./vi.ts";

/**
 * Messaging copy in the current UI language. Vietnamese is the default and
 * ships with the messaging chunk; other languages are fetched the first time
 * they are needed (the screen suspends meanwhile).
 */
export const useCopy = lazyCopy(vi, {
	en: () => import("./en.ts").then((module) => module.en),
	"zh-CN": () => import("./zh-CN.ts").then((module) => module.zhCN),
});
