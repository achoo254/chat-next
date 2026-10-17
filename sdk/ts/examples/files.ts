// Files bot: /file uploads hello.txt; a media message is downloaded and its
// size reported back.
import { InputFile } from "../src/index.ts";
import { run } from "./run.ts";

await run((bot) => {
	bot.command("file", async (ctx) => {
		const chat = ctx.message?.chat;
		if (chat === undefined) {
			return;
		}
		await ctx.client.sendMediaUpload({
			chat_id: chat.id,
			kind: "document",
			file: new InputFile("hello.txt", new TextEncoder().encode("xin chào")),
			text: "Tệp mẫu",
		});
	});
	bot.message(async (ctx) => {
		const media = ctx.message?.media;
		if (media?.file_id === undefined) {
			return;
		}
		const file = await ctx.client.getFile(media.file_id);
		const bytes = await ctx.client.downloadFile(file);
		await ctx.reply(`Nhận ${media.file_name ?? media.kind}: ${bytes.length} byte`);
	});
});
