// Connection states (mockups/chat.html#connection-states) on a real network
// loss: the device going offline, and the server dropping the realtime
// WebSocket (the e2e stack's switch, server/cmd/e2e-stack/realtime_switch.go).
// Each case checks the header, the banner and the composer, then the
// recovery: queued messages go out exactly once and missed ones arrive.
import assert from "node:assert/strict";
import { after, before } from "node:test";
import type { Browser, Locator } from "playwright";
import { composer, launch, message, messages, openChat, scenario, send, signIn, startPrivateChat, type Person } from "./people.ts";

/** The api of the e2e stack, where the realtime switch lives (Vite does not proxy it). */
const API_ORIGIN = process.env.E2E_API_ORIGIN ?? "http://127.0.0.1:4600";
/** Grace period of "Đang kết nối…" (OFFLINE_AFTER_MS) plus slack. */
const NO_NETWORK_MS = 20_000;
/** The reconnect backoff after a long outage waits up to 16 s, then the sync runs. */
const RECOVERY_MS = 45_000;

let browser: Browser;
let an: Person;
let binh: Person;

async function realtime(state: "down" | "up"): Promise<void> {
	const response = await fetch(`${API_ORIGIN}/e2e/realtime?state=${state}`, { method: "POST" });
	assert.equal(response.status, 204, `realtime ${state}`);
}

const header = (person: Person): Locator => person.page.locator(".convo-head");
const offlineBanner = (person: Person): Locator => person.page.getByRole("status").filter({ hasText: /^Ngoại tuyến/ });

before(async () => {
	browser = await launch();
	an = await signIn(browser, "an");
	binh = await signIn(browser, "binh");
	await startPrivateChat(an, "binh");
	await send(an, "Kiểm tra kết nối");
	await openChat(binh, "An");
	await message(binh, "Kiểm tra kết nối").waitFor();
});
after(async () => {
	await realtime("up").catch(() => undefined);
	await browser.close();
});

scenario("the device goes offline: waiting for the network, then the queued message goes out once", () => [an, binh], async () => {
	await an.context.setOffline(true);
	await header(an).getByText("Chờ mạng").waitFor();
	await offlineBanner(an).waitFor();
	assert.equal(await composer(an).getAttribute("placeholder"), "Tin sẽ gửi khi có mạng");

	const box = composer(an);
	await box.fill("Gửi lúc mất mạng");
	await box.press("Enter");
	// Queued with the clock (mock: "Chờ gửi"), not failed.
	await message(an, "Gửi lúc mất mạng").getByRole("img", { name: "Chờ gửi" }).waitFor();
	await offlineBanner(an).filter({ hasText: "Ngoại tuyến — 1 tin sẽ gửi khi có mạng" }).waitFor();

	await an.context.setOffline(false);
	await offlineBanner(an).waitFor({ state: "detached", timeout: RECOVERY_MS });
	await header(an).getByText("Chờ mạng").waitFor({ state: "detached" });
	await message(an, "Gửi lúc mất mạng").getByRole("img", { name: /Chờ gửi|Đang gửi/ }).waitFor({ state: "detached", timeout: RECOVERY_MS });
	await message(binh, "Gửi lúc mất mạng").waitFor({ timeout: RECOVERY_MS });
	assert.equal(await messages(binh).filter({ hasText: "Gửi lúc mất mạng" }).count(), 1);
	assert.notEqual(await composer(an).getAttribute("placeholder"), "Tin sẽ gửi khi có mạng");
});

scenario("the server drops the WebSocket: reconnecting, then no network, then recovery", () => [an, binh], async () => {
	await realtime("down");
	await header(an).getByText("Đang kết nối…").waitFor();
	// The socket stays down past the grace period: the screens treat it as no network.
	await header(an).getByText("Chờ mạng").waitFor({ timeout: NO_NETWORK_MS });
	await offlineBanner(an).waitFor();
	assert.equal(await composer(an).getAttribute("placeholder"), "Tin sẽ gửi khi có mạng");

	// Calls still work for Bình: An must catch this message up after reconnecting.
	await send(binh, "Gửi khi An mất kết nối");

	await realtime("up");
	await offlineBanner(an).waitFor({ state: "detached", timeout: RECOVERY_MS });
	await header(an).getByText(/Chờ mạng|Đang kết nối/).waitFor({ state: "detached", timeout: RECOVERY_MS });
	await message(an, "Gửi khi An mất kết nối").waitFor({ timeout: RECOVERY_MS });

	// Realtime works again both ways.
	await send(an, "Đã có kết nối lại");
	await message(binh, "Đã có kết nối lại").waitFor();
});
