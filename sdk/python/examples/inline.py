"""Inline bot: answers every inline query with one article echoing the query."""

from _run import main

from chatbot import Bot, Context


def setup(bot: Bot) -> None:
    @bot.inline_query
    def answer(ctx: Context) -> None:
        query = ctx.inline_query
        if query is None:
            return
        text = query["query"]
        # An article needs a title and a text: an empty query gets no result.
        results = [{"type": "article", "id": "1", "title": text.upper(), "text": text}] if text else []
        ctx.answer_inline(results, cache_time=1)


if __name__ == "__main__":
    main(setup)
