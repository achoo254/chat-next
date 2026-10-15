/**
 * Draws the brand SVGs into PNG files with Playwright's Chromium, the same
 * engine the e2e tests use, so no image library is needed. Used by
 * `pnpm brand:gen` only; nothing at runtime imports it.
 */
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { REPO_ROOT } from "./config.ts";

export interface RasterRequest {
	/** Repository-relative path of the SVG. */
	readonly svg: string;
	readonly size: number;
}

/** Returns one PNG per request, in order, with a transparent background. */
export async function rasterize(requests: readonly RasterRequest[]): Promise<Uint8Array[]> {
	const browser = await chromium.launch();
	try {
		const page = await browser.newPage({ deviceScaleFactor: 1 });
		const pngs: Uint8Array[] = [];
		for (const { svg, size } of requests) {
			const data = readFileSync(new URL(svg, REPO_ROOT)).toString("base64");
			await page.setViewportSize({ width: size, height: size });
			await page.setContent(
				`<html><body style="margin:0;background:transparent"><img id="i" width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${data}"></body></html>`,
			);
			await page.locator("#i").waitFor();
			await page.waitForFunction("document.getElementById('i').complete");
			pngs.push(await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
		}
		return pngs;
	} finally {
		await browser.close();
	}
}
