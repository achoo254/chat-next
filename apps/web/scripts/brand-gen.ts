/**
 * pnpm brand:gen: validates brand.config.json and writes what the platforms
 * derive from it to brand/generated/ (web manifest, Capacitor
 * config, PNG/ICO icons drawn from the brand SVGs with Playwright's
 * Chromium), plus the Go server's copy of the names. Run after editing the
 * brand.
 */
import { writeFileSync } from "node:fs";
import { chromiumRenderer, formatGenerated, writeBrandFiles } from "@shared-next/brand/build";
import { chromium } from "playwright";
import {
	BRAND_ROOT,
	GENERATED_DIR,
	MANIFEST_OPTIONS,
	SERVER_BRAND_FILE,
	loadChatBrand,
	serverBrandNames,
} from "../brand-files.ts";

const brand = loadChatBrand();
const written = await writeBrandFiles({
	brand,
	root: BRAND_ROOT,
	generatedDir: GENERATED_DIR,
	manifests: MANIFEST_OPTIONS,
	renderer: chromiumRenderer(chromium),
});
console.log(`Wrote ${written.length} files to ${GENERATED_DIR}: ${written.join(", ")}`);

// The Go server embeds the names it shows users (the assistant bot); a Go
// module cannot read files outside itself, so it gets a copy.
writeFileSync(SERVER_BRAND_FILE, formatGenerated(serverBrandNames(brand)));
console.log(`Wrote ${SERVER_BRAND_FILE}`);
