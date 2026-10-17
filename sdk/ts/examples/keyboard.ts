// Keyboard bot: /start shows two buttons; a press is answered and the
// message is edited to show the choice, without the keyboard.
import { run } from "./run.ts";

const CHOICES: Readonly<Record<string, string>> = { a: "A", b: "B" };

await run((bot) => {
	bot.command("start", (ctx) =>
		ctx.reply("Chọn một:", {
			reply_markup: {
				inline_keyboard: [
					[
						{ text: "A", callback_data: "pick:a" },
						{ text: "B", callback_data: "pick:b" },
					],
				],
			},
		}),
	);
	bot.callback("pick:", async (ctx) => {
		const callback = ctx.callback;
		const choice = callback === undefined ? undefined : CHOICES[callback.data.slice("pick:".length)];
		if (callback === undefined || choice === undefined) {
			await ctx.answer();
			return;
		}
		await ctx.answer(`Đã chọn ${choice}`);
		const ref = { chat_id: callback.message.chat.id, seq: callback.message.seq };
		await ctx.client.editMessage({ ...ref, text: `Bạn chọn ${choice}` });
		// editMessage keeps the keyboard; editMessageMarkup without one removes it.
		await ctx.client.editMessageMarkup(ref);
	});
});
