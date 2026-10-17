"""Shared runner of the example bots.

Environment: ``BOT_TOKEN`` (required), ``BOT_API`` (base URL), ``BOT_MODE``
(``poll``, the default, or ``webhook``); for ``webhook`` also ``WEBHOOK_PORT``,
``WEBHOOK_SECRET`` and ``WEBHOOK_URL`` (the public URL given to
``set_webhook``). Prints exactly one line ``ready`` on stdout once updates can
be received; logs go to stderr.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Callable

# Run from a checkout without installing: make ``chatbot`` importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chatbot import DEFAULT_BASE_URL, Bot, Client  # noqa: E402


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"{name} is required")
    return value


def _ready() -> None:
    print("ready", flush=True)


def main(setup: Callable[[Bot], None]) -> None:
    """Builds the bot with ``setup`` and receives updates as the environment says."""
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    client = Client(_env("BOT_TOKEN"), base_url=os.environ.get("BOT_API", "").strip() or DEFAULT_BASE_URL)
    bot = Bot(client)
    mode = os.environ.get("BOT_MODE", "").strip() or "poll"
    try:
        if mode == "poll":
            setup(bot)
            client.delete_webhook()
            _ready()
            bot.run_polling()
        elif mode == "webhook":
            port_text = _env("WEBHOOK_PORT")
            if not port_text.isdigit() or not 0 < int(port_text) < 65536:
                sys.exit("WEBHOOK_PORT must be a port number")
            secret = _env("WEBHOOK_SECRET")
            url = _env("WEBHOOK_URL")
            setup(bot)

            def on_ready() -> None:
                client.set_webhook(url=url, secret=secret)
                _ready()

            bot.serve_webhook(secret=secret, port=int(port_text), on_ready=on_ready)
        else:
            sys.exit("BOT_MODE must be poll or webhook")
    except KeyboardInterrupt:
        pass
