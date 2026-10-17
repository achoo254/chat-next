"""Echo bot: repeats text messages; /start greets."""

from _run import main

from chatbot import Bot, Context


def setup(bot: Bot) -> None:
    @bot.command("start")
    def start(ctx: Context) -> None:
        ctx.reply("Xin chào! Gửi gì mình nhắc lại nấy.")

    @bot.message
    def echo(ctx: Context) -> None:
        message = ctx.message
        if message is None or ctx.command is not None or "media" in message:
            return  # Only plain text messages that are not commands are echoed.
        text = message.get("text")
        if text:
            ctx.reply(text)


if __name__ == "__main__":
    main(setup)
