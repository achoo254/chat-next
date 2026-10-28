import { DEFAULT_SHELL_LOCALES, type DefaultShellLocale } from "@achoo254/app-shell";
import { readPreferences, subscribePreferences } from "@achoo254/app-shell/preferences";
import { createContext, use, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { brand } from "../brand.ts";
import { vi, type Messages } from "./vi.ts";

/**
 * Languages of the whole app, signed in or not: Vietnamese and English, the
 * shared shell's default pair (@achoo254/app-shell). A `zh-CN` choice
 * another hoandat.com app stored counts as no choice here.
 */
export type Locale = DefaultShellLocale;

/** Every language of the UI, in the order the language switches list them. */
export const LOCALES: readonly Locale[] = DEFAULT_SHELL_LOCALES;

/** Chat's localStorage key of the language before the shared `hd_lang` cookie. */
const LEGACY_LANG_KEY = "locale";

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

/**
 * The remembered language: the shared choice of every hoandat.com app
 * (`hd_lang`, this WebView's storage in the native app), else the one picked
 * in Chat before that choice existed, else Vietnamese.
 */
export function readStoredLocale(): Locale {
	return readPreferences({ domain: brand.domain, legacyLangKey: LEGACY_LANG_KEY }).lang ?? "vi";
}

interface I18n {
	locale: Locale;
	t: Messages;
	/**
	 * Shows the app in the stored language: `onLocaleChange` of the shared
	 * language switches, which have already stored the choice.
	 */
	followStoredLocale: () => void;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(readStoredLocale);
	const t = useMessages(locale);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	const value = useMemo<I18n>(() => {
		const followStoredLocale = () => {
			const next = readStoredLocale();
			if (next === "vi" || english !== null) {
				setLocaleState(next);
				return;
			}
			// Switch once the copy is in, so the screen never blanks while it
			// loads; when it cannot load (offline), the language stays as it was.
			loadEnglish().then(
				() => setLocaleState(next),
				() => {
					englishLoad = null;
				},
			);
		};
		return { locale, t, followStoredLocale };
	}, [locale, t]);

	// A choice made here or in another app (noticed when the page comes back
	// into view) re-renders the app in place, without a reload.
	const { followStoredLocale } = value;
	useEffect(() => subscribePreferences(followStoredLocale), [followStoredLocale]);

	return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
	const i18n = useContext(I18nContext);
	if (!i18n) throw new Error("useI18n must be used inside <I18nProvider>");
	return i18n;
}
