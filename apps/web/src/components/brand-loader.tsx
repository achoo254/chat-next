// The app logo and the loaders built on it (mockups/auth.html#loading). The
// logo is the brand icon (virtual:brand-logo, from brand.config.json): inline
// SVG when it is vector, an <img> of the served icon file when it embeds a
// raster picture; styles are .brand-logo / .brand-loader in app.css.
import { useId, useLayoutEffect, useRef } from "react";
import logo from "virtual:brand-logo";
import { brand } from "../brand.ts";
import { scopeSvgIds } from "../brand-logo-svg.ts";
import { useI18n } from "../i18n/i18n.tsx";
import { pageSplash } from "./loader-gate.ts";

/**
 * The app logo, named after the app for assistive technology; decorative
 * where the app name is already written next to it.
 */
export function BrandLogo({ decorative = false }: { decorative?: boolean }) {
	const id = useId();
	const label = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": brand.appName };
	if (logo.src !== undefined) {
		return (
			<span className="brand-logo" {...label}>
				<img src={logo.src} alt="" decoding="async" />
			</span>
		);
	}
	// Trusted build-time markup (the brand icon), with ids unique per copy.
	const html = scopeSvgIds(logo.svg, `logo${id}`);
	return <span className="brand-logo" {...label} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface BrandLoaderProps {
	/** Status shown after 600 ms; defaults to "Loading…" in the UI language. */
	label?: string | undefined;
	/** Fill the window (app start) instead of the surrounding panel. */
	page?: boolean | undefined;
	/**
	 * An in-app loader shown after a wait (loader-gate.ts): when it went on
	 * screen (performance.now()), so a loader taking over carries on its text.
	 */
	since?: number | undefined;
}

/** One animation clock for every loader, so one taking over from another does not restart the dots. */
const LOADER_CYCLE_MS = 2400;

/** Logo with typing dots and a halo, centred in its panel (or the window). */
export function BrandLoader({ label, page = false, since }: BrandLoaderProps) {
	const { t } = useI18n();
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		const now = performance.now();
		element.style.setProperty("--loader-phase", `${-Math.round(now % LOADER_CYCLE_MS)}ms`);
		if (since !== undefined) element.style.setProperty("--loader-age", `${-Math.round(Math.max(0, now - since))}ms`);
	}, [since]);
	const classes = ["brand-loader", page ? "page" : "", since === undefined ? "" : "delayed"].filter(Boolean).join(" ");
	return (
		<div ref={ref} className={classes} role="status" aria-live="polite" aria-busy="true">
			<BrandLogo />
			<p className="brand-loader-text">{label ?? t.common.loading}</p>
		</div>
	);
}

/**
 * Full-window loading while the app starts. With the index.html splash on the
 * page this renders nothing and keeps the splash up (it stays until nothing
 * loads any more, see loader-gate.ts), so its animation runs on without a
 * restart. Its text follows the UI language. Elsewhere it renders the same
 * loader.
 */
export function PageLoader() {
	const { t } = useI18n();
	const cover = pageSplash();
	const element = cover.active ? document.getElementById("splash") : null;
	useLayoutEffect(() => {
		if (!cover.active) return;
		return cover.hold();
	}, [cover]);
	useLayoutEffect(() => {
		const text = element?.querySelector(".brand-loader-text");
		if (text && text.textContent !== t.common.loading) text.textContent = t.common.loading;
	}, [element, t.common.loading]);
	return element === null ? <BrandLoader page /> : null;
}
