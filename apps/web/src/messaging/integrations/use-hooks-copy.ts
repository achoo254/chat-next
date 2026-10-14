import { use } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { viHooks, type HooksCopy } from "./copy-vi.ts";

// Vietnamese ships with the webhook screens; English is fetched the first
// time it is needed (the screen suspends meanwhile).
let english: Promise<HooksCopy> | null = null;

function loadEnglish(): Promise<HooksCopy> {
	english ??= import("./copy-en.ts").then((module) => module.enHooks);
	return english;
}

/** Copy of the webhook screens in the current UI language. */
export function useHooksCopy(): HooksCopy {
	const { locale } = useI18n();
	const pending = locale === "en" ? loadEnglish() : null;
	return pending === null ? viHooks : use(pending);
}
