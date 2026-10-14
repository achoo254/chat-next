import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { en } from "./en.ts";
import { vi, type Messages } from "./vi.ts";

export type Locale = "vi" | "en";

const MESSAGES: Record<Locale, Messages> = { vi, en };
const STORAGE_KEY = "locale";

function isLocale(value: unknown): value is Locale {
	return value === "vi" || value === "en";
}

/** The remembered locale; Vietnamese unless the user picked English. */
export function readStoredLocale(): Locale {
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return isLocale(stored) ? stored : "vi";
	} catch {
		// Storage can be blocked (privacy settings); fall back to the default.
		return "vi";
	}
}

function storeLocale(locale: Locale): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, locale);
	} catch {
		// Not remembering the choice is acceptable when storage is blocked.
	}
}

interface I18n {
	locale: Locale;
	t: Messages;
	setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const value = useMemo<I18n>(
		() => ({
			locale,
			t: MESSAGES[locale],
			setLocale: (next) => {
				storeLocale(next);
				setLocaleState(next);
			},
		}),
		[locale],
	);
	return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
	const i18n = useContext(I18nContext);
	if (!i18n) throw new Error("useI18n must be used inside <I18nProvider>");
	return i18n;
}
