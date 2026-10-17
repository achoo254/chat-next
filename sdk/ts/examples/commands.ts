// Commands bot: publishes its command menu at startup and answers /start and /help.
import { run } from "./run.ts";

await run(async (bot) => {
	await bot.client.setCommands({
		commands: [
			{ command: "start", description: "Bắt đầu" },
			{ command: "help", description: "Trợ giúp" },
		],
	});
	bot.command("start", (ctx) => ctx.reply("Sẵn sàng."));
	bot.command("help", (ctx) => ctx.reply("Lệnh: /start, /help"));
});
