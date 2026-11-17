import { lazyCopy } from "../../i18n/i18n.tsx";
import { viBridge } from "./bridge-copy-vi.ts";

/** Copy of Settings › Kết nối ứng dụng in the current language; other languages than Vietnamese load on first use (the caller suspends). */
export const useBridgeCopy = lazyCopy(viBridge, {
	en: () => import("./bridge-copy-en.ts").then((module) => module.enBridge),
	"zh-CN": () => import("./bridge-copy-zh-CN.ts").then((module) => module.zhCNBridge),
});
