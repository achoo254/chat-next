"""Commands bot: sets its command menu on start; answers /start and /help."""

from _run import main

from chatbot import Bot, Context


def setup(bot: Bot) -> None:
    bot.client.set_commands(commands=[
        {"command": "start", "description": "Bắt đầu"},
        {"command": "help", "description": "Trợ giúp"},
    ])

    @bot.command("start")
    def start(ctx: Context) -> None:
        ctx.reply("Sẵn sàng.")

    @bot.command("help")
    def help_(ctx: Context) -> None:
        ctx.reply("Lệnh: /start, /help")


if __name__ == "__main__":
    main(setup)
