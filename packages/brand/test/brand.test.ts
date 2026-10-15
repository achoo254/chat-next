import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	FAVICON_ICO,
	allowedOrigins,
	encodeIco,
	generateManifests,
	iconSourceHashes,
	manifestIcons,
	webIconFiles,
	hostsFor,
	loadBrandConfig,
	parseBrandConfig,
	serverBrandNames,
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
		expect(hosts.botApiUrl).toBe("https://chat.inetdev.io.vn/bot/v1");
		expect(hosts.webhookUrl).toBe("https://chat.inetdev.io.vn/hook");
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

	it("gave the Go server the current names (run pnpm brand:gen after editing them)", () => {
		const copied: unknown = JSON.parse(readFileSync(new URL("../../../server/internal/brand/brand.json", import.meta.url), "utf8"));
		expect(copied).toEqual(serverBrandNames(brand));
	});

	it("keeps the Capacitor WebView on its own origin, not a tenant's host", () => {
		expect(generateManifests(brand)["capacitor.json"]).not.toHaveProperty("server");
	});
});

describe("icons", () => {
	it("were generated from the current brand SVGs (run pnpm brand:gen after editing them)", () => {
		const recorded: unknown = JSON.parse(readFileSync(new URL("../generated/icons/icons-source.json", import.meta.url), "utf8"));
		expect(recorded).toEqual(iconSourceHashes(brand));
	});

	it("has a file on disk for every icon the web app serves and the manifest lists", () => {
		const served = webIconFiles(brand);
		for (const icon of served) expect(existsSync(icon.file), icon.path).toBe(true);
		const paths = new Set(served.map((icon) => `/${icon.path}`));
		for (const icon of manifestIcons()) expect(paths.has(icon.src ?? "")).toBe(true);
		expect(manifestIcons().some((icon) => icon.purpose === "maskable")).toBe(true);
	});

	it("packs PNGs into an ICO directory with sizes and offsets", () => {
		const a = new Uint8Array([1, 2, 3]);
		const b = new Uint8Array([4, 5]);
		const ico = encodeIco([
			{ size: 16, png: a },
			{ size: 256, png: b },
		]);
		const view = new DataView(ico.buffer);
		expect(view.getUint16(2, true)).toBe(1);
		expect(view.getUint16(4, true)).toBe(2);
		expect(ico[6]).toBe(16);
		expect(ico[22]).toBe(0); // 256 is written as 0
		expect(view.getUint32(14, true)).toBe(3);
		expect(view.getUint32(18, true)).toBe(38);
		expect(view.getUint32(34, true)).toBe(41);
		expect([...ico.slice(38)]).toEqual([1, 2, 3, 4, 5]);
		expect(() => encodeIco([])).toThrow();
		expect(() => encodeIco([{ size: 300, png: a }])).toThrow(/1..256/);
	});

	it("keeps favicon.ico readable as an icon file", () => {
		const ico = readFileSync(new URL(`../generated/icons/${FAVICON_ICO}`, import.meta.url));
		expect(ico.readUInt16LE(2)).toBe(1);
		expect(ico.readUInt16LE(4)).toBe(3);
	});
});
