import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toBinary } from "@bufbuild/protobuf";
import { BrowserMouseType, ErrorReason, type Frame, FrameSchema } from "@achoo254/chat-proto/remote/remote";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config.ts";
import { McpHost } from "../src/mcp/mcp-host.ts";
import { browserNoticeHook, secretRequestHook } from "../src/providers/claude/index.ts";
import { InputError, inputCommands } from "../src/remote-browser/browser-input.ts";
import { browserArgs, findBrowser } from "../src/remote-browser/browser-profile.ts";
import { PASSKEY_BINDING, PASSKEY_SCRIPT } from "../src/remote-browser/passkey-watch.ts";
import { type BrowserSession, RemoteBrowser, checkBrowserUrl } from "../src/remote-browser/remote-browser.ts";
import { AuditLog } from "../src/safety/audit-log.ts";
import { fakeProvider } from "./fake-provider.ts";
import { makeCore, tempDir } from "./harness.ts";
import { type DeviceLink, pairedDevice } from "./support/device-link.ts";
import { FakeChrome, PICTURE } from "./support/fake-chrome.ts";

const session: BrowserSession = { key: "ticket-a", threadId: "thread-a" };
const TYPED = "correct-horse-battery-staple";

async function until(check: () => boolean, ms = 2_000): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (check()) return;
	throw new Error("timed out");
}

let chrome: FakeChrome;
let dir: string;
let logs: string[];

function makeBrowser(opts: { idleMs?: number } = {}) {
	const audit = new AuditLog(join(dir, "audit.jsonl"));
	const browser = new RemoteBrowser({ configDir: dir, audit, launcher: chrome.launcher, log: (l) => logs.push(l), ...opts });
	return { browser, audit };
}

async function device(browser: RemoteBrowser): Promise<DeviceLink> {
	const { core } = makeCore([fakeProvider()]);
	const link = await pairedDevice({ core, config: new ConfigStore(dir), audit: new AuditLog(join(dir, "audit.jsonl")), browser });
	await link.request("ping", { case: "ping", value: {} });
	return link;
}

const of = <K extends NonNullable<Frame["body"]["case"]>>(link: DeviceLink, kind: K) => link.received.filter((f) => f.body.case === kind);

beforeEach(async () => {
	chrome = new FakeChrome();
	await chrome.start();
	dir = tempDir("browser-");
	logs = [];
});
afterEach(() => chrome.stop());

describe("the profile browser", () => {
	it("runs in its own profile on a loopback debugging port, without the macOS keychain", () => {
		const args = browserArgs("/x/browser-profile", false, "darwin");
		expect(args).toContain("--user-data-dir=/x/browser-profile");
		expect(args).toContain("--remote-debugging-port=0");
		expect(args).toContain("--use-mock-keychain");
		expect(args.some((a) => a.startsWith("--headless"))).toBe(false);
		expect(browserArgs("/x", true, "linux")).toEqual(expect.arrayContaining(["--headless=new", "--password-store=basic"]));
	});

	it("uses TUNELO_BROWSER when set, else the first browser installed", () => {
		expect(findBrowser({ TUNELO_BROWSER: "/opt/chrome" }, (p) => p === "/opt/chrome")).toBe("/opt/chrome");
		expect(findBrowser({ TUNELO_BROWSER: "/opt/missing" }, (p) => p !== "/opt/missing")).toBeUndefined();
		expect(findBrowser({}, () => false)).toBeUndefined();
	});

	it("open_browser starts it once, watches every tab for passkeys and opens the page", async () => {
		const { browser } = makeBrowser();
		const opened = await browser.open(session, "https://github.com/login");
		expect(opened.cdp_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(opened.tab.url).toBe("https://github.com/login");
		expect(opened.tabs).toBe(2);
		await browser.open(session);
		expect(chrome.launched).toBe(1);
		await until(() => chrome.called("Runtime.enable").length === 2);
		expect(chrome.called("Runtime.addBinding").every((c) => c.params.name === PASSKEY_BINDING)).toBe(true);
		expect(chrome.called("Page.addScriptToEvaluateOnNewDocument")[0]?.params).toMatchObject({ source: PASSKEY_SCRIPT, runImmediately: true });
		expect(browser.running()).toBe(true);
		await browser.close();
		expect(chrome.called("Browser.close")).toHaveLength(1);
	});

	it("opens only http and https pages", async () => {
		const { browser } = makeBrowser();
		await expect(browser.open(session, "file:///etc/passwd")).rejects.toThrow(/http and https/);
		expect(() => checkBrowserUrl("javascript:alert(1)")).toThrow();
		expect(chrome.launched).toBe(0);
	});
});

describe("taking over the browser from a device", () => {
	it("streams the tab only while a device views it, and stops when it stops or leaves", async () => {
		const { browser } = makeBrowser();
		const link = await device(browser);
		const waiting = browser.requestTakeover(session, { reason: "Sign in to GitHub", url: "https://github.com/login" });
		await until(() => of(link, "browserTakeover").length === 1);
		const t = of(link, "browserTakeover")[0];
		if (t?.body.case !== "browserTakeover") throw new Error("no takeover");
		expect(t.body.value).toMatchObject({ threadId: "thread-a", reason: "Sign in to GitHub", url: "https://github.com/login" });
		const takeoverId = t.body.value.takeoverId;
		expect(browser.waitingIn("thread-a")).toBe(1);
		// Nobody views it yet: no screencast.
		expect(chrome.called("Page.startScreencast")).toHaveLength(0);

		expect((await link.request("v1", { case: "browserView", value: { takeoverId, targetId: "", on: true, maxWidth: 800, maxHeight: 600 } })).body.case).toBe("ack");
		expect(chrome.called("Page.startScreencast")[0]?.params).toMatchObject({ format: "jpeg", maxWidth: 800, maxHeight: 600 });
		await until(() => of(link, "browserFrame").length === 1 && of(link, "browserState").length >= 1);
		const frame = of(link, "browserFrame")[0];
		expect(frame?.body.case === "browserFrame" && Buffer.from(frame.body.value.jpeg).equals(PICTURE)).toBe(true);
		expect(frame?.body.case === "browserFrame" && [frame.body.value.pageWidth, frame.body.value.pageHeight]).toEqual([1200, 800]);
		const state = of(link, "browserState").at(-1);
		expect(state?.body.case === "browserState" && state.body.value.tabs.map((x) => x.url)).toContain("https://github.com/login");
		// The picture is acknowledged after a moment, so the browser sends the next one.
		await until(() => chrome.called("Page.screencastFrameAck").length === 1);

		await link.request("v2", { case: "browserView", value: { takeoverId, targetId: "", on: false, maxWidth: 0, maxHeight: 0 } });
		await until(() => chrome.called("Page.stopScreencast").length === 1);

		await link.request("v3", { case: "browserView", value: { takeoverId, targetId: "", on: true, maxWidth: 0, maxHeight: 0 } });
		expect(chrome.called("Page.startScreencast")).toHaveLength(2);
		link.close();
		await until(() => chrome.called("Page.stopScreencast").length === 2);

		browser.endSession(session.key);
		await expect(waiting).rejects.toThrow(/session ended/);
	});

	it("takes input only while the takeover is open, and gives Claude the page, not a picture", async () => {
		const { browser } = makeBrowser();
		const link = await device(browser);
		const click = (id: string, takeoverId: string) =>
			link.request(id, { case: "browserInput", value: { takeoverId, targetId: "", action: { case: "mouse", value: { type: BrowserMouseType.DOWN, x: 10, y: 20, button: 0, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 } } } });

		const before = await click("i0", "no-such-takeover");
		expect(before.body.case === "error" && before.body.value.reason).toBe(ErrorReason.TAKEOVER_GONE);
		expect(chrome.called("Input.dispatchMouseEvent")).toHaveLength(0);

		const waiting = browser.requestTakeover(session, { reason: "Pass the captcha", url: "https://example.org/" });
		await until(() => of(link, "browserTakeover").length === 1);
		const t = of(link, "browserTakeover")[0];
		const takeoverId = t?.body.case === "browserTakeover" ? t.body.value.takeoverId : "";
		expect((await click("i1", takeoverId)).body.case).toBe("ack");
		expect(chrome.called("Input.dispatchMouseEvent")[0]?.params).toMatchObject({ type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 });

		expect((await link.request("e1", { case: "browserTakeoverEnd", value: { takeoverId } })).body.case).toBe("ack");
		const result = await waiting;
		expect(result).toEqual({ returned: true, url: "https://example.org/", title: "", tabs: 2 });
		await until(() => of(link, "browserTakeoverEnded").length === 1);
		expect(browser.waitingIn("thread-a")).toBe(0);

		const after = await click("i2", takeoverId);
		expect(after.body.case === "error" && after.body.value.reason).toBe(ErrorReason.TAKEOVER_GONE);
		expect(chrome.called("Input.dispatchMouseEvent")).toHaveLength(1);
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).toContain('"action":"browser_control","path":"https://example.org","detail":"ai"');
	});

	it("never logs what the user types, in a password field or anywhere", async () => {
		const { browser } = makeBrowser();
		const link = await device(browser);
		const waiting = browser.requestTakeover(session, { reason: "Sign in", url: "https://bank.example/login" });
		await until(() => of(link, "browserTakeover").length === 1);
		const t = of(link, "browserTakeover")[0];
		const takeoverId = t?.body.case === "browserTakeover" ? t.body.value.takeoverId : "";
		await link.request("v", { case: "browserView", value: { takeoverId, targetId: "", on: true, maxWidth: 0, maxHeight: 0 } });

		chrome.passwordFocused = true;
		await link.request("c", { case: "browserInput", value: { takeoverId, targetId: "", action: { case: "mouse", value: { type: BrowserMouseType.UP, x: 5, y: 5, button: 0, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 } } } });
		// The device learns the field is a password field (its keyboard should not learn it).
		await until(() => of(link, "browserState").some((f) => f.body.case === "browserState" && f.body.value.passwordFocused));
		await link.request("t", { case: "browserInput", value: { takeoverId, targetId: "", action: { case: "text", value: TYPED } } });
		for (const ch of "pw!") await link.request(`k${ch}`, { case: "browserInput", value: { takeoverId, targetId: "", action: { case: "key", value: { key: ch, code: "", text: ch, modifiers: 0 } } } });
		expect(chrome.called("Input.insertText")[0]?.params).toEqual({ text: TYPED });
		expect(chrome.called("Input.dispatchKeyEvent")).toHaveLength(6);

		await link.request("e", { case: "browserTakeoverEnd", value: { takeoverId } });
		const result = JSON.stringify(await waiting);
		expect(result).not.toContain(TYPED);
		expect(logs.join("\n")).not.toContain(TYPED);
		expect(logs.join("\n")).not.toContain("pw!");
		expect(readFileSync(join(dir, "audit.jsonl"), "utf8")).not.toContain(TYPED);
		// No frame back to the device carries it either.
		const sent = link.received.map((f) => Buffer.from(toBinary(FrameSchema, f)).toString("latin1")).join("\n");
		expect(sent).not.toContain(TYPED);
	});

	it("ends by itself when nobody acts, and Claude is told", async () => {
		const { browser } = makeBrowser({ idleMs: 150 });
		const link = await device(browser);
		const waiting = browser.requestTakeover(session, { reason: "Sign in" });
		await expect(waiting).rejects.toThrow(/nobody acted on the browser/);
		await until(() => of(link, "browserTakeoverEnded").length === 1);
		expect(browser.openTakeovers()).toEqual([]);
	});

	it("each input moves the expiry on", async () => {
		const { browser } = makeBrowser({ idleMs: 300 });
		const link = await device(browser);
		let settled = false;
		const waiting = browser.requestTakeover(session, { reason: "Sign in" });
		waiting.catch(() => undefined).finally(() => (settled = true));
		await until(() => of(link, "browserTakeover").length === 1);
		const t = of(link, "browserTakeover")[0];
		const takeoverId = t?.body.case === "browserTakeover" ? t.body.value.takeoverId : "";
		for (let i = 0; i < 4; i++) {
			await new Promise((r) => setTimeout(r, 150));
			await link.request(`k${i}`, { case: "browserInput", value: { takeoverId, targetId: "", action: { case: "key", value: { key: "a", code: "KeyA", text: "a", modifiers: 0 } } } });
		}
		expect(settled).toBe(false);
		await expect(waiting).rejects.toThrow(/nobody acted/);
	});

	it("a device opens the running browser itself; not when it is not running", async () => {
		const { browser } = makeBrowser();
		const link = await device(browser);
		const refused = await link.request("c0", { case: "browserControl", value: {} });
		expect(refused.body.case === "error" && refused.body.value.reason).toBe(ErrorReason.BROWSER_NOT_RUNNING);
		await browser.open(session);
		const opened = await link.request("c1", { case: "browserControl", value: {} });
		expect(opened.body.case === "browserTakeover" && opened.body.value.threadId).toBe("");
		const again = await link.request("c2", { case: "browserControl", value: {} });
		expect(again.body.case === "browserTakeover" && opened.body.case === "browserTakeover" && again.body.value.takeoverId).toBe(
			opened.body.case === "browserTakeover" ? opened.body.value.takeoverId : "",
		);
		// It holds no session: nothing waits on it.
		expect(browser.waitingIn("")).toBe(0);
	});

	it("a takeover still open reaches a device that connects later; a closed browser ends it", async () => {
		const { browser } = makeBrowser();
		const waiting = browser.requestTakeover(session, { reason: "Sign in" });
		await until(() => browser.openTakeovers().length === 1);
		const late = await device(browser);
		expect(of(late, "browserTakeover")).toHaveLength(1);
		chrome.quit();
		await expect(waiting).rejects.toThrow(/browser was closed/);
		expect(browser.running()).toBe(false);
	});
});

describe("passkeys", () => {
	it("virtual_authenticator gives every tab, new ones too, the same test passkeys, and takes them away", async () => {
		const { browser } = makeBrowser();
		await browser.open(session);
		const on = await browser.setVirtualAuthenticator(session, true);
		expect(on).toMatchObject({ enabled: true, tabs: 1 });
		expect(chrome.called("WebAuthn.addVirtualAuthenticator")[0]?.params).toMatchObject({
			options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, isUserVerified: true, automaticPresenceSimulation: true },
		});
		await browser.open(session, "https://app.localhost/signup");
		await until(() => chrome.called("WebAuthn.addVirtualAuthenticator").length === 2);
		const [first, second] = [...chrome.tabs.keys()];
		chrome.credentialAdded(first ?? "", "cred-1");
		await until(() => chrome.called("WebAuthn.addCredential").length === 1);
		expect(chrome.called("WebAuthn.addCredential")[0]).toMatchObject({ sessionId: `S${second}`, params: { authenticatorId: `A${second}` } });

		// Pages asking for a passkey now use it: nobody is told.
		chrome.passkeyWanted(second ?? "", "create");
		await new Promise((r) => setTimeout(r, 50));
		expect(browser.takeNotices(session.key)).toEqual([]);

		expect(await browser.setVirtualAuthenticator(session, false)).toEqual({ enabled: false });
		expect(chrome.called("WebAuthn.removeVirtualAuthenticator")).toHaveLength(2);
	});

	it("a page asking for a real passkey is told to the devices and, once, to the sessions that used the browser", async () => {
		const { browser } = makeBrowser();
		const link = await device(browser);
		await browser.open(session, "https://github.com/login");
		const tab = [...chrome.tabs.values()].find((t) => t.url === "https://github.com/login");
		await until(() => chrome.called("Runtime.enable").length === 2);
		chrome.passkeyWanted(tab?.targetId ?? "", "get");
		await until(() => of(link, "passkeyNotice").length === 1);
		const notice = of(link, "passkeyNotice")[0];
		expect(notice?.body.case === "passkeyNotice" && notice.body.value).toMatchObject({ origin: "https://github.com", create: false, threadId: "thread-a" });
		const told = browser.takeNotices(session.key);
		expect(told).toHaveLength(1);
		expect(told[0]).toContain("https://github.com");
		expect(browser.takeNotices(session.key)).toEqual([]);
		// The same site and kind again soon: held back.
		chrome.passkeyWanted(tab?.targetId ?? "", "get");
		await new Promise((r) => setTimeout(r, 50));
		expect(of(link, "passkeyNotice")).toHaveLength(1);
		// Claude waiting on a takeover hears of it in the result.
		const waiting = browser.requestTakeover(session, { reason: "Pick another way to sign in" });
		await until(() => browser.openTakeovers().length === 1);
		chrome.passkeyWanted(tab?.targetId ?? "", "create");
		await until(() => of(link, "passkeyNotice").length === 2);
		browser.end(browser.openTakeovers()[0]?.takeoverId ?? "", "phone");
		expect((await waiting).passkey_requests).toEqual(["https://github.com"]);
	});

	it("the page script wraps WebAuthn calls, not passkey autofill, and passes them on", () => {
		const calls: string[] = [];
		const told: string[] = [];
		const credentials = {
			create: async (o: unknown) => (calls.push(`create ${JSON.stringify(o)}`), "made"),
			get: async (o: unknown) => (calls.push(`get ${JSON.stringify(o)}`), "got"),
		};
		const scope = { navigator: { credentials }, [PASSKEY_BINDING]: (kind: string) => told.push(kind) };
		new Function("globalThis", "navigator", PASSKEY_SCRIPT)(scope, scope.navigator);
		void credentials.get({ publicKey: {}, mediation: "conditional" });
		void credentials.get({ password: true });
		void credentials.create({ publicKey: {} });
		expect(told).toEqual(["create"]);
		expect(calls).toHaveLength(3);
	});
});

describe("input", () => {
	it("maps keys, text and the wheel to DevTools commands", () => {
		expect(inputCommands({ kind: "key", key: { key: "a", code: "KeyA", text: "a", modifiers: 0 } }).map((c) => c.params.type)).toEqual(["keyDown", "keyUp"]);
		const enter = inputCommands({ kind: "key", key: { key: "Enter", code: "Enter", text: "", modifiers: 0 } })[0]?.params;
		expect(enter).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 13, text: "\r" });
		const back = inputCommands({ kind: "key", key: { key: "Backspace", code: "Backspace", text: "", modifiers: 0 } })[0]?.params;
		expect(back).toMatchObject({ type: "rawKeyDown", windowsVirtualKeyCode: 8 });
		const selectAll = inputCommands({ kind: "key", key: { key: "a", code: "KeyA", text: "", modifiers: 4 } })[0]?.params;
		expect(selectAll).toMatchObject({ type: "rawKeyDown", commands: ["selectAll"] });
		const wheel = inputCommands({ kind: "mouse", mouse: { type: "wheel", x: 1, y: 2, button: 0, clickCount: 0, deltaX: 0, deltaY: 300, modifiers: 0 } })[0]?.params;
		expect(wheel).toMatchObject({ type: "mouseWheel", deltaY: 300, button: "none" });
		expect(() => inputCommands({ kind: "mouse", mouse: { type: "down", x: Number.NaN, y: 0, button: 0, clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 } })).toThrow(InputError);
		expect(() => inputCommands({ kind: "text", text: "x".repeat(1001) })).toThrow(InputError);
	});
});

describe("Claude's side", () => {
	it("the browser tools are only for a session tunelo opened", async () => {
		const { browser } = makeBrowser();
		const host = new McpHost(dir, { browser: () => browser, localWrites: () => false, enabledGroups: () => [] });
		const local = host.open("https://tunnel.example");
		expect((await host.call(local, "browser", "open_browser", {})).isError).toBe(true);
		const ticket = host.tickets.issue("thread-z");
		const id = host.open("https://tunnel.example", ticket);
		const opened = await host.call(id, "browser", "open_browser", { url: "https://example.net/" });
		expect(opened.isError).toBeFalsy();
		expect(JSON.parse(opened.content[0]?.type === "text" ? opened.content[0].text : "{}")).toMatchObject({ tab: { url: "https://example.net/" } });
		expect((await host.call(id, "browser", "erase_profile", {})).isError).toBe(true);
		expect((await host.call(id, "constructor", "x", {})).isError).toBe(true);
		const waiting = host.call(id, "browser", "request_takeover", { reason: "Sign in" });
		await until(() => browser.openTakeovers().length === 1);
		host.release(ticket);
		const ended = await waiting;
		expect(ended.isError).toBe(true);
	});

	it("request_takeover needs no approval card; notices reach Claude once, after a tool", async () => {
		const signal = new AbortController().signal;
		type Hook = typeof secretRequestHook;
		const pre = { hook_event_name: "PreToolUse", tool_name: "mcp__tunelo__request_takeover", tool_input: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: "", permission_mode: "default" };
		expect(await secretRequestHook(pre as Parameters<Hook>[0], undefined, { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
		const open = { ...pre, tool_name: "mcp__tunelo__open_browser" };
		expect(await secretRequestHook(open as Parameters<Hook>[0], undefined, { signal })).toEqual({});

		const queue = ["tunelo: the page https://x.example asked for a passkey"];
		const hook = browserNoticeHook(() => queue.splice(0));
		const post = { ...pre, hook_event_name: "PostToolUse", tool_response: "ok" };
		expect(await hook(post as Parameters<Hook>[0], undefined, { signal })).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: queue[0] ?? expect.stringContaining("passkey") } });
		expect(await hook(post as Parameters<Hook>[0], undefined, { signal })).toEqual({});
	});
});
