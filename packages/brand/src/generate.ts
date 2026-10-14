import type { BrandConfig } from "./config.ts";

/** Platform manifests derived from the brand; apps read these at build time. */
export interface GeneratedManifests {
	readonly "web.webmanifest.json": Record<string, unknown>;
	readonly "capacitor.json": Record<string, unknown>;
	readonly "tauri.json": Record<string, unknown>;
}

export function generateManifests(brand: BrandConfig): GeneratedManifests {
	return {
		"web.webmanifest.json": {
			name: brand.appName,
			short_name: brand.shortName,
			description: brand.description,
			start_url: "/",
			scope: "/",
			display: "standalone",
			theme_color: brand.colors.primary,
			background_color: brand.colors.background,
			icons: [{ src: `/${brand.icon}`, sizes: "any", purpose: "any" }],
		},
		"capacitor.json": {
			appId: brand.appIds.ios,
			appName: brand.appName,
			android: { applicationId: brand.appIds.android },
			urlScheme: brand.urlScheme,
			// No server.hostname: the WebView keeps its own localhost origin. Using
			// the production host would make the local server answer the app's API
			// requests and pin one tenant into a binary that serves them all.
		},
		"tauri.json": {
			productName: brand.appName,
			identifier: brand.appIds.desktop,
			plugins: { "deep-link": { desktop: { schemes: [brand.urlScheme] } } },
		},
	};
}
