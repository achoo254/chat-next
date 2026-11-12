// The AI Agent column on a phone (touch, 390×844) and wider screens: rows as
// compact as their content (project about 44 px, workspace about 40 px, a
// two-line session about 56 px; the 44 px touch target comes from an
// invisible hit area, not from height), one grid for every row (the status
// glyph, the provider icon, the text and the trailing column line up across
// rows, never on top of each other), and nothing wider than the column.
// Starts its own Vite dev server of the harness:
//
//   node --test test/e2e/sidebar-phone.e2e.ts
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports, the harness preview (5174) and terminal.e2e.ts (5175). */
const PORT = 5176;

let server: ViteDevServer;
let browser: Browser;

before(async () => {
	server = await createServer({ root: HARNESS, configFile: `${HARNESS}vite.config.ts`, logLevel: "warn", server: { port: PORT, strictPort: true } });
	await server.listen();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

type Geometry = {
	projects: { height: number; glyph: number; icon: number; name: number }[];
	workspaces: { height: number; glyph: number; icon: number; name: number }[];
	sessions: { height: number; glyph: number; ai: number; aiRight: number; glyphRight: number; mode: number; text: number; title: string }[];
	overflow: number;
	column: number;
};

/** Where things are in the column, in CSS pixels. */
function geometry(page: Page): Promise<Geometry> {
	return page.evaluate(() => {
		const rect = (el: Element | null | undefined) => el?.getBoundingClientRect();
		const list = document.querySelector(".mx-list");
		const projects = [...document.querySelectorAll(".mx-list .mx-project:not(.mx-loose) > .mx-project-head")].map((head) => ({
			height: rect(head)?.height ?? 0,
			glyph: rect(head.querySelector(".mx-project-toggle > .mx-glyph, .mx-project-toggle > .mx-glyph-slot"))?.left ?? -1,
			icon: rect(head.querySelector(".mx-project-toggle > .icon"))?.left ?? -1,
			name: rect(head.querySelector("b"))?.left ?? -1,
		}));
		const workspaces = [...document.querySelectorAll(".mx-list .mx-ws-head")].map((head) => ({
			height: rect(head)?.height ?? 0,
			glyph: rect(head.querySelector(".mx-glyph"))?.left ?? -1,
			icon: rect(head.querySelector(".mx-ws-title > .icon"))?.left ?? -1,
			name: rect(head.querySelector(".mx-ws-name b, .mx-ws-title b"))?.left ?? -1,
		}));
		const sessions = [...document.querySelectorAll(".mx-list .mx-srow")].map((row) => {
			const glyph = rect(row.querySelector(".mx-glyph"));
			const ai = rect(row.querySelector(".mx-row-ai"));
			return {
				height: rect(row)?.height ?? 0,
				glyph: glyph?.left ?? -1,
				glyphRight: glyph?.right ?? -1,
				ai: ai?.left ?? -1,
				aiRight: ai?.right ?? -1,
				mode: rect(row.querySelector(".mx-row-mode"))?.left ?? -1,
				text: rect(row.querySelector(".name"))?.left ?? -1,
				title: row.querySelector(".name")?.textContent ?? "",
			};
		});
		const overflow = list === null ? 0 : list.scrollWidth - list.clientWidth;
		return { projects, workspaces, sessions, overflow, column: rect(list)?.width ?? 0 };
	});
}

async function open(width: number, height: number, touch: boolean): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width, height }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch });
	const page = await context.newPage();
	await page.goto(`http://localhost:${PORT}/?at=machine-home`);
	await page.locator(".mx-list .mx-srow").first().waitFor({ timeout: 30_000 });
	// Let the project tree settle (first connect turns folders into projects).
	await page.waitForTimeout(600);
	const dir = process.env.E2E_SHOTS;
	if (dir !== undefined && dir !== "") await page.screenshot({ path: join(dir, `sidebar-${width}${touch ? "-touch" : ""}.png`) });
	return { page, close: () => context.close() };
}

const near = (values: number[], what: string) => {
	const spread = Math.max(...values) - Math.min(...values);
	assert.ok(spread <= 1, `${what} differ by ${spread} px: ${values.join(", ")}`);
};

function check(g: Geometry, label: string): void {
	if (process.env.E2E_DEBUG === "1") console.log(label, JSON.stringify(g, null, 1));
	assert.ok(g.projects.length > 0 && g.workspaces.length > 0 && g.sessions.length > 1, `${label}: rows shown`);
	for (const p of g.projects) assert.ok(p.height >= 40 && p.height <= 48, `${label}: project row ${p.height} px`);
	for (const w of g.workspaces) assert.ok(w.height >= 36 && w.height <= 44, `${label}: workspace row ${w.height} px`);
	for (const s of g.sessions) assert.ok(s.height >= 48 && s.height <= 62, `${label}: session row "${s.title}" ${s.height} px`);
	// One grid: the same columns in every session row, the glyph never on the provider icon.
	near(g.sessions.map((s) => s.glyph), `${label}: session glyphs`);
	near(g.sessions.map((s) => s.ai), `${label}: provider icons`);
	near(g.sessions.map((s) => s.text), `${label}: session titles`);
	near(g.sessions.filter((s) => s.mode >= 0).map((s) => s.mode), `${label}: mode icons`);
	for (const s of g.sessions) assert.ok(s.glyphRight <= s.ai, `${label}: "${s.title}" glyph ends at ${s.glyphRight}, its provider icon starts at ${s.ai}`);
	// The same columns across project, workspace and session rows.
	near([...g.projects.map((p) => p.glyph), ...g.workspaces.map((w) => w.glyph), ...g.sessions.map((s) => s.glyph)], `${label}: status glyphs of every row`);
	near([...g.projects.map((p) => p.icon), ...g.workspaces.map((w) => w.icon), ...g.sessions.map((s) => s.ai)], `${label}: icons of every row`);
	near([...g.projects.map((p) => p.name), ...g.workspaces.map((w) => w.name), ...g.sessions.map((s) => s.text)], `${label}: texts of every row`);
	// The mode icon sits under the provider icon.
	for (const s of g.sessions) if (s.mode >= 0) assert.ok(Math.abs(s.mode - s.ai) <= 1, `${label}: "${s.title}" mode icon at ${s.mode}, provider icon at ${s.ai}`);
	assert.ok(g.overflow <= 0, `${label}: the column overflows by ${g.overflow} px`);
}

for (const [width, height, touch] of [
	[390, 844, true],
	[768, 1024, true],
	[1333, 780, false],
] as const) {
	test(`the column at ${width} px${touch ? " (touch)" : ""}: compact rows, one grid, nothing too wide`, async () => {
		const { page, close } = await open(width, height, touch);
		check(await geometry(page), `${width}${touch ? " touch" : ""}`);
		await close();
	});
}
