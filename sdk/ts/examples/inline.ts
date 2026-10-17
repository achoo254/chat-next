// Inline bot: answers every inline query with one article, the query in capitals.
import { run } from "./run.ts";

await run((bot) => {
	bot.inlineQuery(async (ctx) => {
		const query = ctx.inlineQuery?.query ?? "";
		// An article needs a title and a text: an empty query gets no result.
		const results = query === "" ? [] : [{ type: "article" as const, id: "1", title: query.toUpperCase(), text: query }];
		await ctx.answerInline(results, { cache_time: 1 });
	});
});
