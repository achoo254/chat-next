import { describe, expect, it } from "vitest";
import brandConfig from "../../../brand.config.json";
import { brand } from "../src/brand.ts";

describe("brand hosts", () => {
	it("come from brand.config.json, whatever host serves the page", () => {
		const { domain, issuer } = brandConfig.primaryTenant;
		expect(brand.domain).toBe(domain);
		expect(brand.webHost).toBe(`chat.${domain}`);
		expect(brand.idpHost).toBe(new URL(issuer).host);
		expect(brand.accountUrl).toBe(new URL("/account", issuer).toString());
	});
});
