import { createContext, use, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { vi, type Messages } from "./vi.ts";

export type Locale = "vi" | "en";

const STORAGE_KEY = "locale";

// Vietnamese is the default and ships with the first screen; English is
// fetched the first time it is needed. Once in, it is read synchronously, so
// later renders never suspend.
let english: Messages | null = null;
let englishLoad: Promise<Messages> | null = null;

function loadEnglish(): Promise<Messages> {
	englishLoad ??= import("./en.ts").then((module) => {
		english = module.en;
		return module.en;
	});
	return englishLoad;
}

/** Messages for `locale`; suspends only while English is first fetched. */
function useMessages(locale: Locale): Messages {
	if (locale === "vi") return vi;
	return english ?? use(loadEnglish());
}

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
	const t = useMessages(locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const value = useMemo<I18n>(
		() => ({
			locale,
			t,
			setLocale: (next) => {
				const apply = () => {
					storeLocale(next);
					setLocaleState(next);
				};
				if (next === "vi" || english !== null) {
					apply();
					return;
				}
				// Switch once the copy is in, so the screen never blanks while it
				// loads; when it cannot load (offline), the language stays as it was.
				loadEnglish().then(apply, () => {
					englishLoad = null;
				});
			},
		}),
		[locale, t],
	);
	return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
	const i18n = useContext(I18nContext);
	if (!i18n) throw new Error("useI18n must be used inside <I18nProvider>");
	return i18n;
}
