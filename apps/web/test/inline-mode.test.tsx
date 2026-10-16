// Inline mode of bots (mockups/bots.html#inline-mode): "@bot_username "
// shows the bot's hint, a query its results; picking one posts it as the
// user's message "via" the bot.
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { seedDemo } from "./support/demo-data.ts";
import { renderMessaging } from "./support/render-messaging.tsx";

const LONG = { timeout: 5000 };

describe("inline mode", () => {
	it("shows the bot's hint and results, and posts the pick via the bot", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		const botId = f.bots.seed("Lịch chiếu", "lich_chieu_bot", { owned: false });
		f.setInlinePlaceholder(botId, "Tên phim hoặc rạp…");
		f.bots.inline.set(botId, (query) =>
			query === "chậm" ? "timeout" : [{ id: "d1", title: "Dune: Phần Hai", description: "20:15 · CGV", text: "Dune: Phần Hai lúc 20:15" }],
		);
		renderMessaging(f, `/c/${demo.ids.ops}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);

		await userEvent.type(box, "@lich_chieu_bot ");
		const panel = await screen.findByRole("region", { name: "Kết quả từ @lich_chieu_bot" }, LONG);
		expect(within(panel).getByText("Tên phim hoặc rạp…")).toBeTruthy();

		await userEvent.type(box, "chậm");
		expect(await screen.findByText("Bot chưa trả lời. Gõ tiếp để thử lại.", {}, LONG)).toBeTruthy();

		await userEvent.clear(box);
		await userEvent.type(box, "@lich_chieu_bot phim tối nay");
		const pick = await screen.findByRole("button", { name: /Dune: Phần Hai/ }, LONG);
		expect(f.bots.inlineQueries.at(-1)).toEqual({ botId, query: "phim tối nay" });
		await userEvent.click(pick);

		// Posted by the user, labelled with the bot; the draft is cleared.
		const log = screen.getByRole("log");
		const sent = await within(log).findByText("Dune: Phần Hai lúc 20:15", {}, LONG);
		const bubble = sent.closest(".bubble");
		if (bubble === null) throw new Error("no bubble");
		await waitFor(() => expect(within(bubble as HTMLElement).getByText("@lich_chieu_bot")).toBeTruthy(), LONG);
		expect((box as HTMLTextAreaElement).value).toBe("");
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
	});

	it("stays quiet for people and bots without inline mode", async () => {
		const demo = seedDemo();
		const f = demo.fixture;
		f.bots.seed("Không inline", "plain_bot", { owned: false });
		renderMessaging(f, `/c/${demo.ids.ops}`);
		const box = await screen.findByRole("textbox", { name: /Tin nhắn tới/ }, LONG);
		await userEvent.type(box, "@plain_bot xin chào");
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(screen.queryByRole("region", { name: /Kết quả từ/ })).toBeNull();
		expect(f.bots.inlineQueries).toEqual([]);
	});
});
