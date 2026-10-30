import { lazyCopy } from "../../i18n/i18n.tsx";
import type { MessagingCopy } from "./vi.ts";
import { vi } from "./vi.ts";
import { viScreens, type ScreensCopy } from "./vi-screens.ts";

// Copy for screens loaded on demand; imported only by those screens so their
// strings stay out of the first chunk. Other languages are fetched when first
// needed.
export type FullCopy = MessagingCopy & ScreensCopy;

/** `info` is split: presence words ship with the first chunk, the rest with the screens. */
function merge(base: MessagingCopy, screens: ScreensCopy): FullCopy {
	return { ...base, ...screens, info: { ...base.info, ...screens.info } };
}

export const useScreensCopy = lazyCopy(merge(vi, viScreens), {
	en: () => Promise.all([import("./en.ts"), import("./en-screens.ts")]).then(([base, screens]) => merge(base.en, screens.enScreens)),
	"zh-CN": () =>
		Promise.all([import("./zh-CN.ts"), import("./zh-CN-screens.ts")]).then(([base, screens]) => merge(base.zhCN, screens.zhCNScreens)),
});
