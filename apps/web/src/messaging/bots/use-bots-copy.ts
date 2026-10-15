import { use } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { viBots, type BotsCopy } from "./copy-vi.ts";

// Vietnamese ships with the bot screens; English is fetched the first time it
// is needed (the screen suspends meanwhile).
let english: Promise<BotsCopy> | null = null;

function loadEnglish(): Promise<BotsCopy> {
	english ??= import("./copy-en.ts").then((module) => module.enBots);
	return english;
}

/** Copy of the bot screens in the current UI language. */
export function useBotsCopy(): BotsCopy {
	const { locale } = useI18n();
	const pending = locale === "en" ? loadEnglish() : null;
	return pending === null ? viBots : use(pending);
}
