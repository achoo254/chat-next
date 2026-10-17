"""Keyboard bot: /start shows buttons A and B; a press is answered and the message edited."""

from _run import main

from chatbot import Bot, Context

_CHOICES = {"a": "A", "b": "B"}


def setup(bot: Bot) -> None:
    @bot.command("start")
    def start(ctx: Context) -> None:
        ctx.reply("Chọn một:", reply_markup={"inline_keyboard": [[
            {"text": "A", "callback_data": "pick:a"},
            {"text": "B", "callback_data": "pick:b"},
        ]]})

    @bot.callback("pick:")
    def pick(ctx: Context) -> None:
        callback = ctx.callback
        if callback is None:
            return
        label = _CHOICES.get(callback["data"][len("pick:"):])
        if label is None:
            ctx.answer()
            return
        ctx.answer(f"Đã chọn {label}")
        message = callback["message"]
        chat_id, seq = message["chat"]["id"], message["seq"]
        ctx.client.edit_message(chat_id=chat_id, seq=seq, text=f"Bạn chọn {label}")
        ctx.client.edit_message_markup(chat_id=chat_id, seq=seq)  # No markup removes the keyboard.


if __name__ == "__main__":
    main(setup)
