// Shared helpers of the multi-user end-to-end scenarios: each person is a
// separate browser context (own cookies, own storage) signed in through the
// fake IdP of server/cmd/e2e-stack. Run the scenarios with `pnpm e2e`.
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from "playwright";

export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://localhost:5173";

/** The test accounts of server/cmd/e2e-stack. */
export const ACCOUNTS = {
	an: { name: "An", username: "an" },
	binh: { name: "Bình", username: "binh" },
	chi: { name: "Chi", username: "chi" },
	/** Nobody talks to Dũng except the first-run scenario: always a brand-new account. */
	dung: { name: "Dũng", username: "dung" },
	/** A brand-new account for the assistant bot scenario. */
	giang: { name: "Giang", username: "giang" },
	/** Signs in before the assistant exists, then gets it as an existing account. */
	hanh: { name: "Hạnh", username: "hanh" },
	/** Deleted by the account scenario (and signed in again as a new account). */
	khoa: { name: "Khoa", username: "khoa" },
} as const;
export type AccountKey = keyof typeof ACCOUNTS;

export interface Person {
	readonly key: AccountKey;
	readonly name: string;
	readonly username: string;
	readonly context: BrowserContext;
	readonly page: Page;
	/** Browser notifications the page asked to show, in order. */
	notifications(): Promise<{ title: string; body: string }[]>;
}

const STEP_TIMEOUT_MS = 15_000;

export async function launch(): Promise<Browser> {
	return chromium.launch();
}

/** The screen a person's browser emulates; default a 1280 × 800 desktop window. */
export type Screen = Pick<BrowserContextOptions, "viewport" | "deviceScaleFactor" | "isMobile" | "hasTouch">;

/**
 * Opens a fresh browser context and signs in as the account. Notifications
 * are granted and recorded instead of shown, so a scenario can assert them.
 */
export async function signIn(browser: Browser, key: AccountKey, screen: Screen = { viewport: { width: 1280, height: 800 } }): Promise<Person> {
	const account = ACCOUNTS[key];
	const context = await browser.newContext({ locale: "vi-VN", ...screen });
	await context.grantPermissions(["notifications"], { origin: WEB_ORIGIN });
	await context.addInitScript(() => {
		const shown: { title: string; body: string }[] = [];
		(window as unknown as { __e2eNotifications: typeof shown }).__e2eNotifications = shown;
		class RecordedNotification extends EventTarget {
			static permission: NotificationPermission = "granted";
			static requestPermission(): Promise<NotificationPermission> {
				return Promise.resolve("granted");
			}
			onclick: ((ev: Event) => void) | null = null;
			constructor(title: string, options?: NotificationOptions) {
				super();
				shown.push({ title, body: options?.body ?? "" });
			}
			close(): void {}
		}
		Object.defineProperty(window, "Notification", { value: RecordedNotification, configurable: true });
	});
	context.setDefaultTimeout(STEP_TIMEOUT_MS);
	const page = await context.newPage();
	await page.goto(WEB_ORIGIN + "/");
	await page.getByRole("link", { name: "Đăng nhập bằng hoandat.com" }).click();
	await page.getByRole("link", { name: `Đăng nhập là ${account.name} @${account.username}` }).click();
	await page.getByRole("searchbox", { name: /Tìm/ }).first().waitFor();
	return {
		key,
		name: account.name,
		username: account.username,
		context,
		page,
		notifications: () =>
			page.evaluate(() => (window as unknown as { __e2eNotifications: { title: string; body: string }[] }).__e2eNotifications.slice()),
	};
}

/** The message rows of the open conversation. */
export function messages(person: Person): Locator {
	return person.page.getByRole("log", { name: "Tin nhắn" }).locator(".msg");
}

/**
 * The latest message row of the open conversation whose own text contains
 * text; replies that only quote it do not count.
 */
export function message(person: Person, text: string): Locator {
	return messages(person)
		.filter({ hasText: text })
		.filter({ hasNot: person.page.locator(".reply", { hasText: text }) })
		.last();
}

/** Opens a private chat with the account through "Tạo chat mới". */
export async function startPrivateChat(person: Person, other: AccountKey): Promise<void> {
	const { page } = person;
	await page.getByRole("button", { name: "Tạo chat mới" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Chat mới" });
	await dialog.getByLabel("Tìm người").fill(ACCOUNTS[other].username);
	await dialog.locator(".result", { hasText: "@" + ACCOUNTS[other].username }).getByRole("button", { name: "Nhắn tin" }).click();
	await composer(person).waitFor();
}

/** Opens the chat titled title from the chat list. */
export async function openChat(person: Person, title: string): Promise<void> {
	await person.page.getByRole("list", { name: "Danh sách chat" }).getByRole("link", { name: title }).first().click();
	await composer(person).waitFor();
}

/** The message box of the open chat. */
export function composer(person: Person): Locator {
	return person.page.getByRole("textbox", { name: /^Tin nhắn tới / });
}

/** Types text into the composer of the open chat and sends it with Enter. */
export async function send(person: Person, text: string): Promise<void> {
	const box = composer(person);
	await box.fill(text);
	await box.press("Enter");
	await message(person, text).waitFor();
	await message(person, text).getByRole("img", { name: "Đang gửi" }).waitFor({ state: "detached" });
}

/**
 * Opens the open chat's info column (named `name`) when it is closed. The
 * toggle's pressed state says whether it is open: on a wide screen the
 * column opens by default and may still be loading (unnamed), and a click
 * then would close it.
 */
export async function chatInfo(person: Person, name: string | RegExp): Promise<Locator> {
	const info = person.page.getByRole("complementary", { name });
	const toggle = person.page.getByRole("button", { name: "Thông tin chat" });
	if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
	await info.waitFor();
	return info;
}

/** Opens the action menu of the message containing text (right click). */
export async function messageMenu(person: Person, text: string): Promise<Locator> {
	await message(person, text).locator(".bubble").click({ button: "right" });
	const menu = person.page.getByRole("menu", { name: /^Thao tác với tin/ });
	await menu.waitFor();
	return menu;
}

const SHOTS_DIR = process.env.E2E_SHOTS_DIR ?? join(tmpdir(), "chat-e2e-shots");

/**
 * A node:test test that, when it fails, saves a screenshot of every
 * person's page to E2E_SHOTS_DIR (default: <tmp>/chat-e2e-shots) and
 * prints the paths.
 */
export function scenario(name: string, people: () => Person[], fn: () => Promise<void>): void {
	test(name, async () => {
		try {
			await fn();
		} catch (err) {
			await mkdir(SHOTS_DIR, { recursive: true });
			const slug = name.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60);
			for (const person of people()) {
				const path = join(SHOTS_DIR, `${slug}-${person.key}.png`);
				await person.page.screenshot({ path }).then(
					() => console.error(`e2e: screenshot ${path}`),
					() => {},
				);
			}
			throw err;
		}
	});
}
