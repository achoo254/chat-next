import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

/** brand.config.json, as described by brand.config.schema.json. */
export interface BrandConfig {
	readonly appName: string;
	readonly shortName: string;
	readonly description: string;
	readonly colors: {
		readonly primary: string;
		readonly background: string;
		readonly backgroundDark: string;
	};
	readonly icon: string;
	readonly iconMaskable: string;
	readonly appIds: {
		readonly ios: string;
		readonly android: string;
		readonly desktop: string;
	};
	readonly urlScheme: string;
	readonly primaryTenant: { readonly domain: string; readonly issuer: string };
	readonly hostTemplates: {
		readonly web: string;
	};
	readonly sharedDomains: { readonly media: string; readonly miniApp: string };
	readonly devOrigins: readonly string[];
	readonly pushSenderName: string;
}

export const REPO_ROOT = new URL("../../../", import.meta.url);

function readJson(url: URL): unknown {
	return JSON.parse(readFileSync(url, "utf8"));
}

/**
 * Validates `value` against the schema at the repository root and returns
 * it typed, or throws with every schema violation listed.
 */
export function parseBrandConfig(value: unknown): BrandConfig {
	const schema = readJson(new URL("brand.config.schema.json", REPO_ROOT));
	const ajv = new Ajv2020({ allErrors: true, strict: true });
	const validate = ajv.compile<BrandConfig>(schema as object);
	if (!validate(value)) {
		const details = (validate.errors ?? [])
			.map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`)
			.join("; ");
		throw new Error(`brand.config.json is invalid: ${details}`);
	}
	return value;
}

/** Reads and validates brand.config.json at the repository root. */
export function loadBrandConfig(): BrandConfig {
	return parseBrandConfig(readJson(new URL("brand.config.json", REPO_ROOT)));
}
