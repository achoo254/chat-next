import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	FAVICON_ICO,
	ICONS_DIR,
	ICONS_SOURCE_FILE,
	formatGenerated,
	generateManifests,
	iconSourceHashes,
	webIconFiles,
} from "@shared-next/brand/build";
import { describe, expect, it } from "vitest";
import { BRAND_ROOT, GENERATED_DIR, MANIFEST_OPTIONS, SERVER_BRAND_FILE, loadChatBrand, serverBrandNames } from "../brand-files.ts";

const brand = loadChatBrand();
const read = (file: string) => readFileSync(join(GENERATED_DIR, file), "utf8");

describe("brand.config.json", () => {
	it("passes the shared schema with the fields chat requires", () => {
		expect(brand.urlScheme).toBe(brand.appIds.ios);
	});

	it("never places Mini Apps or media under a tenant's domain", () => {
		const tenant = brand.primaryTenant.domain;
		expect(brand.sharedDomains.miniApp.endsWith(tenant)).toBe(false);
		expect(brand.sharedDomains.media.endsWith(tenant)).toBe(false);
	});
});

describe("generated brand files (run pnpm brand:gen after editing the brand)", () => {
	it("hold the manifests the current brand gives, and no desktop shell config", () => {
		const manifests = generateManifests(brand, MANIFEST_OPTIONS);
		expect(Object.keys(manifests)).toEqual(["web.webmanifest.json", "capacitor.json"]);
		for (const [name, content] of Object.entries(manifests)) expect(read(name), name).toBe(formatGenerated(content));
		expect(existsSync(join(GENERATED_DIR, "tauri.json"))).toBe(false);
	});

	it("keep the Capacitor WebView on its own origin, not a tenant's host", () => {
		expect(JSON.parse(read("capacitor.json"))).not.toHaveProperty("server");
	});

	it("gave the Go server the current names", () => {
		expect(readFileSync(SERVER_BRAND_FILE, "utf8")).toBe(formatGenerated(serverBrandNames(brand)));
	});

	it("drew the icons from the current brand SVGs", () => {
		const recorded: unknown = JSON.parse(read(`${ICONS_DIR}${ICONS_SOURCE_FILE}`));
		expect(recorded).toEqual(iconSourceHashes(brand, BRAND_ROOT));
	});

	it("have a file on disk for every icon the web app serves and the manifest lists", () => {
		const served = webIconFiles(brand, { root: BRAND_ROOT, generatedDir: GENERATED_DIR });
		for (const icon of served) expect(existsSync(icon.file), icon.path).toBe(true);
		const paths = new Set(served.map((icon) => `/${icon.path}`));
		const listed = MANIFEST_OPTIONS.web.icons;
		for (const icon of listed) expect(paths.has(icon.src), icon.src).toBe(true);
		expect(listed.some((icon) => icon.purpose === "maskable")).toBe(true);
	});

	it("keep favicon.ico readable as an icon file with three sizes", () => {
		const ico = readFileSync(join(GENERATED_DIR, ICONS_DIR, FAVICON_ICO));
		expect(ico.readUInt16LE(2)).toBe(1);
		expect(ico.readUInt16LE(4)).toBe(3);
	});
});
