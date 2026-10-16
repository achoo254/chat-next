import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";
import logoSvg from "virtual:brand-logo";
import brandConfig from "../../../brand.config.json";
import indexHtml from "../index.html?raw";
import { inlineLogoSvg, scopeSvgIds } from "../src/brand-logo-svg.ts";
import { BrandLoader, BrandLogo, PageLoader } from "../src/components/brand-loader.tsx";
import { I18nProvider } from "../src/i18n/i18n.tsx";

describe("brand logo markup", () => {
	it("inlines the brand icon as decorative SVG with the dots the loader animates", () => {
		// virtual:brand-logo is inlineLogoSvg of brand.config.json's icon (vite-brand.ts).
		const svg = logoSvg;
		expect(svg.startsWith('<svg aria-hidden="true" focusable="false"')).toBe(true);
		expect(svg.match(/class="logo-dot"/g)).toHaveLength(3);
		expect(() => inlineLogoSvg("<p>not an svg</p>")).toThrow(/single <svg>/);
		expect(inlineLogoSvg('<?xml version="1.0"?><!-- c --><svg></svg>')).toBe('<svg aria-hidden="true" focusable="false"></svg>');
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
		// Each copy has its own gradient id.
		const ids = [...container.querySelectorAll("linearGradient")].map((node) => node.id);
		expect(new Set(ids).size).toBe(ids.length);
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
		expect(status.querySelectorAll(".logo-dot")).toHaveLength(3);
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
		// An awaited act lets React retry the provider once the copy is in.
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
		expect(splash.textContent).toBe("Loading…");
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
		expect(html).toContain('<p class="brand-loader-text">Đang tải…</p>');
		// The CSP (style-src 'self') refuses inline styles and scripts.
		expect(html).not.toMatch(/<style|style="|<script>/);
	});
});
