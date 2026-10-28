import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_BOOTSTRAP_MARKER, THEME_BOOTSTRAP_SCRIPT } from "../vite-theme-bootstrap.ts";

/*
 * The inline theme script of index.html (vite-theme-bootstrap.ts puts in the
 * shared script of @achoo254/app-shell) runs only if the CSP names its hash.
 * A new package version or option changes the text, so this fails first and
 * prints the hash to put in every script-src of the nginx conf.
 */
/** A file next to this one; a path, since jsdom's URL is not the one node:fs takes. */
const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url).href);

const NGINX_CONF = file("../../../infra/chat/nginx/chat.hoandat.com.conf");

describe("theme bootstrap script", () => {
	it("is allowed by every script-src of the CSP", () => {
		const hash = `'sha256-${createHash("sha256").update(THEME_BOOTSTRAP_SCRIPT).digest("base64")}'`;
		const scriptSrcs = readFileSync(NGINX_CONF, "utf8").match(/script-src [^;"]*/g) ?? [];
		expect(scriptSrcs.length).toBeGreaterThan(0);
		for (const scriptSrc of scriptSrcs) expect(scriptSrc, `script-src needs ${hash}`).toContain(hash);
	});

	it("keeps the visitor's theme from before the shared choice", () => {
		expect(THEME_BOOTSTRAP_SCRIPT).toContain('"app:theme"');
		expect(THEME_BOOTSTRAP_SCRIPT).toContain("hd_theme");
	});

	it("has one place in index.html and no other inline script", () => {
		const html = readFileSync(file("../index.html"), "utf8");
		expect(html.split(THEME_BOOTSTRAP_MARKER)).toHaveLength(2);
		expect(html).not.toMatch(/<script>(?!\s*<\/script>)/);
	});
});
