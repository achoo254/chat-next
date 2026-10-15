export {
	type BrandConfig,
	loadBrandConfig,
	parseBrandConfig,
} from "./config.ts";
export { generateManifests, type GeneratedManifests } from "./generate.ts";
export { allowedOrigins, hostsFor, type TenantHosts } from "./hosts.ts";
export {
	FAVICON_ICO,
	FAVICON_SVG,
	RASTER_ICONS,
	encodeIco,
	iconSourceHashes,
	manifestIcons,
	webIconFiles,
	type RasterIcon,
	type WebIconFile,
} from "./icons.ts";
