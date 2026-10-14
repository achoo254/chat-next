import { use } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import type { MessagingCopy } from "./vi.ts";
import { vi } from "./vi.ts";
import { viScreens, type ScreensCopy } from "./vi-screens.ts";

// Copy for screens loaded on demand; imported only by those screens so their
// strings stay out of the first chunk. English is fetched when first needed.
export type FullCopy = MessagingCopy & ScreensCopy;

/** `info` is split: presence words ship with the first chunk, the rest with the screens. */
function merge(base: MessagingCopy, screens: ScreensCopy): FullCopy {
	return { ...base, ...screens, info: { ...base.info, ...screens.info } };
}

const vietnamese: FullCopy = merge(vi, viScreens);
let english: Promise<FullCopy> | null = null;

function loadEnglish(): Promise<FullCopy> {
	english ??= Promise.all([import("./en.ts"), import("./en-screens.ts")]).then(([base, screens]) => merge(base.en, screens.enScreens));
	return english;
}

export function useScreensCopy(): FullCopy {
	const { locale } = useI18n();
	const pending = locale === "en" ? loadEnglish() : null;
	return pending === null ? vietnamese : use(pending);
}
