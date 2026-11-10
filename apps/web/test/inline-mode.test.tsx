// Inline mode of bots (mockups/bots.html#inline-mode): "@bot_username "
// shows the bot's hint, a query its results; picking one posts it as the
// user's message "via" the bot. The results are a listbox attached to the
// message box, which keeps the focus and the keys, as in Telegram Web.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { inlineDraft, inlineToken } from "../src/messaging/bots/inline-token.ts";
import { seedDemo, type Demo } from "./support/demo-data.ts";
import type { FakeInlineResult } from "./support/fake-bots.ts";
import { renderMessaging } from "./support/render-messaging.tsx";
import { boxValue } from "./support/plain-text-box.ts";

const LONG = { timeout: 5000 };

const FILMS: readonly FakeInlineResult[] = [
	{ id: "d1", title: "Dune: Phần Hai", description: "20:15 · CGV", text: "Dune: Phần Hai lúc 20:15" },
	{ id: "d2", title: "Lật Mặt 7", description: "21:00 · Lotte", text: "Lật Mặt 7 lúc 21:00" },
	{ id: "d3", title: "Mai", description: "22:30 · BHD", text: "Mai lúc 22:30" },
];

/** The demo with an inline bot answering FILMS (or a timeout for "chậm"). */
function seedInlineBot(): { demo: Demo; botId: number } {
	const demo = seedDemo();
	const f = demo.fixture;
	const botId = f.bots.seed("Lịch chiếu", "lich_chieu_bot", { owned: false });
	f.setInlinePlaceholder(botId, "Tên phim hoặc rạp…");
	f.bots.inline.set(botId, (query) => (query === "chậm" ? "timeout" : FILMS));
	return { demo, botId };
}

async function openOps(demo: Demo): Promise<HTMLElement> {
	renderMessaging(demo.fixture, `/c/${demo.ids.ops}`);
	return screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
}

const listbox = (): Promise<HTMLElement> => screen.findByRole("listbox", { name: "Kết quả từ @lich_chieu_bot" }, LONG);

/** The message posted with this text, and that it carries the bot's name. */
async function expectPostedViaBot(text: string): Promise<void> {
	const log = screen.getByRole("log");
	const sent = await within(log).findByText(text, {}, LONG);
	const bubble = sent.closest(".bubble");
	if (!(bubble instanceof HTMLElement)) throw new Error("no bubble");
	await waitFor(() => expect(within(bubble).getByText("@lich_chieu_bot")).toBeTruthy(), LONG);
}

describe("the inline mode rule", () => {
	it("takes '@username ' at the start of the draft and the rest as the query, line breaks included", () => {
		expect(inlineDraft("@lich_chieu_bot ")).toEqual({ username: "lich_chieu_bot", query: "" });
		expect(inlineDraft("@lich_chieu_bot phim tối\nnay")).toEqual({ username: "lich_chieu_bot", query: "phim tối\nnay" });
		expect(inlineDraft("@lich_chieu_bot")).toBeNull();
		expect(inlineDraft("@abc x")).toBeNull();
		expect(inlineDraft("xem @lich_chieu_bot phim")).toBeNull();
	});

	it("makes the whole draft the token, wherever the caret is", () => {
		expect(inlineToken("@lich_chieu_bot phim")).toEqual({ start: 0, end: 20, query: "lich_chieu_bot phim" });
		expect(inlineToken("@lich")).toBeNull();
	});
});

describe("inline mode", () => {
	it("shows the bot's hint and results, and posts the pick via the bot", async () => {
		const { demo, botId } = seedInlineBot();
		const f = demo.fixture;
		const box = await openOps(demo);

		await userEvent.type(box, "@lich_chieu_bot ");
		const panel = await screen.findByRole("region", { name: "Kết quả từ @lich_chieu_bot" }, LONG);
		expect(within(panel).getByText("Tên phim hoặc rạp…")).toBeTruthy();

		await userEvent.type(box, "chậm");
		expect(await screen.findByText("Bot chưa trả lời. Gõ tiếp để thử lại.", {}, LONG)).toBeTruthy();

		await userEvent.clear(box);
		await userEvent.type(box, "@lich_chieu_bot phim tối nay");
		const list = await listbox();
		expect(f.bots.inlineQueries.at(-1)).toEqual({ botId, query: "phim tối nay", offset: "" });
		const options = within(list).getAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual(["Dune: Phần Hai20:15 · CGV", "Lật Mặt 721:00 · Lotte", "Mai22:30 · BHD"]);
		// The first result is highlighted, and the box points at it.
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		expect(box.getAttribute("aria-controls")).toBe(list.id);
		expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

		// A click picks without taking the focus from the box.
		const second = options[1];
		if (second === undefined) throw new Error("no second result");
		await userEvent.click(second);
		expect(document.activeElement).toBe(box);

		// Posted by the user, labelled with the bot; the draft is cleared, the list gone.
		await expectPostedViaBot("Lật Mặt 7 lúc 21:00");
		expect(boxValue(box)).toBe("");
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		expect(box.getAttribute("aria-activedescendant")).toBeNull();
	});

	it("moves through the results with the arrows and posts the highlighted one with Enter", async () => {
		const { demo } = seedInlineBot();
		const box = await openOps(demo);
		await userEvent.type(box, "@lich_chieu_bot phim");
		const list = await listbox();
		const options = within(list).getAllByRole("option");

		await userEvent.keyboard("{ArrowDown}{ArrowDown}");
		expect(options[2]?.getAttribute("aria-selected")).toBe("true");
		expect(box.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
		// ↓ past the last result goes back to the first; ↑ from the first to the last.
		await userEvent.keyboard("{ArrowDown}");
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		await userEvent.keyboard("{ArrowUp}");
		expect(options[2]?.getAttribute("aria-selected")).toBe("true");
		// The arrows never moved the caret or changed the text.
		expect(boxValue(box)).toBe("@lich_chieu_bot phim");

		await userEvent.keyboard("{Enter}");
		await expectPostedViaBot("Mai lúc 22:30");
		expect(boxValue(box)).toBe("");
		// Enter posted the result, not the draft as a message.
		expect(screen.queryByText("@lich_chieu_bot phim")).toBeNull();
	});

	it("closes on Esc with the text kept, opens again as the text changes, and leaves a reply alone", async () => {
		const { demo } = seedInlineBot();
		const box = await openOps(demo);
		const log = await screen.findByRole("log", {}, LONG);
		const message = await within(log).findByText("Dashboard ổn định.", {}, LONG);
		fireEvent.contextMenu(message);
		await userEvent.click(await screen.findByRole("menuitem", { name: "Trả lời" }, LONG));
		await userEvent.type(box, "@lich_chieu_bot phim");
		await listbox();

		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		expect(boxValue(box)).toBe("@lich_chieu_bot phim");
		// That Esc closed the list only: the reply is still there.
		expect(document.querySelector(".compose-bar")).not.toBeNull();

		await userEvent.type(box, "s");
		expect(await listbox()).toBeTruthy();
	});

	it("shows only while the box has the focus, and again where it was when the focus comes back", async () => {
		const { demo } = seedInlineBot();
		const box = await openOps(demo);
		await userEvent.type(box, "@lich_chieu_bot phim");
		await listbox();
		await userEvent.keyboard("{ArrowDown}");

		act(() => box.blur());
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		expect(box.getAttribute("aria-activedescendant")).toBeNull();

		act(() => box.focus());
		const options = within(await listbox()).getAllByRole("option");
		expect(boxValue(box)).toBe("@lich_chieu_bot phim");
		expect(options).toHaveLength(3);
	});

	it("shows the results of a saved draft once the box has the focus", async () => {
		const { demo } = seedInlineBot();
		window.localStorage.setItem(`chat:draft:${demo.fixture.selfId}:${demo.ids.ops}`, "@lich_chieu_bot phim");
		const box = await openOps(demo);
		await waitFor(() => expect(boxValue(box)).toBe("@lich_chieu_bot phim"), LONG);
		// A phone does not put the caret in the box on its own: nothing shows until the user taps it.
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		await userEvent.click(box);
		expect(within(await listbox()).getAllByRole("option")).toHaveLength(3);
	});

	it("asks for the next page as the list reaches its end, and posts a result of that page", async () => {
		const { demo, botId } = seedInlineBot();
		const f = demo.fixture;
		const many = Array.from({ length: 5 }, (_, n) => ({ id: `r${n}`, title: `Suất ${n + 1}`, description: "", text: `Suất chiếu ${n + 1}` }));
		f.bots.inline.set(botId, () => many);
		f.bots.inlinePageSize = 2;
		const box = await openOps(demo);
		await userEvent.type(box, "@lich_chieu_bot suất");
		const list = await listbox();
		// The list asks again while its end is in view (a test page has no layout, so all of it is).
		await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(5), LONG);
		expect(f.bots.inlineQueries.map((q) => q.offset)).toEqual(["", "2", "4"]);

		await userEvent.click(within(list).getByRole("option", { name: "Suất 4" }));
		await within(screen.getByRole("log")).findByText("Suất chiếu 4", {}, LONG);
	});

	it("leaves the keys to an IME while it composes", async () => {
		const { demo } = seedInlineBot();
		const box = await openOps(demo);
		await userEvent.type(box, "@lich_chieu_bot phim");
		const options = within(await listbox()).getAllByRole("option");

		fireEvent.compositionStart(box);
		fireEvent.keyDown(box, { key: "ArrowDown", isComposing: true });
		fireEvent.keyDown(box, { key: "Enter", isComposing: true });
		fireEvent.compositionEnd(box);
		expect(options[0]?.getAttribute("aria-selected")).toBe("true");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(screen.queryByText("Dune: Phần Hai lúc 20:15")).toBeNull();
		expect(boxValue(box)).toBe("@lich_chieu_bot phim");
	});

	it("stays quiet for people and bots without inline mode", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.bots.seed("Không inline", "plain_bot", { owned: false });
		const box = await openOps(demo);
		await userEvent.type(box, "@plain_bot xin chào");
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		expect(f.bots.inlineQueries).toEqual([]);
		expect(box.getAttribute("aria-activedescendant")).toBeNull();
	});
});
