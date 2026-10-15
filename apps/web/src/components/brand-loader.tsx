// The app logo and the loaders built on it (mockups/auth.html#loading). The
// logo is the brand icon inlined (virtual:brand-logo, from brand.config.json),
// so its typing dots can move; styles are .brand-logo / .brand-loader in app.css.
import { useId, useLayoutEffect } from "react";
import logoSvg from "virtual:brand-logo";
import { brand } from "../brand.ts";
import { scopeSvgIds } from "../brand-logo-svg.ts";
import { useI18n } from "../i18n/i18n.tsx";

/** The splash in index.html; null in tests and the visual harness. */
const SPLASH_ID = "splash";

/**
 * The app logo, named after the app for assistive technology; decorative
 * where the app name is already written next to it.
 */
export function BrandLogo({ decorative = false }: { decorative?: boolean }) {
	const id = useId();
	// Trusted build-time markup (the brand icon), with ids unique per copy.
	const html = scopeSvgIds(logoSvg, `logo${id}`);
	return (
		<span
			className="brand-logo"
			{...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": brand.appName })}
			dangerouslySetInnerHTML={{ __html: html }}
		/>
	);
}

interface BrandLoaderProps {
	/** Status shown after 600 ms; defaults to "Loading…" in the UI language. */
	label?: string | undefined;
	/** Fill the window (app start) instead of the surrounding panel. */
	page?: boolean | undefined;
}

/** Logo with typing dots and a halo, centred in its panel (or the window). */
export function BrandLoader({ label, page = false }: BrandLoaderProps) {
	const { t } = useI18n();
	return (
		<div className={page ? "brand-loader page" : "brand-loader"} role="status" aria-live="polite" aria-busy="true">
			<BrandLogo />
			<p className="brand-loader-text">{label ?? t.common.loading}</p>
		</div>
	);
}

/**
 * Full-window loading while the app starts. With the index.html splash on the
 * page this renders nothing: #root stays empty, so the splash (hidden by CSS
 * once #root has content) keeps running its animation without restarting.
 * Its text follows the UI language. Elsewhere it renders the same loader.
 */
export function PageLoader() {
	const { t } = useI18n();
	const splash = typeof document === "undefined" ? null : document.getElementById(SPLASH_ID);
	useLayoutEffect(() => {
		const text = splash?.querySelector(".brand-loader-text");
		if (text && text.textContent !== t.common.loading) text.textContent = t.common.loading;
	}, [splash, t.common.loading]);
	return splash === null ? <BrandLoader page /> : null;
}
