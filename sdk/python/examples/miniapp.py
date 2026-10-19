"""Mini App bot: /start sends a button that opens the shop's Mini App.

A small HTTP server is the Mini App's backend: ``POST /verify`` takes the raw
init data and answers who opened it (401 when it is not genuine). Data the
Mini App sends back arrives as ``web_app_data`` and is confirmed in the chat.
Environment (besides ``_run``): ``MINI_APP_URL`` (https, on your own domain),
``MINI_APP_PORT`` (port of the backend). Verifying needs the ``cryptography``
package: ``pip install './sdk/python[miniapp]'``.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

from _run import main

from chatbot import Bot, Client, Context, MiniAppInitData, verify_mini_app_init_data

MINI_APP_URL = os.environ.get("MINI_APP_URL", "").strip() or "https://shop.example.com/app"
_MAX_BODY = 8 * 1024
"""Init data is a short query string; anything bigger is refused unread."""

Verify = Callable[[str], Optional[MiniAppInitData]]


def verifier(client: Client, bot_id: int) -> Verify:
    """Verifies init data with the server's public key, cached; when the check
    fails the key is fetched again once, as the server may have rotated it."""
    key: Optional[str] = None

    def verify(init_data: str) -> Optional[MiniAppInitData]:
        nonlocal key
        cached = key
        if cached is not None:
            data = verify_mini_app_init_data(init_data, bot_id, cached)
            if data is not None:
                return data
        key = client.get_mini_app_key()["public_key"]
        return verify_mini_app_init_data(init_data, bot_id, key)

    return verify


def backend(verify: Verify) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 (http.server's naming)
            if self.path != "/verify":
                self.send_error(404)
                return
            length_text = self.headers.get("Content-Length", "")
            if not length_text.isdigit() or int(length_text) > _MAX_BODY:
                self.send_error(413 if length_text.isdigit() else 411)
                return
            init_data = self.rfile.read(int(length_text)).decode("utf-8", errors="replace")
            try:
                data = verify(init_data)
            except Exception:  # noqa: BLE001 (the key could not be fetched)
                logging.exception("verify")
                self.send_error(500)
                return
            if data is None:
                self.send_error(401)
                return
            body = json.dumps({"user_id": data["user"]["id"], "chat_type": data["chat_type"]}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:  # noqa: A002 (http.server's signature)
            logging.info("mini app backend: " + format, *args)

    return Handler


def setup(bot: Bot) -> None:
    port_text = os.environ.get("MINI_APP_PORT", "").strip() or "8081"
    if not port_text.isdigit() or not 0 < int(port_text) < 65536:
        sys.exit("MINI_APP_PORT must be a port number")
    bot_id = bot.client.get_me()["id"]
    server = ThreadingHTTPServer(("", int(port_text)), backend(verifier(bot.client, bot_id)))
    server.daemon_threads = True
    # A daemon thread: the bot's poll or webhook decides when the process ends.
    threading.Thread(target=server.serve_forever, daemon=True).start()

    @bot.command("start")
    def start(ctx: Context) -> None:
        ctx.reply("Mở cửa hàng để đặt món:", reply_markup={"inline_keyboard": [[
            {"text": "Mở cửa hàng", "web_app": {"url": MINI_APP_URL}},
        ]]})

    @bot.message
    def web_app_data(ctx: Context) -> None:
        sent = ctx.message.get("web_app_data") if ctx.message else None
        if sent is not None:
            ctx.reply(f"Đã nhận đơn: {sent['data']}")


if __name__ == "__main__":
    main(setup)
