import { act, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";
import logo from "virtual:brand-logo";
import brandConfig from "../../../brand.config.json";
import indexHtml from "../index.html?raw";
import { brandLogoSource, inlineLogoSvg, scopeSvgIds, splashLogoHtml } from "../src/brand-logo-svg.ts";
import { BrandLoader, BrandLogo, PageLoader } from "../src/components/brand-loader.tsx";
import { I18nProvider } from "../src/i18n/i18n.tsx";

describe("brand logo markup", () => {
	it("prepares the brand icon as decorative SVG", () => {
		expect(() => inlineLogoSvg("<p>not an svg</p>")).toThrow(/single <svg>/);
		expect(inlineLogoSvg('<?xml version="1.0"?><!-- c --><svg></svg>')).toBe('<svg aria-hidden="true" focusable="false"></svg>');
	});

	it("inlines a vector icon and points at the icon file for a raster one", () => {
		const vector = '<svg aria-hidden="true"><path d="M0 0h1"/></svg>';
		const raster = '<svg aria-hidden="true"><image href="data:image/webp;base64,AAAA"/></svg>';
		expect(brandLogoSource(vector, "/icon.svg")).toEqual({ svg: vector });
		expect(brandLogoSource(raster, "/icon.svg")).toEqual({ src: "/icon.svg" });
		expect(splashLogoHtml({ src: "/icon.svg" }, 88)).toBe('<img src="/icon.svg" alt="" width="88" height="88" decoding="async">');
		expect(splashLogoHtml({ svg: '<svg><g id="a"/></svg>' }, 88)).toBe('<svg width="88" height="88"><g id="splash-a"/></svg>');
	});

	it("keeps the AI-drawn (raster) brand icon out of the bundle: the logo is the served /icon.svg", () => {
		// virtual:brand-logo comes from brand.config.json's icon (vite-brand.ts).
		expect(logo).toEqual({ src: "/icon.svg" });
	});

	it("scopes ids and their references so inlined copies stay independent", () => {
		const svg = '<svg><linearGradient id="g"/><rect fill="url(#g)"/><use href="#g"/></svg>';
		expect(scopeSvgIds(svg, "«r1»")).toBe('<svg><linearGradient id="-r1--g"/><rect fill="url(#-r1--g)"/><use href="#-r1--g"/></svg>');
	});
});

describe("loaders", () => {
	afterEach(() => {
		document.getElementById("splash")?.remove();
	});

	it("names the logo after the app, or hides it where the name is written", () => {
		const { container } = render(
			<I18nProvider>
				<BrandLogo />
				<BrandLogo decorative />
			</I18nProvider>,
		);
		expect(screen.getByRole("img", { name: brandConfig.appName })).toBeTruthy();
		const logos = container.querySelectorAll(".brand-logo");
		expect(logos[1]?.getAttribute("aria-hidden")).toBe("true");
		for (const image of container.querySelectorAll(".brand-logo img")) {
			expect(image.getAttribute("src")).toBe("/icon.svg");
			expect(image.getAttribute("alt")).toBe("");
		}
	});

	it("announces the loading state politely", () => {
		render(
			<I18nProvider>
				<BrandLoader label="Đang tải hồ sơ…" />
			</I18nProvider>,
		);
		const status = screen.getByRole("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.getAttribute("aria-busy")).toBe("true");
		expect(status.textContent).toContain("Đang tải hồ sơ…");
		expect(status.querySelectorAll(".brand-logo img")).toHaveLength(1);
	});

	it("draws the full-window loader itself when the page has no splash", () => {
		render(
			<I18nProvider>
				<PageLoader />
			</I18nProvider>,
		);
		expect(screen.getByRole("status").classList.contains("page")).toBe(true);
		expect(screen.getByText("Đang tải…")).toBeTruthy();
	});

	it("leaves the index.html splash running and puts its text in the UI language", async () => {
		const splash = document.createElement("div");
		splash.id = "splash";
		splash.innerHTML = '<p class="brand-loader-text">Đang tải…</p>';
		document.body.append(splash);
		window.localStorage.setItem("locale", "en");
		// English copy loads on first use; the splash keeps its text until then.
		// act does not wait for that import (its time varies by machine), so
		// wait for React to retry the provider once the copy is in.
		let container = document.body;
		await act(async () => {
			container = render(
				<Suspense fallback={null}>
					<I18nProvider>
						<PageLoader />
					</I18nProvider>
				</Suspense>,
			).container;
		});
		await waitFor(() => expect(splash.textContent).toBe("Loading…"));
		expect(container.childElementCount).toBe(0);
	});
});

describe("index.html splash", () => {
	it("is the same loader the app renders, before the module script", () => {
		const html = indexHtml;
		const splash = html.indexOf('<div id="splash" class="brand-loader page" role="status" aria-live="polite" aria-busy="true">');
		expect(splash).toBeGreaterThan(html.indexOf('<div id="root"></div>'));
		expect(html.indexOf('<script type="module"')).toBeGreaterThan(splash);
		expect(html).toContain('<span class="brand-logo" role="img" aria-label="%APP_NAME%">%APP_LOGO%</span>');
		// The text in every language (vite-lang-bootstrap.ts, test/lang-bootstrap.test.ts).
		expect(html).toContain('<p class="brand-loader-text"><!--splash-text--></p>');
		// The CSP (style-src 'self') refuses inline styles and scripts.
		expect(html).not.toMatch(/<style|style="|<script>/);
	});
});
