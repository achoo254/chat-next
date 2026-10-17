import { describe, expect, it } from "vitest";
import brandConfig from "../../../brand.config.json";
import { brandFor, tenantDomainOf } from "../src/brand.ts";

const primary = brandConfig.primaryTenant.domain;

describe("brand hosts follow the page's tenant", () => {
	it("reads the domain from chat.<domain>, ports included", () => {
		expect(tenantDomainOf("chat.acme.example")).toBe("acme.example");
		expect(tenantDomainOf("chat.acme.example:8443")).toBe("acme.example:8443");
		const acme = brandFor("chat.acme.example");
		expect(acme.webHost).toBe("chat.acme.example");
		expect(acme.idpHost).toBe("auth.acme.example");
		expect(acme.accountUrl).toBe("https://auth.acme.example/account");
	});

	it("keeps the primary tenant's configured IdP elsewhere", () => {
		for (const host of ["localhost:5173", "localhost", "", "chat."]) {
			expect(tenantDomainOf(host)).toBe(primary);
		}
		const own = brandFor(`chat.${primary}`);
		expect(own.idpHost).toBe(new URL(brandConfig.primaryTenant.issuer).host);
	});
});
