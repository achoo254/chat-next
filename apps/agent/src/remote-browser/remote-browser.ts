/**
 * The tunelo browser: one Chrome profile of tunelo's own (browser-profile.ts)
 * that Claude drives over the DevTools Protocol, and that the user can take
 * over from a paired device when a page needs a person.
 *
 * - Claude: open_browser starts it (or uses the running one) and opens a
 *   page; request_takeover hands the tab to the user and waits until they
 *   give it back (Claude then gets the page's address and title, never a
 *   picture); virtual_authenticator turns a test passkey authenticator on
 *   for every tab.
 * - Devices: every takeover goes to every connected device. A device views
 *   it (a screencast of the tab, JPEG, at most 10 pictures a second, only
 *   while some device views it) and sends mouse, key and text input, which
 *   is only taken while the takeover is open. Nothing of it is logged or
 *   kept, and none of it is a thread item. A takeover nobody uses for 10
 *   minutes ends by itself.
 * - Passkeys: a page asking for a real passkey while no virtual
 *   authenticator is on is reported to the devices and, with the next tool
 *   result, to the sessions that used the browser.
 *
 * One controlling DevTools connection to the browser attaches to every tab
 * (flat sessions), so Playwright or fill_secret may drive the same tabs over
 * their own connections meanwhile.
 */
import { randomBytes } from "node:crypto";
import type { AuditLog } from "../safety/audit-log.ts";
import { originOf } from "../sign-in-secrets/secret-names.ts";
import { type InputAction, inputCommands } from "./browser-input.ts";
import { type BrowserEndpoint, BrowserUnavailable, findBrowser, launchBrowser, profileDir, runningBrowser } from "./browser-profile.ts";
import { CdpConnection, type CdpEvent } from "./cdp-connection.ts";
import { NoticeQueues, PASSKEY_BINDING, PASSKEY_SCRIPT, type PasskeyNoticeInfo, PasskeyThrottle, passkeyNoticeText } from "./passkey-watch.ts";

export const TAKEOVER_IDLE_MS = 10 * 60_000;
/** At most 10 pictures a second: the browser sends the next one only once the last is acknowledged. */
const MIN_FRAME_MS = 100;
const DEFAULT_SIZE = 1280;
const MAX_SIZE = 1600;
const MAX_FRAME_BYTES = 1_500_000;
const MAX_REASON_CHARS = 300;
const MAX_URL_CHARS = 2000;
/** A takeover whose expiry moved by this much is announced again. */
const ANNOUNCE_MOVE_MS = 60_000;
const STATE_DELAY_MS = 150;

const VIRTUAL_AUTHENTICATOR = {
	protocol: "ctap2",
	ctap2Version: "ctap2_1",
	transport: "internal",
	hasResidentKey: true,
	hasUserVerification: true,
	isUserVerified: true,
	automaticPresenceSimulation: true,
};

/** No takeover of that id is open (given back, expired, or its session ended). */
export class TakeoverGone extends Error {}
/** A device wants the browser while it does not run. */
export class BrowserNotRunning extends Error {}
/** A tool's input that cannot be used, or a takeover that ended without the user giving it back. */
export class BrowserToolError extends Error {}

export { BrowserUnavailable };

export interface BrowserSession {
	key: string;
	threadId: string;
}

export interface TakeoverInfo {
	takeoverId: string;
	threadId: string;
	reason: string;
	url: string;
	expiresAt: number;
}

export interface TabInfo {
	targetId: string;
	url: string;
	title: string;
}

export interface FrameOut {
	takeoverId: string;
	targetId: string;
	jpeg: Uint8Array;
	pageWidth: number;
	pageHeight: number;
}

export interface StateOut {
	takeoverId: string;
	tabs: TabInfo[];
	targetId: string;
	passwordFocused: boolean;
}

/** One device's view: where its pictures and tab lists go. */
export interface BrowserViewer {
	frame(f: FrameOut): void;
	state(s: StateOut): void;
	/** The device's link holds much unsent: a picture is skipped. */
	busy(): boolean;
}

export type BrowserEvent =
	| { type: "takeover"; takeover: TakeoverInfo }
	| { type: "ended"; takeoverId: string; threadId: string }
	| { type: "passkey"; notice: PasskeyNoticeInfo }
	| { type: "running"; running: boolean };

export interface TakeoverResult {
	returned: true;
	url: string;
	title: string;
	tabs: number;
	passkey_requests?: string[];
}

/** How the profile browser is found, started and reached (a fake one in tests). */
export interface BrowserLauncher {
	available(): boolean;
	running(): Promise<BrowserEndpoint | undefined>;
	launch(): Promise<BrowserEndpoint>;
}

export function profileLauncher(configDir: string): BrowserLauncher {
	const dir = profileDir(configDir);
	return {
		available: () => findBrowser() !== undefined,
		running: () => runningBrowser(dir),
		launch: () => {
			const exe = findBrowser();
			if (!exe) throw new BrowserUnavailable("no Chrome, Chromium, Edge or Brave is installed on this machine (or set TUNELO_BROWSER to one)");
			return launchBrowser(dir, exe);
		},
	};
}

/** An http or https address Claude may open. */
export function checkBrowserUrl(input: string): string {
	if (input.length > MAX_URL_CHARS) throw new BrowserToolError("the URL is too long");
	let url: URL;
	try {
		url = new URL(input.trim());
	} catch {
		throw new BrowserToolError(`${input.slice(0, 200)} is not a URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrowserToolError("the tunelo browser only opens http and https pages");
	return url.href;
}

interface Page extends TabInfo {
	sessionId?: string;
	ready: Promise<void>;
	authenticatorId?: string;
	passwordFocused: boolean;
}

interface Controller {
	conn: CdpConnection;
	endpoint: BrowserEndpoint;
	pages: Map<string, Page>;
	/** DevTools session id → target id. */
	bySession: Map<string, string>;
}

interface Takeover extends TakeoverInfo {
	/** The session waiting; "" for one a device opened. */
	key: string;
	/** The tab shown last. */
	targetId: string;
	announcedExpiry: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	passkeys: string[];
	resolve?: (r: TakeoverResult) => void;
	reject?: (e: Error) => void;
}

interface Cast {
	targetId: string;
	viewers: Set<BrowserViewer>;
	lastAck: number;
	ackTimer: ReturnType<typeof setTimeout> | undefined;
	/** The last picture, for a device that starts viewing between pictures; never written anywhere. */
	last: { jpeg: Uint8Array; pageWidth: number; pageHeight: number } | undefined;
}

interface View {
	takeoverId: string;
	targetId: string;
}

interface TargetInfo {
	targetId: string;
	type: string;
	url: string;
	title: string;
}

const isPage = (t: TargetInfo) => t.type === "page" && !t.url.startsWith("devtools://");
const blank = (url: string) => url === "" || url === "about:blank" || url.startsWith("chrome://newtab") || url.startsWith("edge://newtab");

export interface RemoteBrowserOptions {
	configDir: string;
	audit: AuditLog;
	launcher?: BrowserLauncher;
	log?: (line: string) => void;
	now?: () => number;
	idleMs?: number;
}

export class RemoteBrowser {
	private readonly launcher: BrowserLauncher;
	private readonly log: (line: string) => void;
	private readonly now: () => number;
	private readonly idleMs: number;
	private ctl: Controller | undefined;
	private connecting: Promise<Controller> | undefined;
	private currentTarget = "";
	private readonly takeovers = new Map<string, Takeover>();
	private readonly views = new Map<BrowserViewer, View>();
	private readonly casts = new Map<string, Cast>();
	private readonly listeners = new Set<(event: BrowserEvent) => void>();
	/** Sessions that used the browser (they hear of passkey requests), and the last one. */
	private readonly users = new Map<string, string>();
	private lastUser: BrowserSession | undefined;
	private virtualOn = false;
	/** Test passkeys made in any tab, given to every tab's authenticator; memory only. */
	private readonly credentials = new Map<string, unknown>();
	private readonly throttle: PasskeyThrottle;
	private readonly notices = new NoticeQueues();
	private stateTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly opts: RemoteBrowserOptions) {
		this.launcher = opts.launcher ?? profileLauncher(opts.configDir);
		this.log = opts.log ?? (() => undefined);
		this.now = opts.now ?? Date.now;
		this.idleMs = opts.idleMs ?? TAKEOVER_IDLE_MS;
		this.throttle = new PasskeyThrottle(this.now);
	}

	// --- state ----------------------------------------------------------------

	available(): boolean {
		return this.launcher.available();
	}

	running(): boolean {
		return this.ctl?.conn.isOpen === true;
	}

	onEvent(listener: (event: BrowserEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: BrowserEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	openTakeovers(): TakeoverInfo[] {
		return [...this.takeovers.values()].map(infoOf);
	}

	/** Open takeovers a session's Claude waits on, by thread. */
	waitingIn(threadId: string): number {
		return [...this.takeovers.values()].filter((t) => t.key !== "" && t.threadId === threadId).length;
	}

	/** Takes over a profile browser left running (by a tunelo before a restart); starts none. */
	start(): void {
		void this.controller(false).catch(() => undefined);
	}

	// --- the controlling connection -------------------------------------------

	private async controller(launch: boolean): Promise<Controller> {
		if (this.ctl?.conn.isOpen) return this.ctl;
		if (this.connecting) {
			const ctl = await this.connecting.catch(() => undefined);
			if (ctl?.conn.isOpen) return ctl;
		}
		this.connecting = this.connect(launch).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async connect(launch: boolean): Promise<Controller> {
		let endpoint = await this.launcher.running();
		if (!endpoint) {
			if (!launch) throw new BrowserNotRunning("the tunelo browser is not running");
			endpoint = await this.launcher.launch();
			this.log(`browser: started (${endpoint.headless ? "headless" : "with a window"})`);
		}
		const conn = await CdpConnection.open(endpoint.wsUrl);
		const ctl: Controller = { conn, endpoint, pages: new Map(), bySession: new Map() };
		conn.onEvent((e) => this.cdpEvent(ctl, e));
		conn.onClose(() => this.lost(ctl));
		try {
			await conn.send("Target.setDiscoverTargets", { discover: true });
			const { targetInfos } = await conn.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
			for (const info of targetInfos) if (isPage(info)) this.addPage(ctl, info);
		} catch (err) {
			conn.close();
			throw err;
		}
		this.ctl = ctl;
		this.emit({ type: "running", running: true });
		return ctl;
	}

	private lost(ctl: Controller): void {
		if (this.ctl !== ctl) return;
		this.ctl = undefined;
		for (const cast of this.casts.values()) clearTimeout(cast.ackTimer);
		this.casts.clear();
		this.views.clear();
		for (const t of [...this.takeovers.values()]) this.finish(t, new BrowserToolError("the tunelo browser was closed"));
		this.log("browser: closed");
		this.emit({ type: "running", running: false });
	}

	private addPage(ctl: Controller, info: TargetInfo): Page {
		const known = ctl.pages.get(info.targetId);
		if (known) return known;
		const page: Page = { targetId: info.targetId, url: info.url, title: info.title, passwordFocused: false, ready: Promise.resolve() };
		ctl.pages.set(info.targetId, page);
		page.ready = this.attach(ctl, page).catch(() => undefined);
		return page;
	}

	/** Watches a tab for passkey requests, and gives it the test authenticator when that is on. */
	private async attach(ctl: Controller, page: Page): Promise<void> {
		const { sessionId } = await ctl.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
		page.sessionId = sessionId;
		ctl.bySession.set(sessionId, page.targetId);
		await ctl.conn.send("Runtime.addBinding", { name: PASSKEY_BINDING }, sessionId);
		await ctl.conn.send("Page.addScriptToEvaluateOnNewDocument", { source: PASSKEY_SCRIPT, runImmediately: true }, sessionId);
		// The binding's calls are only reported with Runtime on.
		await ctl.conn.send("Runtime.enable", {}, sessionId);
		if (this.virtualOn) await this.authenticate(ctl, page);
	}

	private cdpEvent(ctl: Controller, e: CdpEvent): void {
		switch (e.method) {
			case "Target.targetCreated":
			case "Target.targetInfoChanged": {
				const info = e.params.targetInfo as TargetInfo | undefined;
				if (!info || !isPage(info)) return;
				const page = ctl.pages.get(info.targetId);
				if (!page) this.addPage(ctl, info);
				else {
					page.url = info.url;
					page.title = info.title;
				}
				return this.tabsChanged();
			}
			case "Target.targetDestroyed":
				return this.tabGone(ctl, String(e.params.targetId ?? ""));
			case "Target.detachedFromTarget": {
				const sessionId = String(e.params.sessionId ?? "");
				const page = ctl.pages.get(ctl.bySession.get(sessionId) ?? "");
				ctl.bySession.delete(sessionId);
				if (page?.sessionId === sessionId) delete page.sessionId;
				return;
			}
			case "Page.screencastFrame":
				return this.frame(ctl, e);
			case "Runtime.bindingCalled":
				return this.passkeyWanted(ctl, e);
			case "WebAuthn.credentialAdded":
				return this.credentialMade(ctl, e);
			default:
				return;
		}
	}

	private tabGone(ctl: Controller, targetId: string): void {
		const page = ctl.pages.get(targetId);
		if (!page) return;
		ctl.pages.delete(targetId);
		if (page.sessionId) ctl.bySession.delete(page.sessionId);
		const cast = this.casts.get(targetId);
		if (cast) {
			clearTimeout(cast.ackTimer);
			this.casts.delete(targetId);
			// Its viewers go on with another tab.
			for (const viewer of cast.viewers) {
				const view = this.views.get(viewer);
				this.views.delete(viewer);
				if (view) void this.view(viewer, { takeoverId: view.takeoverId, targetId: "", on: true }).catch(() => undefined);
			}
		}
		this.tabsChanged();
	}

	private pageOfSession(ctl: Controller, sessionId: string | undefined): Page | undefined {
		return sessionId ? ctl.pages.get(ctl.bySession.get(sessionId) ?? "") : undefined;
	}

	/** The tab Claude or the user used last; a blank one when the browser has none. */
	private async currentPage(ctl: Controller): Promise<Page> {
		const page = ctl.pages.get(this.currentTarget) ?? ctl.pages.values().next().value;
		if (page) return page;
		const { targetId } = await ctl.conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
		return this.pageById(ctl, targetId);
	}

	private async pageById(ctl: Controller, targetId: string): Promise<Page> {
		const known = ctl.pages.get(targetId);
		if (known) return known;
		const { targetInfo } = await ctl.conn.send<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId });
		return this.addPage(ctl, targetInfo);
	}

	/** Opens `url` in the current tab when it is blank, else in a new tab, and brings it to the front. */
	private async show(ctl: Controller, url: string): Promise<Page> {
		const current = ctl.pages.get(this.currentTarget) ?? ctl.pages.values().next().value;
		let page: Page;
		if (current && blank(current.url)) {
			page = current;
			await page.ready;
			if (!page.sessionId) throw new BrowserToolError("the tab cannot be reached");
			await ctl.conn.send("Page.navigate", { url }, page.sessionId);
		} else {
			const { targetId } = await ctl.conn.send<{ targetId: string }>("Target.createTarget", { url });
			page = await this.pageById(ctl, targetId);
		}
		page.url = url;
		this.currentTarget = page.targetId;
		await ctl.conn.send("Target.activateTarget", { targetId: page.targetId }).catch(() => undefined);
		await page.ready;
		return page;
	}

	private tabs(ctl: Controller): TabInfo[] {
		return [...ctl.pages.values()].map(({ targetId, url, title }) => ({ targetId, url, title }));
	}

	private used(session: BrowserSession): void {
		this.users.set(session.key, session.threadId);
		this.lastUser = session;
	}

	// --- Claude's tools ---------------------------------------------------------

	/** open_browser: the browser's debugging address, and the tab with `url` when given. */
	async open(session: BrowserSession, url?: string) {
		const target = url === undefined ? undefined : checkBrowserUrl(url);
		const ctl = await this.controller(true);
		this.used(session);
		const page = target ? await this.show(ctl, target) : await this.currentPage(ctl);
		this.currentTarget = page.targetId;
		return {
			cdp_url: `http://127.0.0.1:${ctl.endpoint.port}`,
			ws_endpoint: ctl.endpoint.wsUrl,
			tab: { url: page.url, title: page.title },
			tabs: ctl.pages.size,
			headless: ctl.endpoint.headless,
		};
	}

	/** request_takeover: resolves when the user gives the tab back; rejects when it ends otherwise. */
	async requestTakeover(session: BrowserSession, input: { reason: string; url?: string }): Promise<TakeoverResult> {
		if ([...this.takeovers.values()].some((t) => t.key === session.key)) {
			throw new BrowserToolError("this session already waits for the user on the browser");
		}
		const reason = input.reason.trim().slice(0, MAX_REASON_CHARS);
		const target = input.url === undefined ? undefined : checkBrowserUrl(input.url);
		const ctl = await this.controller(true);
		this.used(session);
		const page = target ? await this.show(ctl, target) : await this.currentPage(ctl);
		return new Promise<TakeoverResult>((resolve, reject) => {
			this.openTakeover({ threadId: session.threadId, key: session.key, reason, url: page.url, targetId: page.targetId, resolve, reject });
		});
	}

	/** virtual_authenticator: a test passkey authenticator in every tab (new ones too), or none. */
	async setVirtualAuthenticator(session: BrowserSession, enable: boolean) {
		const ctl = await this.controller(true);
		this.used(session);
		this.virtualOn = enable;
		if (!enable) this.credentials.clear();
		const pages = [...ctl.pages.values()];
		await Promise.all(pages.map((p) => (enable ? this.addAuthenticator(ctl, p) : this.removeAuthenticator(ctl, p))));
		return enable
			? {
					enabled: true,
					tabs: pages.length,
					note: "Every tab, and every tab opened later, has a CTAP2 platform authenticator that verifies the user without asking. Passkeys made with it are test keys in memory only: gone when it is turned off or the browser closes.",
				}
			: { enabled: false };
	}

	private async addAuthenticator(ctl: Controller, page: Page): Promise<void> {
		await page.ready;
		await this.authenticate(ctl, page);
	}

	/** Gives an attached tab the test authenticator and every test passkey made so far. */
	private async authenticate(ctl: Controller, page: Page): Promise<void> {
		if (page.authenticatorId || !page.sessionId) return;
		const sessionId = page.sessionId;
		await ctl.conn.send("WebAuthn.enable", { enableUI: false }, sessionId);
		const { authenticatorId } = await ctl.conn.send<{ authenticatorId: string }>("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR }, sessionId);
		page.authenticatorId = authenticatorId;
		for (const credential of this.credentials.values()) {
			await ctl.conn.send("WebAuthn.addCredential", { authenticatorId, credential }, sessionId).catch(() => undefined);
		}
	}

	private async removeAuthenticator(ctl: Controller, page: Page): Promise<void> {
		await page.ready;
		const authenticatorId = page.authenticatorId;
		if (!authenticatorId || !page.sessionId) return;
		delete page.authenticatorId;
		await ctl.conn.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }, page.sessionId).catch(() => undefined);
		await ctl.conn.send("WebAuthn.disable", {}, page.sessionId).catch(() => undefined);
	}

	/** A test passkey made in one tab: the other tabs' authenticators get it too. */
	private credentialMade(ctl: Controller, e: CdpEvent): void {
		const credential = e.params.credential as { credentialId?: unknown } | undefined;
		const id = typeof credential?.credentialId === "string" ? credential.credentialId : "";
		if (!this.virtualOn || !credential || id === "" || this.credentials.has(id)) return;
		this.credentials.set(id, credential);
		for (const page of ctl.pages.values()) {
			if (!page.authenticatorId || !page.sessionId || page.authenticatorId === e.params.authenticatorId) continue;
			void ctl.conn.send("WebAuthn.addCredential", { authenticatorId: page.authenticatorId, credential }, page.sessionId).catch(() => undefined);
		}
	}

	/** A page asked for a real passkey: devices and the sessions that used the browser hear of it. */
	private passkeyWanted(ctl: Controller, e: CdpEvent): void {
		if (e.params.name !== PASSKEY_BINDING || this.virtualOn) return;
		const page = this.pageOfSession(ctl, e.sessionId);
		const origin = page ? originOf(page.url) : undefined;
		if (!origin) return;
		const create = e.params.payload === "create";
		if (!this.throttle.allow(origin, create)) return;
		const notice: PasskeyNoticeInfo = { origin, create, threadId: this.lastUser?.threadId ?? "", at: this.now() };
		this.log(`browser: ${origin} asked for a passkey`);
		this.emit({ type: "passkey", notice });
		for (const t of this.takeovers.values()) if (t.key !== "" && !t.passkeys.includes(origin)) t.passkeys.push(origin);
		const text = passkeyNoticeText(notice);
		for (const key of this.users.keys()) this.notices.push(key, text);
	}

	/** What a session's next tool result tells Claude (passkey requests), once. */
	takeNotices(key: string): string[] {
		return this.notices.take(key);
	}

	// --- takeovers ----------------------------------------------------------------

	private openTakeover(init: Omit<Takeover, "takeoverId" | "expiresAt" | "announcedExpiry" | "timer" | "passkeys">): Takeover {
		const expiresAt = this.now() + this.idleMs;
		const t: Takeover = { ...init, takeoverId: randomBytes(12).toString("base64url"), expiresAt, announcedExpiry: expiresAt, timer: undefined, passkeys: [] };
		this.takeovers.set(t.takeoverId, t);
		this.currentTarget = t.targetId;
		this.arm(t);
		this.emit({ type: "takeover", takeover: infoOf(t) });
		return t;
	}

	private arm(t: Takeover): void {
		clearTimeout(t.timer);
		t.timer = setTimeout(() => this.expire(t.takeoverId), Math.max(0, t.expiresAt - this.now()) + 5);
		t.timer.unref?.();
	}

	private expire(id: string): void {
		const t = this.takeovers.get(id);
		if (!t) return;
		if (this.now() < t.expiresAt) return this.arm(t);
		const page = this.ctl?.pages.get(t.targetId);
		const minutes = Math.round(this.idleMs / 60_000);
		this.finish(t, new BrowserToolError(`nobody acted on the browser for ${minutes} minutes${page ? `; it shows ${page.url}` : ""}`));
	}

	/** The user acts on a takeover: its expiry moves on. */
	private touch(t: Takeover): void {
		t.expiresAt = this.now() + this.idleMs;
		if (t.expiresAt - t.announcedExpiry >= ANNOUNCE_MOVE_MS) {
			t.announcedExpiry = t.expiresAt;
			this.emit({ type: "takeover", takeover: infoOf(t) });
		}
	}

	private takeover(id: string): Takeover {
		const t = this.takeovers.get(id);
		if (!t) throw new TakeoverGone("this takeover is no longer open");
		return t;
	}

	/** Ends a takeover: given back (a result for Claude) or not (an error for Claude). */
	private finish(t: Takeover, outcome: { device: string } | Error): void {
		if (!this.takeovers.delete(t.takeoverId)) return;
		clearTimeout(t.timer);
		for (const [viewer, view] of [...this.views]) if (view.takeoverId === t.takeoverId) this.detach(viewer);
		this.emit({ type: "ended", takeoverId: t.takeoverId, threadId: t.threadId });
		const page = this.ctl?.pages.get(t.targetId) ?? this.ctl?.pages.get(this.currentTarget);
		if (outcome instanceof Error) {
			t.reject?.(outcome);
			return;
		}
		this.opts.audit.write({ device: outcome.device, action: "browser_control", path: (page && originOf(page.url)) ?? "", detail: t.key ? "claude" : "user" });
		t.resolve?.({
			returned: true,
			url: page?.url ?? "",
			title: page?.title ?? "",
			tabs: this.ctl?.pages.size ?? 0,
			...(t.passkeys.length ? { passkey_requests: t.passkeys } : {}),
		});
	}

	/** A device opens the running browser from the machine's page (one such takeover at a time). */
	async startControl(): Promise<TakeoverInfo> {
		const ctl = await this.controller(false);
		const mine = [...this.takeovers.values()].find((t) => t.key === "");
		if (mine) {
			this.touch(mine);
			return infoOf(mine);
		}
		const page = await this.currentPage(ctl);
		return infoOf(this.openTakeover({ threadId: "", key: "", reason: "", url: page.url, targetId: page.targetId }));
	}

	/** A device gives a takeover back (to Claude) or closes its own. */
	end(takeoverId: string, device: string): void {
		this.finish(this.takeover(takeoverId), { device });
	}

	// --- viewing and input ----------------------------------------------------------

	/** A device starts or stops viewing a takeover's tab, or switches tabs. */
	async view(viewer: BrowserViewer, req: { takeoverId: string; targetId: string; on: boolean; maxWidth?: number; maxHeight?: number }): Promise<void> {
		if (!req.on) return this.detach(viewer);
		const t = this.takeover(req.takeoverId);
		this.touch(t);
		const ctl = await this.controller(false);
		const page = ctl.pages.get(req.targetId) ?? ctl.pages.get(t.targetId) ?? (await this.currentPage(ctl));
		t.targetId = page.targetId;
		this.currentTarget = page.targetId;
		const before = this.views.get(viewer);
		if (before?.targetId !== page.targetId) this.detach(viewer);
		this.views.set(viewer, { takeoverId: t.takeoverId, targetId: page.targetId });
		await ctl.conn.send("Target.activateTarget", { targetId: page.targetId }).catch(() => undefined);
		const size = (n: number | undefined) => Math.min(Math.max(n || DEFAULT_SIZE, 200), MAX_SIZE);
		await this.cast(ctl, page, viewer, size(req.maxWidth), size(req.maxHeight));
		this.sendState(viewer);
	}

	private async cast(ctl: Controller, page: Page, viewer: BrowserViewer, maxWidth: number, maxHeight: number): Promise<void> {
		const known = this.casts.get(page.targetId);
		if (known) {
			known.viewers.add(viewer);
			const last = known.last;
			const view = this.views.get(viewer);
			if (last && view) viewer.frame({ takeoverId: view.takeoverId, targetId: page.targetId, ...last });
			return;
		}
		await page.ready;
		const sessionId = page.sessionId;
		if (!sessionId) throw new BrowserToolError("the tab cannot be reached");
		const cast: Cast = { targetId: page.targetId, viewers: new Set([viewer]), lastAck: 0, ackTimer: undefined, last: undefined };
		this.casts.set(page.targetId, cast);
		await ctl.conn.send("Page.enable", {}, sessionId);
		await ctl.conn.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth, maxHeight, everyNthFrame: 1 }, sessionId);
	}

	/** A device stops viewing (asked, another tab, its takeover ended, or its link closed). */
	detach(viewer: BrowserViewer): void {
		const view = this.views.get(viewer);
		if (!view) return;
		this.views.delete(viewer);
		const cast = this.casts.get(view.targetId);
		if (!cast) return;
		cast.viewers.delete(viewer);
		if (cast.viewers.size > 0) return;
		clearTimeout(cast.ackTimer);
		this.casts.delete(view.targetId);
		const sessionId = this.ctl?.pages.get(view.targetId)?.sessionId;
		if (sessionId) void this.ctl?.conn.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
	}

	private frame(ctl: Controller, e: CdpEvent): void {
		const page = this.pageOfSession(ctl, e.sessionId);
		const cast = page ? this.casts.get(page.targetId) : undefined;
		if (!page || !cast || !e.sessionId) return;
		const meta = (e.params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
		const jpeg = Buffer.from(String(e.params.data ?? ""), "base64");
		const picture = { jpeg: new Uint8Array(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength), pageWidth: meta.deviceWidth ?? 0, pageHeight: meta.deviceHeight ?? 0 };
		if (jpeg.byteLength <= MAX_FRAME_BYTES) {
			cast.last = picture;
			for (const viewer of cast.viewers) {
				const view = this.views.get(viewer);
				if (view && !viewer.busy()) viewer.frame({ takeoverId: view.takeoverId, targetId: page.targetId, ...picture });
			}
		}
		const frameSession = e.params.sessionId;
		const pageSession = e.sessionId;
		clearTimeout(cast.ackTimer);
		cast.ackTimer = setTimeout(() => {
			cast.lastAck = this.now();
			void ctl.conn.send("Page.screencastFrameAck", { sessionId: frameSession }, pageSession).catch(() => undefined);
		}, Math.max(0, cast.lastAck + MIN_FRAME_MS - this.now()));
		cast.ackTimer.unref?.();
	}

	/** One input of the user on a takeover's tab; refused unless the takeover is open. Never logged. */
	async input(takeoverId: string, targetId: string, action: InputAction): Promise<void> {
		const t = this.takeover(takeoverId);
		const ctl = this.ctl;
		if (!ctl?.conn.isOpen) throw new BrowserNotRunning("the tunelo browser is not running");
		const page = ctl.pages.get(targetId || t.targetId);
		if (!page?.sessionId) throw new BrowserToolError("that tab is closed");
		const commands = inputCommands(action);
		this.touch(t);
		for (const c of commands) await ctl.conn.send(c.method, c.params, page.sessionId);
		const focusMayMove = (action.kind === "mouse" && action.mouse.type === "up") || (action.kind === "key" && (action.key.key === "Tab" || action.key.key === "Enter"));
		if (focusMayMove) void this.checkPasswordFocus(ctl, page, t).catch(() => undefined);
	}

	/** Whether the user now types into a password field (the device keeps its keyboard from learning it). */
	private async checkPasswordFocus(ctl: Controller, page: Page, t: Takeover): Promise<void> {
		if (!page.sessionId) return;
		const answer = await ctl.conn.send<{ result?: { value?: unknown } }>(
			"Runtime.evaluate",
			{ expression: "(() => { const e = document.activeElement; return !!e && e.tagName === 'INPUT' && e.type === 'password'; })()", returnByValue: true, silent: true },
			page.sessionId,
		);
		const focused = answer.result?.value === true;
		if (focused === page.passwordFocused) return;
		page.passwordFocused = focused;
		for (const [viewer, view] of this.views) if (view.takeoverId === t.takeoverId) this.sendState(viewer);
	}

	private sendState(viewer: BrowserViewer): void {
		const view = this.views.get(viewer);
		const ctl = this.ctl;
		if (!view || !ctl) return;
		viewer.state({ takeoverId: view.takeoverId, tabs: this.tabs(ctl), targetId: view.targetId, passwordFocused: ctl.pages.get(view.targetId)?.passwordFocused ?? false });
	}

	/** Tabs opened, closed, renamed or navigated: viewers get the list again, changes close together as one. */
	private tabsChanged(): void {
		if (this.stateTimer || this.views.size === 0) return;
		this.stateTimer = setTimeout(() => {
			this.stateTimer = undefined;
			for (const viewer of this.views.keys()) this.sendState(viewer);
		}, STATE_DELAY_MS);
		this.stateTimer.unref?.();
	}

	// --- endings ----------------------------------------------------------------------

	/** A session ended: its takeover ends and it hears of nothing more. */
	endSession(key: string): void {
		for (const t of [...this.takeovers.values()]) if (t.key === key) this.finish(t, new BrowserToolError("the session ended"));
		this.users.delete(key);
		this.notices.drop(key);
		if (this.lastUser?.key === key) this.lastUser = undefined;
	}

	/** tunelo stops: every takeover ends and the browser closes (its sign-ins stay in the profile). */
	async close(): Promise<void> {
		for (const t of [...this.takeovers.values()]) this.finish(t, new BrowserToolError("tunelo stopped"));
		clearTimeout(this.stateTimer);
		const ctl = this.ctl;
		if (!ctl) return;
		await ctl.conn.send("Browser.close").catch(() => undefined);
		ctl.conn.close();
	}
}

function infoOf(t: Takeover): TakeoverInfo {
	return { takeoverId: t.takeoverId, threadId: t.threadId, reason: t.reason, url: t.url, expiresAt: t.expiresAt };
}
