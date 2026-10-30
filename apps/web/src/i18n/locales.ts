// The UI languages and where Chat kept its language before the shared
// choice: plain data, read by the app (i18n.tsx) and by the build
// (vite-lang-bootstrap.ts, the page's language before the bundle runs).
import { SHELL_LOCALES, type ShellLocale } from "@achoo254/app-shell";

/**
 * Languages of the whole app, signed in or not: Vietnamese, English and
 * Simplified Chinese, the shared shell's full set (@achoo254/app-shell).
 */
export type Locale = ShellLocale;

/** Every language of the UI, in the order the language switches list them. */
export const LOCALES: readonly Locale[] = SHELL_LOCALES;

/** Chat's localStorage key of the language before the shared `hd_lang` cookie. */
export const LEGACY_LANG_KEY = "locale";
