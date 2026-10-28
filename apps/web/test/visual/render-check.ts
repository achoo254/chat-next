// Render check of the visual harness: builds it, serves it with `vite
// preview`, opens each page at each viewport in light and dark, and fails
// on any console error or page error. The harness logs every horizontal
// overflow it finds (auditOverflow in main.tsx) as a console error, so a
// horizontal scrollbar anywhere fails the check.
//
//   node test/visual/render-check.ts [out-dir] [page-filter]
//
// out-dir ("" for none) receives a screenshot per page; page-filter keeps
// the pages whose name contains it.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { build, preview } from "vite";

const APP_DIR = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG = join(APP_DIR, "test/visual/vite.config.ts");
const PORT = 5174;

/** Harness pages: name → query (?at= screen, ?open= scenario). */
export const PAGES: Readonly<Record<string, string>> = {
	ops: "?at=ops",
	channel: "?at=channel",
	// The owner's report: own short posts, a link preview and the info column, hover actions on.
	"channel-hover": "?at=channel&open=hover-all",
	"ops-hover": "?at=ops&open=hover-all",
	"channel-bare": "?at=channel&open=hover-bare",
	// Reaction pills on short own and others' messages in a small group (faces), info open and closed.
	"reactions-hover": "?at=owned&open=hover-all",
	"reactions-bare": "?at=owned&open=hover-bare",
	// Bubble grouping, in-bubble time, own bubbles on the solid fill: runs, a reply, a link, code, a day break.
	bubbles: "?at=cafe",
	lan: "?at=lan",
	media: "?at=media",
	"media-info": "?at=media&open=info",
	"media-shared": "?at=media&open=shared-media",
	"media-viewer": "?at=media&open=viewer",
	"media-upload": "?at=media&open=upload",
	"media-attach": "?at=media&open=attach",
	// Search (mockups/search.html): merged, filters, empty, server failure, in a chat.
	search: "?open=search-merged",
	"search-filters": "?open=search-filters",
	"search-empty": "?open=search-empty",
	"search-error": "?open=search-error",
	"search-in-chat": "?at=ops&open=search-in-chat",
	"search-in-chat-sender": "?at=ops&open=search-in-chat-sender",
	// Developer Console tabs (mockups/console.html): Hồ sơ, Token, Nhận update (webhook, long poll), Số liệu.
	"console-profile": "?at=console-profile",
	"console-token": "?at=console-token",
	"console-webhook": "?at=console-webhook",
	"console-poll": "?at=console-poll",
	"console-stats": "?at=console-stats",
	"settings-notifications": "?at=settings-notifications",
	"settings-app": "?at=settings-app",
	"settings-appearance": "?at=settings-appearance",
};

export const VIEWPORTS = [
	{ width: 1000, height: 700 },
	{ width: 1333, height: 780 },
	{ width: 390, height: 844 },
] as const;

const THEMES = ["light", "dark"] as const;

async function main(): Promise<void> {
	const [outArg = "", filter = ""] = process.argv.slice(2);
	const outDir = outArg === "" ? undefined : outArg;
	await build({ root: join(APP_DIR, "test/visual"), configFile: CONFIG, logLevel: "warn" });
	const server = await preview({ configFile: CONFIG, root: join(APP_DIR, "test/visual"), logLevel: "warn" });
	const browser = await chromium.launch();
	let failures = 0;
	let runs = 0;
	try {
		if (outDir !== undefined) await mkdir(outDir, { recursive: true });
		for (const [name, query] of Object.entries(PAGES)) {
			if (filter !== "" && !name.includes(filter)) continue;
			for (const viewport of VIEWPORTS) {
				for (const theme of THEMES) {
					runs++;
					const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
					const page = await context.newPage();
					const errors: string[] = [];
					page.on("console", (message) => {
						if (message.type() === "error") errors.push(message.text());
					});
					page.on("pageerror", (error) => errors.push(error.message));
					const separator = query === "" ? "?" : "&";
					await page.goto(`http://localhost:${PORT}/${query}${separator}theme=${theme}`, { waitUntil: "load", timeout: 60_000 });
					const label = `${name} ${viewport.width}x${viewport.height} ${theme}`;
					if (outDir !== undefined) await page.screenshot({ path: join(outDir, `${name}-${viewport.width}-${theme}.png`) });
					if (errors.length > 0) {
						failures++;
						console.log(`FAIL ${label}`);
						for (const error of errors) console.log(`  ${error}`);
					} else {
						console.log(`ok   ${label}`);
					}
					await context.close();
				}
			}
		}
	} finally {
		await browser.close();
		await new Promise<void>((resolve, reject) => server.httpServer.close((err) => (err ? reject(err) : resolve())));
	}
	console.log(`${runs} renders, ${failures} with errors`);
	if (failures > 0) process.exitCode = 1;
}

await main();
