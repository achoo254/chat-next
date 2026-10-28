// Puts the shared theme script of @achoo254/app-shell inline in the <head>
// of index.html, before the stylesheet, so `data-theme` is set before the
// first paint and a dark page never flashes light. The CSP of
// infra/chat/nginx/chat.hoandat.com.conf allows exactly this text by its hash
// (test/theme-bootstrap.test.ts keeps the two in step). Built here, not in
// the app: the page needs only the script's text, not the code making it.
import { themeBootstrapScript } from "@achoo254/app-shell/preferences";
import type { Plugin } from "vite";
import { LEGACY_THEME_KEY } from "./src/appearance.ts";

/** Placeholder in index.html for the inline theme script. */
export const THEME_BOOTSTRAP_MARKER = "<!--theme-bootstrap-->";

/** The inline script; reads Chat's own theme key while no shared choice exists. */
export const THEME_BOOTSTRAP_SCRIPT = themeBootstrapScript({ legacyThemeKey: LEGACY_THEME_KEY });

export function themeBootstrap(): Plugin {
	return {
		name: "chat-theme-bootstrap",
		transformIndexHtml(html) {
			if (!html.includes(THEME_BOOTSTRAP_MARKER)) throw new Error(`index.html lost ${THEME_BOOTSTRAP_MARKER}`);
			return html.replace(THEME_BOOTSTRAP_MARKER, `<script>${THEME_BOOTSTRAP_SCRIPT}</script>`);
		},
	};
}
