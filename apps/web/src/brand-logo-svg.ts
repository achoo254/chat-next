// The brand icon (brand.config.json "icon") prepared for the page: the Vite
// brand plugin uses it for the splash in index.html and for the
// virtual:brand-logo module the in-app logo renders. A vector icon is inlined
// as SVG markup; an icon that embeds a raster image (AI-drawn icons carry a
// base64 WebP) is shown as an <img> of the served icon file instead, so the
// picture stays out of the HTML and the startup JavaScript. Pure string work,
// so it runs in Node (build) and in the browser alike.

/** What the logo renders: inline SVG markup, or the URL of the icon file. */
export type BrandLogoSource = { readonly svg: string; readonly src?: undefined } | { readonly src: string; readonly svg?: undefined };

/**
 * The logo source of an inlined brand icon (inlineLogoSvg): its markup when it
 * is pure vector, else `url`, where the same icon file is served.
 */
export function brandLogoSource(svg: string, url: string): BrandLogoSource {
	return /<image\b/.test(svg) ? { src: url } : { svg };
}

/** The splash logo markup for index.html, sized before the stylesheet applies. */
export function splashLogoHtml(source: BrandLogoSource, size: number): string {
	if (source.src !== undefined) return `<img src="${source.src}" alt="" width="${size}" height="${size}" decoding="async">`;
	return scopeSvgIds(source.svg, "splash").replace(/^<svg\b/, `<svg width="${size}" height="${size}"`);
}

/**
 * Removes the XML prolog and comments, and marks the root <svg> as
 * decorative: the element around it carries the accessible name.
 */
export function inlineLogoSvg(source: string): string {
	const svg = source
		.replace(/<\?xml[\s\S]*?\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim();
	if (!svg.startsWith("<svg") || !svg.endsWith("</svg>")) throw new Error("brand icon: expected a single <svg> element");
	return svg.replace(/^<svg\b/, '<svg aria-hidden="true" focusable="false"');
}

/**
 * Prefixes every id of the SVG and every url(#id) / href="#id" reference to
 * it, so several inlined copies on one page never resolve each other's
 * gradients (a reference into a hidden copy paints nothing).
 */
export function scopeSvgIds(svg: string, prefix: string): string {
	const safe = prefix.replace(/[^A-Za-z0-9_-]/g, "-");
	return svg
		.replace(/\bid="([^"]+)"/g, (_match, id: string) => `id="${safe}-${id}"`)
		.replace(/url\(#([^)]+)\)/g, (_match, id: string) => `url(#${safe}-${id})`)
		.replace(/href="#([^"]+)"/g, (_match, id: string) => `href="#${safe}-${id}"`);
}
