import { use } from "react";
import { useI18n } from "../../i18n/i18n.tsx";
import { vi, type MessagingCopy } from "./vi.ts";

// Vietnamese is the default and ships with the messaging chunk; English is
// fetched the first time it is needed (the screen suspends meanwhile).
let english: Promise<MessagingCopy> | null = null;

function loadEnglish(): Promise<MessagingCopy> {
	english ??= import("./en.ts").then((module) => module.en);
	return english;
}

/** Messaging copy in the current UI language. */
export function useCopy(): MessagingCopy {
	const { locale } = useI18n();
	const pending = locale === "en" ? loadEnglish() : null;
	return pending === null ? vi : use(pending);
}
