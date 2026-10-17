"""Bot routing: commands with @username, callback prefixes, inline queries and other kinds."""

from __future__ import annotations

import unittest
from typing import List, Optional

from fake_api import FakeApi, ok

from chatbot import Bot, Context, Entity, Update, WebhookAnswer

ME = {"id": 7, "is_bot": True, "name": "Echo", "username": "Echo_Bot", "privacy": True, "tier": "default"}


def text_update(update_id: int, text: str, command_length: int = 0) -> Update:
    entities: List[Entity] = []
    if command_length:
        entities.append({"type": "bot_command", "offset": 0, "length": command_length})
    message = {"chat": {"id": 42, "type": "private"}, "seq": update_id, "date": 0, "text": text}
    if entities:
        message["entities"] = entities
    return {"update_id": update_id, "message": message}  # type: ignore[typeddict-item]


def callback_update(data: str) -> Update:
    return {"update_id": 9, "callback": {  # type: ignore[typeddict-item]
        "id": "cb1", "from": {"id": 1, "is_bot": False, "name": "An"}, "data": data,
        "message": {"chat": {"id": 77, "type": "group"}, "seq": 3, "date": 0, "topic_id": 5, "text": "Chọn"}}}


class RouterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeApi()
        self.api.route("GET", "/me", ok(ME))
        self.api.route("POST", "/messages", ok({"seq": 100}))
        self.bot = Bot(self.api.client())
        self.calls: List[str] = []
        self.contexts: List[Context] = []

    def tearDown(self) -> None:
        self.api.close()

    def record(self, name: str):  # type: ignore[no-untyped-def]
        def handler(ctx: Context) -> None:
            self.calls.append(name)
            self.contexts.append(ctx)
        return handler

    def test_commands_and_username(self) -> None:
        self.bot.command("start", self.record("start"))
        self.bot.message(self.record("message"))
        self.bot.handle_update(text_update(1, "/start", 6))
        self.bot.handle_update(text_update(2, "/start@echo_bot   hello world  ", 15))
        self.bot.handle_update(text_update(3, "/start@other_bot", 16))
        self.bot.handle_update(text_update(4, "/START@Echo_Bot", 15))
        self.bot.handle_update(text_update(5, "/help", 5))
        self.bot.handle_update(text_update(6, "start"))
        self.assertEqual(self.calls, ["start", "start", "message", "start", "message", "message"])
        self.assertEqual(self.contexts[1].args, "hello world")
        self.assertEqual(self.contexts[2].command, "start")  # a command, but for another bot
        self.assertEqual(self.contexts[4].command, "help")
        self.assertIsNone(self.contexts[5].command)
        self.assertEqual(len(self.api.calls("GET", "/me")), 1)  # username read once

    def test_command_entity_must_be_at_offset_zero(self) -> None:
        self.bot.command("start", self.record("start"))
        self.bot.message(self.record("message"))
        update = text_update(1, "hi /start")
        update["message"]["entities"] = [{"type": "bot_command", "offset": 3, "length": 6}]
        self.bot.handle_update(update)
        self.assertEqual(self.calls, ["message"])

    def test_args_follow_utf16_offsets(self) -> None:
        self.bot.command("say", self.record("say"))
        self.bot.handle_update(text_update(1, "/say 😀 chào ", 4))
        self.assertEqual(self.contexts[0].args, "😀 chào")

    def test_without_username_no_get_me(self) -> None:
        self.bot.command("start", self.record("start"))
        self.bot.handle_update(text_update(1, "/start", 6))
        self.assertEqual(self.api.calls("GET", "/me"), [])

    def test_callback_longest_prefix_and_reply(self) -> None:
        self.api.route("POST", "/callbacks/cb1:answer", ok())
        self.bot.callback("pick:", self.record("short"))
        self.bot.callback("pick:a", self.record("long"))
        self.bot.on("callback", self.record("other"))
        self.bot.handle_update(callback_update("pick:ab"))
        self.bot.handle_update(callback_update("pick:b"))
        self.bot.handle_update(callback_update("x"))
        self.assertEqual(self.calls, ["long", "short", "other"])
        ctx = self.contexts[0]
        ctx.answer("Đã chọn A", show_alert=True)
        ctx.reply("Bạn chọn A")
        (answer,) = self.api.calls("POST", "/callbacks/cb1:answer")
        self.assertEqual(answer.json(), {"text": "Đã chọn A", "show_alert": True})
        (sent,) = self.api.calls("POST", "/messages")
        self.assertEqual(sent.json(), {"chat_id": 77, "topic_id": 5, "text": "Bạn chọn A"})

    def test_inline_query(self) -> None:
        self.api.route("POST", "/inline/Q1:answer", ok())

        @self.bot.inline_query
        def answer(ctx: Context) -> None:
            query = ctx.inline_query
            assert query is not None
            ctx.answer_inline([{"type": "article", "id": "1", "title": query["query"].upper(),
                                "text": query["query"]}], cache_time=0)

        self.bot.handle_update({"update_id": 1, "inline_query": {  # type: ignore[typeddict-item]
            "id": "Q1", "from": {"id": 1, "is_bot": False, "name": "An"}, "query": "mèo", "offset": "",
            "chat_type": "group"}})
        (request,) = self.api.calls("POST", "/inline/Q1:answer")
        self.assertEqual(request.json(), {"results": [{"type": "article", "id": "1", "title": "MÈO", "text": "mèo"}],
                                          "cache_time": 0})

    def test_other_kinds_and_unknown_kinds(self) -> None:
        self.bot.on("reaction", self.record("reaction"))
        self.bot.handle_update({"update_id": 1, "reaction": {  # type: ignore[typeddict-item]
            "chat": {"id": 1, "type": "private"}, "seq": 2, "user": {"id": 1, "is_bot": False, "name": "An"},
            "emoji": "👍", "date": 0}})
        self.assertIsNone(self.bot.handle_update({"update_id": 2, "story": {}}))  # type: ignore[typeddict-unknown-key]
        self.assertIsNone(self.bot.handle_update(text_update(3, "no handler")))
        self.assertEqual(self.calls, ["reaction"])
        self.assertEqual(self.contexts[0].kind, "reaction")
        with self.assertRaises(RuntimeError):
            self.contexts[0].reply("x")

    def test_decorator_returns_handler_and_answer(self) -> None:
        @self.bot.command("ping")
        def ping(ctx: Context) -> Optional[WebhookAnswer]:
            assert ctx.message is not None
            return {"method": "sendMessage", "chat_id": ctx.message["chat"]["id"], "text": "pong"}

        self.assertTrue(callable(ping))
        self.assertEqual(self.bot.handle_update(text_update(1, "/ping", 5)),
                         {"method": "sendMessage", "chat_id": 42, "text": "pong"})

    def test_invalid_registrations(self) -> None:
        for name in ("", "a b", "x@bot"):
            with self.assertRaises(ValueError):
                self.bot.command(name, self.record("x"))


if __name__ == "__main__":
    unittest.main()
