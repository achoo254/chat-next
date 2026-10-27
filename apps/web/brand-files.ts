// Chat's use of @achoo254/brand at build time: where brand.config.json and
// the generated files live, the fields chat needs, and the options of the
// generated manifests. pnpm brand:gen (scripts/brand-gen.ts) writes the files
// with these options and the Vite plugins serve them, so both always agree.
//
// Paths are plain file paths, not `new URL(..., import.meta.url)`: Vite
// rewrites that pattern into a dev-server URL when Vitest loads this module.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type GenerateManifestsOptions, loadBrandConfig, svgManifestIcons } from "@achoo254/brand/build";

/** Directory of brand.config.json (the repository root); the brand's icon paths are relative to it. */
export const BRAND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Where pnpm brand:gen writes the manifests (icons go to its icons/). */
export const GENERATED_DIR = join(BRAND_ROOT, "brand/generated");

/** The Capacitor app: pnpm brand:gen draws its icons and launch screens (scripts/brand-native.ts). */
export const MOBILE_DIR = join(BRAND_ROOT, "apps/mobile");

/** Google Play's feature graphic, drawn with the native icons; the rest of the store listing is next to it. */
export const PLAY_FEATURE_GRAPHIC_FILE = join(BRAND_ROOT, "docs/store/play/feature-graphic.png");

/** The names the Go server shows users, embedded from this copy (server/internal/brand). */
export const SERVER_BRAND_FILE = join(BRAND_ROOT, "server/internal/brand/brand.json");

/** Optional schema fields chat cannot work without. */
const REQUIRED_FIELDS = [
	"sharedDomains",
	"devOrigins",
	"pushSenderName",
	"appIds.android",
	"colors.primary",
	"colors.backgroundDark",
] as const;

/** brand.config.json, validated against the shared schema with chat's required fields. */
export function loadChatBrand() {
	return loadBrandConfig(BRAND_ROOT, { require: REQUIRED_FIELDS });
}

export type ChatBrand = ReturnType<typeof loadChatBrand>;

export const MANIFEST_OPTIONS: GenerateManifestsOptions = {
	web: {
		// A stable identity: browsers treat the installed app as the same one across start_url changes.
		id: "/",
		lang: "vi",
		dir: "ltr",
		themeColor: "primary",
		categories: ["social"],
		preferRelatedApplications: false,
		icons: svgManifestIcons(),
	},
	capacitor: true,
};

/** The names the Go server shows users; pushSenderName titles notifications that hide the message. */
export function serverBrandNames(brand: ChatBrand): { appName: string; shortName: string; pushSenderName: string } {
	return { appName: brand.appName, shortName: brand.shortName, pushSenderName: brand.pushSenderName };
}
