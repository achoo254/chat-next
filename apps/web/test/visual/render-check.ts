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
	// Forwarding with a comment: the dialog's message box (plain-text-box.tsx) with two lines.
	forward: "?at=ops&open=forward",
	// Inline mode: a bot's results as a list attached to the composer, one highlighted by the arrows.
	"inline-bot": "?at=ops&open=inline-bot",
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
	"settings-mcp": "?at=settings-mcp",
	// AI Agent: the sessions of every machine, the "Cần bạn" board, an unpaired machine, the machines page;
	// a session with markdown, the docked prompt, the status bar's details, the changes panel and "@" files.
	"machine-chat": "?at=machine-chat",
	"machine-home": "?at=machine-home",
	"machine-need": "?at=machine-need",
	"machine-unpaired": "?at=machine-unpaired",
	"machine-list": "?at=machine-list",
	"machine-markdown": "?at=machine-chat&open=markdown",
	"machine-account": "?at=machine-chat&open=account-menu",
	"machine-limit": "?at=machine-limit",
	"machine-secret": "?at=machine-secret&open=secret-card",
	"machine-info-secrets": "?at=machine-info&open=saved-secrets",
	// Turning on pairing with Authenticator: the one-time QR code, the key and the first code.
	"machine-info-totp": "?at=machine-info&open=totp-setup",
	// The machine's browser: Claude's takeover card, the live view (desktop: over the session; phone: full screen),
	// a page asking for a passkey, and the view opened from the machine's page.
	"machine-takeover": "?at=machine-takeover&open=takeover-card",
	"machine-takeover-view": "?at=machine-takeover&open=takeover-view",
	"machine-passkey": "?at=machine-passkey&open=passkey-card",
	"machine-info-browser": "?at=machine-info&open=machine-browser-view",
	// Claude says a dialog of the operating system waits; the machine's whole screen (off, sign-in, live); deleting the browser's profile.
	"machine-os-dialog": "?at=machine-os-dialog&open=os-dialog-card",
	"machine-screen-off": "?at=machine-screen-off&open=screen-off",
	"machine-screen-signin": "?at=machine-screen-signin&open=screen-signin",
	"machine-screen-live": "?at=machine-screen-live&open=screen-live",
	"machine-info-browser-clear": "?at=machine-info&open=browser-clear",
	"machine-details": "?at=machine-chat&open=status-details",
	"machine-changes": "?at=machine-chat&open=changes",
	"machine-changes-file": "?at=machine-chat&open=changes-file",
	// The folder's uncommitted changes (git), one file of them fetched whole; a turn's numbers; a command reading secrets.
	"machine-changes-git-file": "?at=machine-chat&open=changes-git-file",
	"machine-turn-details": "?at=machine-chat&open=turn-details",
	"machine-secret-command": "?at=machine-chat&open=secret-command",
	"machine-mention": "?at=machine-chat&open=mention",
	"machine-slash": "?at=machine-chat&open=slash",
	// Attachments: the drop zone while files are dragged, the tray with an image and a document, an upload in progress.
	"machine-attach-drop": "?at=machine-chat&open=attach-drop",
	"machine-attach-tray": "?at=machine-chat&open=attach-tray",
	"machine-attach-progress": "?at=machine-chat&open=attach-progress",
	"machine-attach-history": "?at=machine-chat&open=attach-history",
	// Archive and delete: the session's menu and the delete confirmation.
	"machine-thread-menu": "?at=machine-chat&open=thread-menu",
	"machine-thread-delete": "?at=machine-chat&open=thread-delete",
	// Projects: the column by project and workspace (git branch, state, "+"); "Thêm dự án" from a folder.
	"machine-projects": "?at=machine-home",
	"machine-add-project": "?at=machine-chat&open=add-project",
	"machine-new-session": "?at=machine-sessions&open=new-session",
	"machine-new-session-existing": "?at=machine-sessions&open=new-session-existing",
	"machine-info": "?at=machine-info",
	"machine-pair": "?at=machine-pair",
	"machine-pair-offline": "?at=machine-pair-offline",
	"machine-add": "?at=machine-add",
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
