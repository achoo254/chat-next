import { readPreferences, subscribePreferences } from "@achoo254/app-shell/preferences";
import { createContext, use, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { brand } from "../brand.ts";
import { LEGACY_LANG_KEY, LOCALES, type Locale } from "./locales.ts";
import { vi, type Messages } from "./vi.ts";

export { LOCALES, type Locale };

/** Languages fetched on demand: every one but the default Vietnamese. */
export type LazyLocale = Exclude<Locale, "vi">;

const LOADERS: Readonly<Record<LazyLocale, () => Promise<Messages>>> = {
	en: () => import("./en.ts").then((module) => module.en),
	"zh-CN": () => import("./zh-CN.ts").then((module) => module.zhCN),
};

/**
 * A fetch of a language's copy. Once in, it carries the copy the way React
 * reads a settled promise (`status`, `value`), so `use` returns it at once.
 */
type MessagesFetch = Promise<Messages> & ({ status?: undefined } | { status: "fulfilled"; value: Messages });

// Vietnamese is the default and ships with the first screen; other languages
// are fetched the first time they are needed. Once in, they are read
// synchronously, so later renders never suspend.
const loaded = new Map<LazyLocale, Messages>();
const loading = new Map<LazyLocale, MessagesFetch>();

function loadMessages(locale: LazyLocale): MessagesFetch {
	let pending = loading.get(locale);
	if (pending === undefined) {
		const fetching: MessagesFetch = LOADERS[locale]().then(
			(messages) => {
				loaded.set(locale, messages);
				Object.assign(fetching, { status: "fulfilled", value: messages });
				return messages;
			},
			(err: unknown) => {
				// Offline: the next attempt fetches again.
				loading.delete(locale);
				throw err;
			},
		);
		pending = fetching;
		loading.set(locale, pending);
	}
	return pending;
}

/**
 * Messages for `locale`; suspends only while a language is first fetched.
 * `use` runs on every render of a fetched language, loaded or not: React
 * replays a suspended first render once the fetch is in, and that replay
 * must call the same hooks.
 */
function useMessages(locale: Locale): Messages {
	if (locale === "vi") return vi;
	return use(loadMessages(locale));
}

/**
 * The remembered language: the shared choice of every hoandat.com app
 * (`hd_lang`, this WebView's storage in the native app), else the one picked
 * in Chat before that choice existed, else Vietnamese.
 */
export function readStoredLocale(): Locale {
	return readPreferences({ domain: brand.domain, legacyLangKey: LEGACY_LANG_KEY, locales: LOCALES }).lang ?? "vi";
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
			if (next === "vi" || loaded.has(next)) {
				setLocaleState(next);
				return;
			}
			// Switch once the copy is in, so the screen never blanks while it
			// loads; when it cannot load (offline), the language stays as it was.
			loadMessages(next).then(
				() => setLocaleState(next),
				() => undefined,
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

/**
 * A hook giving `vietnamese` copy, or the copy of the current language,
 * fetched the first time it is needed (the screen suspends meanwhile). For
 * copy that ships with a screen's own chunk rather than with the app.
 */
export function lazyCopy<T>(vietnamese: T, loaders: Readonly<Record<LazyLocale, () => Promise<T>>>): () => T {
	const pending = new Map<LazyLocale, Promise<T>>();
	const load = (locale: LazyLocale): Promise<T> => {
		let copy = pending.get(locale);
		if (copy === undefined) {
			copy = loaders[locale]();
			pending.set(locale, copy);
		}
		return copy;
	};
	return function useLocaleCopy(): T {
		const { locale } = useI18n();
		return locale === "vi" ? vietnamese : use(load(locale));
	};
}
