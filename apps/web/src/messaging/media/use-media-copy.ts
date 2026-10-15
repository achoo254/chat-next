import { use } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { viMedia, type MediaCopy } from "./copy-vi.ts";

// Vietnamese ships with the media screens; English is fetched the first
// time it is needed (the component suspends meanwhile).
let english: Promise<MediaCopy> | null = null;

function loadEnglish(): Promise<MediaCopy> {
	english ??= import("./copy-en.ts").then((module) => module.enMedia);
	return english;
}

/** Copy of the media screens in the current UI language. */
export function useMediaCopy(): MediaCopy {
	const { locale } = useI18n();
	const pending = locale === "en" ? loadEnglish() : null;
	return pending === null ? viMedia : use(pending);
}
