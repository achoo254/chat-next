import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPreferences } from "@achoo254/app-shell/preferences";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../src/i18n/en.ts";
import { LEGACY_LANG_KEY, LOCALES } from "../src/i18n/locales.ts";
import { vi } from "../src/i18n/vi.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import { LANG_BOOTSTRAP_MARKER, LANG_BOOTSTRAP_SCRIPT, SPLASH_TEXT_HTML, SPLASH_TEXT_MARKER } from "../vite-lang-bootstrap.ts";

/*
 * The inline language script of index.html runs only if the CSP names its
 * hash; a change of the script, the locales or the shared key changes the
 * text, so this fails first and prints the hash to put in every script-src
 * of the nginx conf. It must also pick the language the app then shows
 * (i18n.tsx), or the page would switch language once the bundle runs.
 */
/** A file next to this one; a path, since jsdom's URL is not the one node:fs takes. */
const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url).href);

const NGINX_CONF = file("../../../infra/chat/nginx/chat.hoandat.com.conf");

function clearCookie(name: string): void {
	document.cookie = `${name}=; Max-Age=0; Path=/`;
}

/** Runs the inline script on a page starting in Vietnamese and returns the language it picked. */
function bootLang(): string {
	document.documentElement.lang = "vi";
	new Function(LANG_BOOTSTRAP_SCRIPT)();
	return document.documentElement.lang;
}

/** The language i18n.tsx shows for the same storage. */
function appLang(): string {
	return readPreferences({ domain: "hoandat.com", legacyLangKey: LEGACY_LANG_KEY, locales: LOCALES }).lang ?? "vi";
}

describe("language bootstrap script", () => {
	afterEach(() => {
		clearCookie("hd_lang");
		window.localStorage.clear();
		document.documentElement.lang = "vi";
	});

	it("is allowed by every script-src of the CSP", () => {
		const hash = `'sha256-${createHash("sha256").update(LANG_BOOTSTRAP_SCRIPT).digest("base64")}'`;
		const scriptSrcs = readFileSync(NGINX_CONF, "utf8").match(/script-src [^;"]*/g) ?? [];
		expect(scriptSrcs.length).toBeGreaterThan(0);
		for (const scriptSrc of scriptSrcs) expect(scriptSrc, `script-src needs ${hash}`).toContain(hash);
	});

	it.each([
		["nothing stored", () => {}],
		["the shared cookie", () => (document.cookie = "hd_lang=zh-CN; Path=/")],
		["a Chinese tag in the cookie", () => (document.cookie = "hd_lang=zh-Hans; Path=/")],
		["the cookie over storage", () => {
			document.cookie = "hd_lang=en; Path=/";
			window.localStorage.setItem("hd_lang", "zh-CN");
		}],
		["storage without a cookie", () => window.localStorage.setItem("hd_lang", "en")],
		["the legacy key", () => window.localStorage.setItem(LEGACY_LANG_KEY, "zh-CN")],
		["an unknown language", () => (document.cookie = "hd_lang=fr; Path=/")],
		["an unknown cookie falling back to storage", () => {
			document.cookie = "hd_lang=fr; Path=/";
			window.localStorage.setItem("hd_lang", "en");
		}],
		["a broken cookie", () => (document.cookie = "hd_lang=%E0%A4%A; Path=/")],
	])("picks the app's language from %s", (_, store) => {
		store();
		expect(bootLang()).toBe(appLang());
	});

	it("follows a stored choice", () => {
		document.cookie = "hd_lang=en; Path=/";
		expect(bootLang()).toBe("en");
	});

	it("has its places in index.html and adds no other inline script", () => {
		const html = readFileSync(file("../index.html"), "utf8");
		expect(html.split(LANG_BOOTSTRAP_MARKER)).toHaveLength(2);
		expect(html.split(SPLASH_TEXT_MARKER)).toHaveLength(2);
		expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
	});

	it("gives the splash the loading text of every language", () => {
		const p = document.createElement("p");
		p.innerHTML = SPLASH_TEXT_HTML;
		const texts = Object.fromEntries([...p.children].map((span) => [span.getAttribute("lang"), span.textContent]));
		expect(texts).toEqual({ vi: vi.common.loading, en: en.common.loading, "zh-CN": zhCN.common.loading });
	});
});
