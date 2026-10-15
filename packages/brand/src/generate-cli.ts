/**
 * Writes what the platforms derive from the brand to packages/brand/generated/:
 * the platform manifests from brand.config.json and the PNG/ICO icons drawn
 * from the brand SVGs. Run after editing the brand:
 *
 *   pnpm brand:gen
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { REPO_ROOT, loadBrandConfig } from "./config.ts";
import { generateManifests, serverBrandNames } from "./generate.ts";
import {
	FAVICON_ICO,
	FAVICON_ICO_SIZES,
	GENERATED_ICONS_DIR,
	ICONS_SOURCE_FILE,
	RASTER_ICONS,
	encodeIco,
	iconSourceHashes,
} from "./icons.ts";
import { rasterize } from "./rasterize.ts";

const brand = loadBrandConfig();
const outDir = new URL("../generated/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const manifests = generateManifests(brand);
for (const [name, content] of Object.entries(manifests)) {
	writeFileSync(new URL(name, outDir), `${JSON.stringify(content, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(manifests).length} manifests to ${outDir.pathname}`);

// The Go server embeds the names it shows users (the assistant bot); a Go
// module cannot read files outside itself, so it gets a copy.
const serverNames = new URL("server/internal/brand/brand.json", REPO_ROOT);
writeFileSync(serverNames, `${JSON.stringify(serverBrandNames(brand), null, 2)}\n`);
console.log(`Wrote ${serverNames.pathname}`);

mkdirSync(GENERATED_ICONS_DIR, { recursive: true });
const pngs = await rasterize([
	...RASTER_ICONS.map((icon) => ({ svg: brand[icon.source], size: icon.size })),
	...FAVICON_ICO_SIZES.map((size) => ({ svg: brand.icon, size })),
]);
RASTER_ICONS.forEach((icon, index) => {
	const png = pngs[index];
	if (png === undefined) throw new Error(`brand:gen: no image for ${icon.file}`);
	writeFileSync(new URL(icon.file, GENERATED_ICONS_DIR), png);
});
const icoImages = FAVICON_ICO_SIZES.map((size, index) => {
	const png = pngs[RASTER_ICONS.length + index];
	if (png === undefined) throw new Error(`brand:gen: no ${size}px favicon image`);
	return { size, png };
});
writeFileSync(new URL(FAVICON_ICO, GENERATED_ICONS_DIR), encodeIco(icoImages));
writeFileSync(new URL(ICONS_SOURCE_FILE, GENERATED_ICONS_DIR), `${JSON.stringify(iconSourceHashes(brand), null, 2)}\n`);
console.log(`Wrote ${RASTER_ICONS.length + 1} icons to ${GENERATED_ICONS_DIR.pathname}`);
