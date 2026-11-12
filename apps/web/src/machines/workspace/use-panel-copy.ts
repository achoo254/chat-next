import { lazyCopy } from "../../i18n/i18n.tsx";
import { viPanel } from "./panel-copy-vi.ts";

/** Copy of the workspace panel in the UI language; Vietnamese ships with the panel's chunk, the others load on first use. */
export const usePanelCopy = lazyCopy(viPanel, {
	en: () => import("./panel-copy-en.ts").then((module) => module.enPanel),
	"zh-CN": () => import("./panel-copy-zh-CN.ts").then((module) => module.zhCNPanel),
});
