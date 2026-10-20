// Browser view of brand.config.json, imported through Vite (the build-time
// loader in brand-files.ts reads it with node:fs and validates it).
import brandConfig from "../../../brand.config.json";

/** What comes before the domain in the web app's host: "chat." of chat.{domain}. */
const WEB_HOST_PREFIX = brandConfig.hostTemplates.web.replace("{domain}", "");

/**
 * The tenant domain of a web app served at `host`: the part after chat.,
 * so one build serves every tenant and every self-hosted install (hoandat-auth
 * ADR 0007). Anywhere else (native apps, the dev server) it is the primary
 * tenant's.
 */
export function tenantDomainOf(host: string): string {
	return host.startsWith(WEB_HOST_PREFIX) && host.length > WEB_HOST_PREFIX.length
		? host.slice(WEB_HOST_PREFIX.length)
		: brandConfig.primaryTenant.domain;
}

/** Hosts the screens name for the tenant of `host`. */
export function brandFor(host: string) {
	const domain = tenantDomainOf(host);
	const primary = domain === brandConfig.primaryTenant.domain;
	// The primary tenant keeps its configured issuer; another one's IdP is auth.<domain>.
	const issuer = primary ? new URL(brandConfig.primaryTenant.issuer) : new URL(`https://auth.${domain}`);
	return {
		appName: brandConfig.appName,
		description: brandConfig.description,
		/** Tenant domain; names the sign-in account in copy, e.g. "tài khoản <domain>". */
		domain,
		/** Host of the web app, e.g. chat.<domain>. */
		webHost: brandConfig.hostTemplates.web.replace("{domain}", domain),
		/** Host of the IdP sign-in page, e.g. auth.<domain>. */
		idpHost: issuer.host,
		/** IdP account page: sign-in methods, app grants, devices. */
		accountUrl: new URL("/account", issuer).toString(),
		/** The primary tenant (brand.config.json), run by the product's own operator. */
		primaryTenant: primary,
		/** App URL scheme; links with it pass the allowlist (ADR 0004). */
		urlScheme: brandConfig.urlScheme,
	} as const;
}

export const brand = brandFor(typeof location === "undefined" ? "" : location.host);
