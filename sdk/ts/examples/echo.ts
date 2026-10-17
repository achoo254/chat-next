// Echo bot: repeats every text message that is not a command.
import { run } from "./run.ts";

await run((bot) => {
	bot.command("start", (ctx) => ctx.reply("Xin chào! Gửi gì mình nhắc lại nấy."));
	bot.message(async (ctx) => {
		const message = ctx.message;
		const text = message?.text;
		// Text messages only: a media message's text is its caption.
		if (ctx.command === undefined && message?.media === undefined && text !== undefined && text !== "") {
			await ctx.reply(text);
		}
	});
});
