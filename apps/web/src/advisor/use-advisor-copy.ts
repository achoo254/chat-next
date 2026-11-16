import { lazyCopy } from "../i18n/i18n.tsx";
import { viAdvisor } from "./copy-vi.ts";

/** Copy of Advisor in the current UI language; other languages than Vietnamese load on first use (the caller suspends). */
export const useAdvisorCopy = lazyCopy(viAdvisor, {
	en: () => import("./copy-en.ts").then((module) => module.enAdvisor),
	"zh-CN": () => import("./copy-zh-CN.ts").then((module) => module.zhCNAdvisor),
});
