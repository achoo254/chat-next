import type { BrandConfig } from "./config.ts";

/** The hosts one tenant serves the app from. */
export interface TenantHosts {
	readonly web: string;
	readonly botApi: string;
	readonly webhook: string;
	/** Origin of one bot's Mini App, on the shared Mini App domain. */
	readonly miniAppOrigin: (botId: number) => string;
}

function fill(template: string, domain: string): string {
	return template.replace("{domain}", domain);
}

export function hostsFor(brand: BrandConfig, domain: string): TenantHosts {
	return {
		web: fill(brand.hostTemplates.web, domain),
		botApi: fill(brand.hostTemplates.botApi, domain),
		webhook: fill(brand.hostTemplates.webhook, domain),
		miniAppOrigin: (botId) => `https://b${botId}.${brand.sharedDomains.miniApp}`,
	};
}

/**
 * Origins whose state-changing requests and WebSocket handshakes the app
 * accepts for a tenant; development builds also accept `devOrigins`.
 */
export function allowedOrigins(
	brand: BrandConfig,
	domain: string,
	development: boolean,
): string[] {
	const origins = [`https://${hostsFor(brand, domain).web}`];
	return development ? [...origins, ...brand.devOrigins] : origins;
}
