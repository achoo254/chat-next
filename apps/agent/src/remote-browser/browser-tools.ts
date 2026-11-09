/**
 * The tunelo browser tools of tunelo's MCP, offered only to the claude
 * sessions tunelo opens (a paired device can take over): open_browser,
 * request_takeover and virtual_authenticator. No tool returns a picture of
 * a page or anything the user typed.
 */
import { z } from "zod";
import type { ToolRegistrar } from "../mcp/groups.js";
import { attempt } from "../mcp/mcp-result.js";
import type { BrowserSession, RemoteBrowser } from "./remote-browser.ts";

/** Not a group of groups.ts: it cannot be turned off, and only sessions with a ticket have it. */
export const BROWSER_GROUP = "browser";
export const BROWSER_TOOLS = ["open_browser", "request_takeover", "virtual_authenticator"] as const;

const NO_SESSION = "The tunelo browser is only offered in a session tunelo opened (the user can take it over from a paired device).";

const url = z.string().min(1).max(2000);

export function registerBrowserTools(server: ToolRegistrar, bound?: { browser: RemoteBrowser; session: BrowserSession }): void {
	const service = () => {
		if (!bound) throw new Error(NO_SESSION);
		return bound;
	};

	server.registerTool(
		"open_browser",
		{
			title: "Open the tunelo browser",
			description:
				"Start (or reuse) tunelo's own Chrome profile on this machine, kept apart from the user's browsers: what you sign in to in it stays signed in for later sessions. With `url`, the page opens in the blank tab or a new one. Returns { cdp_url, ws_endpoint, tab, tabs, headless }. Drive it with Playwright: `const browser = await chromium.connectOverCDP(cdp_url); const context = browser.contexts()[0];` (use that context, a new one has no sign-ins; do not close the browser, disconnect). fill_secret fills into its pages without a cdp_url. When a page needs the user (a sign-in you cannot do, a captcha, a passkey), call request_takeover.",
			inputSchema: z.object({ url: url.optional().describe("An http or https page to open") }),
			annotations: { openWorldHint: true },
		},
		(args) =>
			attempt(async () => {
				const { browser, session } = service();
				return browser.open(session, args.url);
			}),
	);

	server.registerTool(
		"request_takeover",
		{
			title: "Hand the browser to the user",
			description:
				"Pause and let the user act on the tunelo browser themselves from their device (they see the tab live, click, type and scroll): to sign in, solve a captcha, pick a passkey or another way to sign in. Waits until they give it back, then returns { url, title, tabs } of the tab shown last (no picture; never what they typed), with passkey_requests when a page asked for a passkey meanwhile. Fails when nobody acts for 10 minutes or the session ends. For a password you can type yourself, use request_secret instead.",
			inputSchema: z.object({
				reason: z.string().min(1).max(300).describe("One sentence the user reads: what to do on the page"),
				url: url.optional().describe("An http or https page to open first; the current tab otherwise"),
				os_dialog: z
					.boolean()
					.optional()
					.describe("true when a dialog of the operating system (a passkey sheet, a Keychain prompt) waits on the machine's screen, outside the page: the user is offered the machine's whole screen"),
			}),
			annotations: { openWorldHint: true },
		},
		(args) =>
			attempt(async () => {
				const { browser, session } = service();
				return browser.requestTakeover(session, { reason: args.reason, ...(args.url ? { url: args.url } : {}), ...(args.os_dialog ? { osDialog: true } : {}) });
			}),
	);

	server.registerTool(
		"virtual_authenticator",
		{
			title: "Test passkeys in the tunelo browser",
			description:
				"Turn a virtual passkey authenticator (WebAuthn, CTAP2, user verified, discoverable credentials) on or off for every tab of the tunelo browser, new tabs too: for end-to-end tests of passkey sign-up and sign-in of the user's own app. Passkeys made with it are test keys in memory only, gone when it is turned off or the browser closes; they cannot sign in to a site where the user's real passkey lives. While it is on, pages asking for a passkey use it instead of the machine's own dialog.",
			inputSchema: z.object({ enable: z.boolean().describe("true to turn it on, false to remove it and its passkeys") }),
			annotations: { openWorldHint: false },
		},
		(args) =>
			attempt(async () => {
				const { browser, session } = service();
				return browser.setVirtualAuthenticator(session, args.enable);
			}),
	);
}
