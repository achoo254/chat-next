"""Files bot: /file sends hello.txt; a received file is downloaded and its size reported."""

from _run import main

from chatbot import Bot, Context, InputFile


def setup(bot: Bot) -> None:
    @bot.command("file")
    def send_file(ctx: Context) -> None:
        message = ctx.message
        if message is None:
            return
        ctx.client.send_media_upload(
            chat_id=message["chat"]["id"],
            kind="document",
            file=InputFile("hello.txt", "xin chào".encode("utf-8")),
            text="Tệp mẫu",
        )

    @bot.message
    def receive_file(ctx: Context) -> None:
        message = ctx.message
        media = message.get("media") if message is not None else None
        if media is None or "file_id" not in media:
            return
        info = ctx.client.get_file(media["file_id"])
        data = ctx.client.download_file(info)
        ctx.reply(f"Nhận {media.get('file_name') or media['kind']}: {len(data)} byte")


if __name__ == "__main__":
    main(setup)
