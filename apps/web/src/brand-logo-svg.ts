// The brand icon (brand.config.json "icon") prepared for inlining into HTML:
// the Vite brand plugin uses it for the splash in index.html and for the
// virtual:brand-logo module the in-app logo renders. Pure string work, so it
// runs in Node (build) and in the browser alike.

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
