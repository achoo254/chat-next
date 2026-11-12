// The hint in a chat session's header while the session runs without its
// folder's .claude configuration, in a real browser (Chromium) against the
// fake machine of the visual harness (test/support/remote-machine-demo.ts):
// "Kỹ năng của dự án chưa nạp — bật" turns the session's workspace folder on
// in one tap, and the hint goes once the machine says the session has it.
// Starts its own Vite dev server of the harness, so it needs no backend:
//
//   node --test test/e2e/project-config.e2e.ts
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const HARNESS = fileURLToPath(new URL("../visual/", import.meta.url));
/** Apart from the e2e stack's ports, the harness preview (5174) and the other harness e2e (5175 to 5177). */
const PORT = 5178;

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

test("the session's header offers to load the project's configuration, and turns its folder on", async () => {
	const context = await browser.newContext({ locale: "vi-VN", viewport: { width: 1333, height: 800 } });
	const page = await context.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));
	await page.goto(`http://localhost:${PORT}/?at=machine-chat`);
	const hint = page.locator("[data-id=session-project-config]");
	await hint.waitFor({ timeout: 30_000 });
	assert.match((await hint.textContent()) ?? "", /Kỹ năng của dự án chưa nạp/);

	await page.locator("[data-id=session-project-config-enable]").click();
	await page
		.waitForFunction(() => [...(window as unknown as { __fakeProjectConfig: Set<string> }).__fakeProjectConfig].some((dir) => dir.endsWith("chat-next")))
		.catch(() => assert.fail("timed out waiting for the folder turned on"));
	await hint.waitFor({ state: "detached" });
	assert.deepEqual(errors, []);
	await context.close();
});
