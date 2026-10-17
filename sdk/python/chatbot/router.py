"""Routing updates to handlers: commands, button presses, inline queries and other kinds."""

from __future__ import annotations

import logging
import threading
from typing import Callable, List, Literal, Optional, Sequence, Tuple, TypeVar, overload

from ._generated import (
    Callback,
    Entity,
    Id,
    InlineQuery,
    InlineQueryResult,
    Message,
    ReplyMarkup,
    Update,
    UpdateKind,
    WebhookAnswer,
)
from .client import Client
from .polling import run_polling
from .webhook import WSGIApp, serve_webhook, webhook_app

__all__ = ["Bot", "Context", "Handler"]

_log = logging.getLogger("chatbot")

_KINDS: Tuple[str, ...] = (
    "message", "message_edited", "channel_post", "callback", "member_changed", "reaction", "inline_query",
)

Handler = Callable[["Context"], Optional[WebhookAnswer]]
"""A handler gets the Context of one update and may return a WebhookAnswer."""

_H = TypeVar("_H", bound=Handler)


def _utf16_slice(text: str, start: int, end: Optional[int] = None) -> str:
    """``text`` cut at UTF-16 code unit offsets (entity offsets count UTF-16)."""
    raw = text.encode("utf-16-le")
    piece = raw[start * 2:] if end is None else raw[start * 2:end * 2]
    return piece.decode("utf-16-le", errors="ignore")


def _parse_command(message: Message) -> Optional[Tuple[str, Optional[str], str]]:
    """(name, addressed username or None, args) when the message starts with a command."""
    text = message.get("text") or ""
    for entity in message.get("entities") or []:
        if entity.get("type") == "bot_command" and entity.get("offset") == 0:
            length = entity.get("length", 0)
            token = _utf16_slice(text, 0, length)
            if not token.startswith("/") or len(token) < 2:
                return None
            name, _, username = token[1:].partition("@")
            args = _utf16_slice(text, length).strip()
            return name.lower(), (username or None), args
    return None


class Context:
    """What a handler gets: the update, the client and shortcuts to answer it.

    ``kind`` is the update kind; ``message`` is the message of a message-like
    update or the message holding the pressed button; ``callback`` and
    ``inline_query`` are set for those kinds. For a message starting with a
    command, ``command`` is its lowercase name (without ``/`` and ``@username``)
    and ``args`` the rest of the text, trimmed.
    """

    def __init__(self, bot: "Bot", update: Update, kind: str) -> None:
        self.bot = bot
        self.client: Client = bot.client
        self.update = update
        self.kind = kind
        self.callback: Optional[Callback] = update.get("callback")
        self.inline_query: Optional[InlineQuery] = update.get("inline_query")
        message: Optional[Message] = None
        if kind == "message":
            message = update.get("message")
        elif kind == "message_edited":
            message = update.get("message_edited")
        elif kind == "channel_post":
            message = update.get("channel_post")
        elif self.callback is not None:
            message = self.callback.get("message")
        self.message = message
        self.command: Optional[str] = None
        self.args = ""
        if kind == "message" and message is not None:
            parsed = _parse_command(message)
            if parsed is not None:
                self.command, _, self.args = parsed

    def reply(
        self,
        text: str,
        *,
        topic_id: Optional[Id] = None,
        entities: Optional[List[Entity]] = None,
        parse_mode: Optional[Literal["markdown", "html"]] = None,
        reply_to_seq: Optional[Id] = None,
        reply_markup: Optional[ReplyMarkup] = None,
        random_id: Optional[int] = None,
        disable_link_preview: Optional[bool] = None,
    ) -> Message:
        """Sends ``text`` into the chat of this message (or of the message with the pressed button).

        In a forum the reply goes to the message's topic unless ``topic_id`` is given.
        """
        message = self.message
        if message is None:
            raise RuntimeError(f"reply needs a message or callback update, not {self.kind!r}")
        if topic_id is None:
            topic_id = message.get("topic_id")
        return self.client.send_message(
            chat_id=message["chat"]["id"],
            text=text,
            topic_id=topic_id,
            entities=entities,
            parse_mode=parse_mode,
            reply_to_seq=reply_to_seq,
            reply_markup=reply_markup,
            random_id=random_id,
            disable_link_preview=disable_link_preview,
        )

    def answer(self, text: Optional[str] = None, show_alert: Optional[bool] = None) -> None:
        """Answers the pressed button (a toast with ``text``, or a dialog with ``show_alert``)."""
        if self.callback is None:
            raise RuntimeError(f"answer needs a callback update, not {self.kind!r}")
        self.client.answer_callback(self.callback["id"], text=text, show_alert=show_alert)

    def answer_inline(
        self,
        results: List[InlineQueryResult],
        *,
        cache_time: Optional[int] = None,
        is_personal: Optional[bool] = None,
        next_offset: Optional[str] = None,
        gallery: Optional[bool] = None,
    ) -> None:
        """Answers the inline query with ``results``."""
        if self.inline_query is None:
            raise RuntimeError(f"answer_inline needs an inline_query update, not {self.kind!r}")
        self.client.answer_inline_query(
            self.inline_query["id"],
            results=results,
            cache_time=cache_time,
            is_personal=is_personal,
            next_offset=next_offset,
            gallery=gallery,
        )


class Bot:
    """Routes updates, from a long poll or a webhook alike, to handlers.

    Register handlers with the methods or as decorators::

        bot = Bot(Client(token))

        @bot.command("start")
        def start(ctx: Context) -> None:
            ctx.reply("Hi")

    Order for a message: a matching ``command``, else the ``message`` handler.
    For a callback: the ``callback`` with the longest matching prefix, else
    ``on("callback")``. Other kinds go to ``on(kind)`` (``inline_query`` is
    ``on("inline_query")``). Kinds without a handler, and unknown kinds, are
    ignored.
    """

    def __init__(self, client: Client) -> None:
        self.client = client
        self._commands: dict[str, Handler] = {}
        self._callbacks: List[Tuple[str, Handler]] = []
        self._kinds: dict[str, Handler] = {}
        self._username: Optional[str] = None
        self._me_loaded = False
        self._me_lock = threading.Lock()

    # Registration ------------------------------------------------------------

    @overload
    def command(self, name: str) -> Callable[[_H], _H]: ...
    @overload
    def command(self, name: str, handler: _H) -> _H: ...

    def command(self, name: str, handler: Optional[_H] = None) -> object:
        """Handles ``/name`` (also ``/name@username`` of this bot); ``ctx.args`` is the rest."""
        key = name.lstrip("/").lower()
        if not key or "@" in key or any(c.isspace() for c in key):
            raise ValueError(f"invalid command name {name!r}")

        def register(h: _H) -> _H:
            self._commands[key] = h
            return h

        return register if handler is None else register(handler)

    @overload
    def callback(self, prefix: str) -> Callable[[_H], _H]: ...
    @overload
    def callback(self, prefix: str, handler: _H) -> _H: ...

    def callback(self, prefix: str, handler: Optional[_H] = None) -> object:
        """Handles button presses whose ``callback.data`` starts with ``prefix`` (the longest prefix wins)."""

        def register(h: _H) -> _H:
            self._callbacks = [(p, f) for p, f in self._callbacks if p != prefix]
            self._callbacks.append((prefix, h))
            self._callbacks.sort(key=lambda item: len(item[0]), reverse=True)
            return h

        return register if handler is None else register(handler)

    @overload
    def on(self, kind: str) -> Callable[[_H], _H]: ...
    @overload
    def on(self, kind: str, handler: _H) -> _H: ...

    def on(self, kind: str, handler: Optional[_H] = None) -> object:
        """Handles updates of ``kind`` (``message_edited``, ``channel_post``, ``member_changed``, ``reaction``, …)."""
        if not kind or kind == "update_id":
            raise ValueError(f"invalid update kind {kind!r}")

        def register(h: _H) -> _H:
            self._kinds[kind] = h
            return h

        return register if handler is None else register(handler)

    @overload
    def message(self) -> Callable[[_H], _H]: ...
    @overload
    def message(self, handler: _H) -> _H: ...

    def message(self, handler: Optional[_H] = None) -> object:
        """Handles every message that no ``command`` matched."""
        return self.on("message") if handler is None else self.on("message", handler)

    @overload
    def inline_query(self) -> Callable[[_H], _H]: ...
    @overload
    def inline_query(self, handler: _H) -> _H: ...

    def inline_query(self, handler: Optional[_H] = None) -> object:
        """Handles inline queries (answer with ``ctx.answer_inline``)."""
        return self.on("inline_query") if handler is None else self.on("inline_query", handler)

    # Dispatch ------------------------------------------------------------------

    @property
    def username(self) -> Optional[str]:
        """The bot's username, read with ``get_me`` once (None when it has none)."""
        with self._me_lock:
            if not self._me_loaded:
                me = self.client.get_me()
                self._username = me.get("username")
                self._me_loaded = True
            return self._username

    def handle_update(self, update: Update) -> Optional[WebhookAnswer]:
        """Runs the handler of one update and returns its WebhookAnswer, if any.

        Handler errors propagate (a webhook answers 500, a long poll logs them).
        """
        kind = next((k for k in _KINDS if k in update), None)
        if kind is None:
            _log.debug("ignoring update %s of an unknown kind", update.get("update_id"))
            return None
        handler = self._route(kind, update)
        if handler is None:
            return None
        return handler(Context(self, update, kind))

    def _route(self, kind: str, update: Update) -> Optional[Handler]:
        if kind == "message" and self._commands:
            message = update.get("message")
            parsed = _parse_command(message) if message is not None else None
            if parsed is not None:
                name, username, _ = parsed
                handler = self._commands.get(name)
                if handler is not None and self._addressed_to_me(username):
                    return handler
        if kind == "callback":
            callback = update.get("callback")
            data = callback.get("data", "") if callback is not None else ""
            for prefix, handler in self._callbacks:
                if data.startswith(prefix):
                    return handler
        return self._kinds.get(kind)

    def _addressed_to_me(self, username: Optional[str]) -> bool:
        if username is None:
            return True
        mine = self.username
        return mine is not None and mine.lower() == username.lower()

    # Running -------------------------------------------------------------------

    def run_polling(
        self,
        *,
        stop: Optional[threading.Event] = None,
        timeout: int = 50,
        allowed_updates: Optional[Sequence[UpdateKind]] = None,
    ) -> None:
        """Receives updates by long poll until ``stop`` is set (see ``chatbot.run_polling``)."""
        run_polling(self.client, self.handle_update, stop=stop, timeout=timeout, allowed_updates=allowed_updates)

    def wsgi_app(self, secret: str) -> WSGIApp:
        """A WSGI application receiving this bot's webhook (see ``chatbot.webhook_app``)."""
        return webhook_app(self.handle_update, secret)

    def serve_webhook(
        self,
        *,
        secret: str,
        host: str = "0.0.0.0",
        port: int = 8080,
        stop: Optional[threading.Event] = None,
        on_ready: Optional[Callable[[], None]] = None,
    ) -> None:
        """Serves this bot's webhook on ``host:port`` (see ``chatbot.serve_webhook``)."""
        serve_webhook(self.handle_update, secret=secret, host=host, port=port, stop=stop, on_ready=on_ready)
