import type { BrandConfig } from "./config.ts";

/** The hosts one tenant serves the app from. */
export interface TenantHosts {
	readonly web: string;
	/** Bot API base URL: a path on the web host (one-level hosts only, see ADR 0010). */
	readonly botApiUrl: string;
	/** Incoming webhook base URL, also a path on the web host. */
	readonly webhookUrl: string;
	/** Origin of one bot's Mini App, on the shared Mini App domain. */
	readonly miniAppOrigin: (botId: number) => string;
}

function fill(template: string, domain: string): string {
	return template.replace("{domain}", domain);
}

export function hostsFor(brand: BrandConfig, domain: string): TenantHosts {
	const web = fill(brand.hostTemplates.web, domain);
	return {
		web,
		botApiUrl: `https://${web}/bot/v1`,
		webhookUrl: `https://${web}/hook`,
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
