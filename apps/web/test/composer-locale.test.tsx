// The composer's own words are screen copy (use-screens-copy.ts), fetched in
// English or Chinese on first use. Opening a chat in English must never hand
// the whole messaging app to the page loader while they load: the chat stays
// on screen (its message log never hidden or removed) and the composer's box
// waits in place until the real composer, in English, takes over.
import { ChatType } from "@achoo254/chat-proto/chats";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatFixture } from "./support/fake-chat.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

vi.mock("../src/messaging/data/sound.ts", () => ({ playTone: vi.fn() }));
// English screen copy arrives late, as over a slow network: the composer's words are not in when its code is.
const { timing, SLOW_COPY_MS } = vi.hoisted(() => ({ timing: { screensDone: 0 }, SLOW_COPY_MS: 1_500 }));
vi.mock("../src/messaging/copy/en-screens.ts", async (original) => {
	await new Promise((resolve) => setTimeout(resolve, SLOW_COPY_MS));
	const done = await original();
	timing.screensDone = Date.now();
	return done;
});

const LONG = { timeout: 8000 };

afterEach(() => {
	cleanup();
	document.cookie = "hd_lang=; Path=/; Max-Age=0";
	window.localStorage.clear();
});

/** Whether `el` or one of its ancestors is hidden the way Suspense hides shown content. */
function hiddenBySuspense(el: Element): boolean {
	for (let node: Element | null = el; node !== null; node = node.parentElement) {
		if (node instanceof HTMLElement && node.style.display === "none") return true;
	}
	return false;
}

describe("the composer in English", () => {
	it("loads its words without replacing the chat by the page loader", async () => {
		document.cookie = "hd_lang=en; Path=/";
		const fixture = new ChatFixture();
		const ngan = fixture.addUser("Ngân");
		const chat = fixture.createChat(ChatType.PRIVATE, "", [fixture.selfId, ngan]);
		fixture.send(ngan, chat, "Hello from Ngân");
		// The first render suspends on the English copy: the act around it is awaited so React retries it.
		await act(async () => {
			renderMessaging(fixture, `/c/${chat}`);
		});

		const log = await screen.findByRole("log", {}, LONG);
		await within(log).findByText("Hello from Ngân", {}, LONG);
		// The chat is on screen while the composer's words are still on their way (it never waited for them).
		expect(timing.screensDone).toBe(0);
		// From the moment the chat shows, it must stay shown while the composer and its words load.
		let lost = false;
		const watch = (): void => {
			if (!log.isConnected || hiddenBySuspense(log)) lost = true;
		};
		const observer = new MutationObserver(watch);
		observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
		try {
			// The waiting box carries the same name; the real composer replaces it once its code and words are in.
			await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to Ngân" }).getAttribute("aria-busy")).not.toBe("true"), LONG);
			// The composer's own English words are in (screen copy): its send button.
			await screen.findByRole("button", { name: /^Send/ }, LONG);
		} finally {
			observer.disconnect();
		}
		watch();
		expect(lost).toBe(false);
	});
});
