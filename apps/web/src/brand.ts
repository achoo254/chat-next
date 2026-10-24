// Browser view of brand.config.json, imported through Vite (the build-time
// loader in brand-files.ts reads it with node:fs and validates it).
import brandConfig from "../../../brand.config.json";

const { domain, issuer } = brandConfig.primaryTenant;
const idp = new URL(issuer);

/** Names and hosts the screens show, from brand.config.json. */
export const brand = {
	appName: brandConfig.appName,
	description: brandConfig.description,
	/** Account domain; names the sign-in account in copy, e.g. "tài khoản <domain>". */
	domain,
	/** Host of the web app, e.g. chat.<domain>. */
	webHost: brandConfig.hostTemplates.web.replace("{domain}", domain),
	/** Host of the IdP sign-in page, e.g. auth.<domain>. */
	idpHost: idp.host,
	/** IdP account page: sign-in methods, app grants, devices. */
	accountUrl: new URL("/account", idp).toString(),
	/** App URL scheme; links with it pass the allowlist (ADR 0004). */
	urlScheme: brandConfig.urlScheme,
} as const;
