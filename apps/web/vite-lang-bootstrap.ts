// Gives the page before the bundle runs (the splash of index.html) the
// visitor's language: an inline script in the <head> sets <html lang> from
// the shared choice, the way i18n.tsx reads it (readPreferences of
// @achoo254/app-shell), and the splash carries its text in every language,
// app.css showing the one of <html lang>. The CSP of
// infra/chat/nginx/chat.hoandat.com.conf allows exactly this script by its
// hash (test/lang-bootstrap.test.ts keeps the two in step); until the
// server's conf has it, the browser skips the script and the page stays
// Vietnamese, as it was.
import { PREFERENCE_KEYS } from "@achoo254/app-shell/preferences";
import type { Plugin } from "vite";
import { en } from "./src/i18n/en.ts";
import { LEGACY_LANG_KEY, LOCALES, type Locale } from "./src/i18n/locales.ts";
import { vi } from "./src/i18n/vi.ts";
import { zhCN } from "./src/i18n/zh-CN.ts";

/** Placeholder in index.html (in the <head>, after the theme script) for the inline language script. */
export const LANG_BOOTSTRAP_MARKER = "<!--lang-bootstrap-->";

/** Placeholder in index.html for the splash text in every language. */
export const SPLASH_TEXT_MARKER = "<!--splash-text-->";

const LOADING: Readonly<Record<Locale, string>> = { vi: vi.common.loading, en: en.common.loading, "zh-CN": zhCN.common.loading };

/**
 * The inline script: the `hd_lang` cookie (on http and https pages, as the
 * shared preferences read it), else this WebView's storage, else Chat's
 * legacy key, matched by primary subtag like matchShellLocale; nothing
 * found keeps the page's "vi".
 */
export const LANG_BOOTSTRAP_SCRIPT = [
	"(function(){try{",
	`var L=${JSON.stringify(LOCALES)};`,
	'function m(t){if(typeof t!=="string")return null;var p=t.trim().toLowerCase().split(/[-_]/)[0];',
	'var l=p==="zh"?"zh-CN":p;return L.indexOf(l)>=0?l:null}',
	"var g=null;",
	`if(/^https?:$/.test(location.protocol)){var c=/(?:^|;\\s*)${PREFERENCE_KEYS.lang}=([^;]*)/.exec(document.cookie);`,
	"if(c){try{g=m(decodeURIComponent(c[1]))}catch(e){}}}",
	"var s=null;try{s=window.localStorage}catch(e){}",
	`if(!g&&s){g=m(s.getItem(${JSON.stringify(PREFERENCE_KEYS.lang)}))||m(s.getItem(${JSON.stringify(LEGACY_LANG_KEY)}))}`,
	"if(g){document.documentElement.lang=g}",
	"}catch(e){}})();",
].join("");

function escapeHtml(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The splash text: one span per language, each with its lang. */
export const SPLASH_TEXT_HTML = LOCALES.map((locale) => `<span lang="${locale}">${escapeHtml(LOADING[locale])}</span>`).join("");

export function langBootstrap(): Plugin {
	return {
		name: "chat-lang-bootstrap",
		transformIndexHtml(html) {
			for (const marker of [LANG_BOOTSTRAP_MARKER, SPLASH_TEXT_MARKER]) {
				if (!html.includes(marker)) throw new Error(`index.html lost ${marker}`);
			}
			return html
				.replace(LANG_BOOTSTRAP_MARKER, `<script>${LANG_BOOTSTRAP_SCRIPT}</script>`)
				.replace(SPLASH_TEXT_MARKER, SPLASH_TEXT_HTML);
		},
	};
}
