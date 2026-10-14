/**
 * Writes the platform manifests derived from brand.config.json to
 * packages/brand/generated/. Run after editing the brand:
 *
 *   pnpm brand:gen
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadBrandConfig } from "./config.ts";
import { generateManifests } from "./generate.ts";

const outDir = new URL("../generated/", import.meta.url);
mkdirSync(outDir, { recursive: true });
const manifests = generateManifests(loadBrandConfig());
for (const [name, content] of Object.entries(manifests)) {
	writeFileSync(new URL(name, outDir), `${JSON.stringify(content, null, 2)}\n`);
}
console.log(`Wrote ${Object.keys(manifests).length} manifests to ${outDir.pathname}`);
