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
} from "@achoo254/brand/build";
import { describe, expect, it } from "vitest";
import {
	BRAND_ROOT,
	GENERATED_DIR,
	MANIFEST_OPTIONS,
	MOBILE_DIR,
	PLAY_FEATURE_GRAPHIC_FILE,
	SERVER_BRAND_FILE,
	loadChatBrand,
	serverBrandNames,
} from "../brand-files.ts";
import {
	FEATURE_GRAPHIC,
	IOS_APP_ICON,
	type NativeBrand,
	isLayeredIcon,
	nativePictures,
	nativeTextFiles,
	pngInfo,
	readMonochromeIcon,
	replacedTemplateFiles,
	styledIcon,
} from "../scripts/brand-native.ts";

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

	it("are copied as is into the sample Mini App (sdk/miniapp-demo)", () => {
		const demo = join(BRAND_ROOT, "sdk/miniapp-demo");
		const same = (copy: string, source: string) => expect(readFileSync(join(demo, copy)).equals(readFileSync(source)), copy).toBe(true);
		same("favicon.ico", join(GENERATED_DIR, ICONS_DIR, FAVICON_ICO));
		same("apple-touch-icon.png", join(GENERATED_DIR, ICONS_DIR, "apple-touch-icon.png"));
		same("icon.svg", join(BRAND_ROOT, brand.icon));
	});

	it("keep favicon.ico readable as an icon file with three sizes", () => {
		const ico = readFileSync(join(GENERATED_DIR, ICONS_DIR, FAVICON_ICO));
		expect(ico.readUInt16LE(2)).toBe(1);
		expect(ico.readUInt16LE(4)).toBe(3);
	});
});

describe("iOS and Android icons and launch screens (run pnpm brand:gen after editing the brand)", () => {
	const native: NativeBrand = {
		appName: brand.appName,
		description: brand.description,
		colors: brand.colors,
		iconSvg: readFileSync(join(BRAND_ROOT, brand.icon), "utf8"),
		maskableSvg: readFileSync(join(BRAND_ROOT, brand.iconMaskable), "utf8"),
		monochromeSvg: readMonochromeIcon(BRAND_ROOT),
	};

	it("hold the resources the current brand gives", () => {
		for (const [file, content] of Object.entries(nativeTextFiles(native))) {
			expect(readFileSync(join(MOBILE_DIR, file), "utf8"), file).toBe(content);
		}
	});

	it("have every picture at its size, opaque where a store or launch screen needs it", () => {
		for (const picture of nativePictures(native)) {
			const info = pngInfo(readFileSync(join(MOBILE_DIR, picture.file)));
			expect({ width: info.width, height: info.height }, picture.file).toEqual({ width: picture.width, height: picture.height });
			if (picture.background !== null) expect(info.alpha, picture.file).toBe(false);
		}
		expect(pngInfo(readFileSync(join(MOBILE_DIR, IOS_APP_ICON)))).toEqual({ width: 1024, height: 1024, alpha: false });
		expect(pngInfo(readFileSync(PLAY_FEATURE_GRAPHIC_FILE))).toEqual({ ...FEATURE_GRAPHIC, alpha: false });
	});

	it("left none of the Capacitor template pictures they replace", () => {
		for (const file of replacedTemplateFiles(native)) expect(existsSync(join(MOBILE_DIR, file)), file).toBe(false);
	});

	it("split only a logo with the layer classes", () => {
		const layered = '<svg viewBox="0 0 1 1"><rect class="logo-bg"/><path class="logo-bubble"/><circle class="logo-dot"/></svg>';
		expect(() => styledIcon('<svg viewBox="0 0 1 1"><rect/></svg>', "")).toThrow(/logo-bg/);
		expect(styledIcon(layered, ".logo-bg{display:none}")).toContain("<style>.logo-bg{display:none}</style>");
		expect(isLayeredIcon(layered)).toBe(true);
	});

	it("give Android 13+ a themed layer: the picture logo's silhouette, none without one", () => {
		const themed = (brand: NativeBrand) => nativePictures(brand).filter((picture) => picture.file.endsWith("ic_launcher_monochrome.png"));
		expect(native.monochromeSvg).not.toBeNull();
		expect(themed(native)).toHaveLength(5);
		expect(nativeTextFiles(native)["android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml"]).toContain("<monochrome ");
		const bare: NativeBrand = { ...native, monochromeSvg: null };
		if (!isLayeredIcon(bare.iconSvg)) {
			expect(themed(bare)).toHaveLength(0);
			expect(replacedTemplateFiles(bare).filter((file) => file.endsWith("ic_launcher_monochrome.png"))).toHaveLength(5);
		}
	});

	it("read PNG headers and refuse other files", () => {
		expect(() => pngInfo(new Uint8Array(40))).toThrow(/not a PNG/);
	});
});
