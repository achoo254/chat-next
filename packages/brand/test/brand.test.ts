import { describe, expect, it } from "vitest";
import {
	allowedOrigins,
	generateManifests,
	hostsFor,
	loadBrandConfig,
	parseBrandConfig,
} from "../src/index.ts";

const brand = loadBrandConfig();

describe("brand.config.json", () => {
	it("passes its schema", () => {
		expect(brand.urlScheme).toBe(brand.appIds.ios);
	});

	it("rejects an invalid bundle id, color and unknown field", () => {
		expect(() =>
			parseBrandConfig({
				...brand,
				appIds: { ...brand.appIds, ios: "Not A Bundle" },
				colors: { ...brand.colors, primary: "blue" },
				extra: true,
			}),
		).toThrow(/appIds\/ios.*colors\/primary|colors\/primary.*appIds\/ios/s);
	});

	it("never places Mini Apps or media under a tenant's domain", () => {
		const tenant = brand.primaryTenant.domain;
		expect(brand.sharedDomains.miniApp.endsWith(tenant)).toBe(false);
		expect(brand.sharedDomains.media.endsWith(tenant)).toBe(false);
	});
});

describe("hosts", () => {
	it("derives each tenant's hosts from the templates", () => {
		const hosts = hostsFor(brand, "inetdev.io.vn");
		expect(hosts.web).toBe("chat.inetdev.io.vn");
		expect(hosts.botApi).toBe("bot.chat.inetdev.io.vn");
		expect(hosts.webhook).toBe("hook.chat.inetdev.io.vn");
		expect(hosts.miniAppOrigin(42)).toBe(`https://b42.${brand.sharedDomains.miniApp}`);
	});

	it("accepts development origins only in development", () => {
		expect(allowedOrigins(brand, "hoandat.com", false)).toEqual(["https://chat.hoandat.com"]);
		expect(allowedOrigins(brand, "hoandat.com", true)).toEqual([
			"https://chat.hoandat.com",
			...brand.devOrigins,
		]);
	});
});

describe("manifests", () => {
	it("follow the brand, so renaming means editing brand.config.json only", () => {
		const renamed = generateManifests({ ...brand, appName: "Renamed", shortName: "Ren" });
		expect(renamed["web.webmanifest.json"]).toMatchObject({ name: "Renamed", short_name: "Ren" });
		expect(renamed["capacitor.json"]).toMatchObject({ appName: "Renamed" });
		expect(renamed["tauri.json"]).toMatchObject({ productName: "Renamed" });
	});

	it("keeps the Capacitor WebView on its own origin, not a tenant's host", () => {
		expect(generateManifests(brand)["capacitor.json"]).not.toHaveProperty("server");
	});
});
