// Browser view of brand.config.json. packages/brand reads the file with
// node:fs, so the web app imports the JSON through Vite instead.
import brandConfig from "../../../brand.config.json";

const issuer = new URL(brandConfig.primaryTenant.issuer);

export const brand = {
	appName: brandConfig.appName,
	description: brandConfig.description,
	/** Host of the web app for the primary tenant, e.g. chat.<domain>. */
	webHost: brandConfig.hostTemplates.web.replace("{domain}", brandConfig.primaryTenant.domain),
	/** Host of the IdP sign-in page, e.g. auth.<domain>. */
	idpHost: issuer.host,
	/** IdP account page: sign-in methods, app grants, devices. */
	accountUrl: new URL("/account", issuer).toString(),
	/** App URL scheme; links with it pass the allowlist (ADR 0004). */
	urlScheme: brandConfig.urlScheme,
} as const;
