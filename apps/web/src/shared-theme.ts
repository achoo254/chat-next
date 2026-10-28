// The theme is the shared choice of every hoandat.com app
// (@achoo254/app-shell: the `hd_theme` cookie on the root domain, this
// WebView's storage in the native app). The head script puts it on <html>
// before the first paint (vite-theme-bootstrap.ts) and the shared theme
// switches apply a pick on this page; this keeps the page on it when the
// choice changes elsewhere. Imported by main.tsx only: the screens with a
// theme switch need none of it.
import { applyTheme, readPreferences, subscribePreferences } from "@achoo254/app-shell/preferences";
import { LEGACY_THEME_KEY } from "./appearance.ts";
import { brand } from "./brand.ts";

/** From now on, applies the stored theme whenever it changes, e.g. picked in another app's tab. */
export function followSharedTheme(): void {
	subscribePreferences(() => applyTheme(readPreferences({ domain: brand.domain, legacyThemeKey: LEGACY_THEME_KEY }).theme));
}
