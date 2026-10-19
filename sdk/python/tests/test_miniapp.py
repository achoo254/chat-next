"""verify_mini_app_init_data against init data signed by the server."""

from __future__ import annotations

import importlib.util
import unittest
from typing import Optional

import fake_api  # noqa: F401  (puts the package on sys.path)

from chatbot import verify_mini_app_init_data

# Init data signed by the server (server/internal/miniapp TestSignVector;
# docs/bot-api/README.md).
KEY = "3ktwc67vmU-jLgKZ13Lj1iN6KAk145mjNELp-vwXrcg"
INIT_DATA = (
    "auth_date=1760850000&bot_id=1234567&chat_instance=jkvivnNpwnmKUPzV&chat_type=private"
    "&signature=_Z0BDYBsfng_LKrIg5NS1OZZMzOmjLKQU9sXDmE4vYMWAzIZzX8_W_XApoETPJsVzHm-pwST8Goq1Z92Vnu0CQ"
    "&start_param=promo_1&tenant_id=primary"
    "&user=%7B%22id%22%3A7654321%2C%22first_name%22%3A%22Lan+Nguy%E1%BB%85n%22%2C%22username%22%3A%22lan%22%7D"
)
BOT_ID = 1234567
AUTH_DATE = 1760850000

HAS_CRYPTOGRAPHY = importlib.util.find_spec("cryptography") is not None


@unittest.skipUnless(HAS_CRYPTOGRAPHY, "needs the optional cryptography package (chat-bot-sdk[miniapp])")
class VerifyMiniAppInitDataTest(unittest.TestCase):
    def test_accepts_server_init_data(self) -> None:
        data = verify_mini_app_init_data(INIT_DATA, BOT_ID, KEY, now=AUTH_DATE + 60)
        assert data is not None
        self.assertEqual(data["user"], {"id": 7654321, "first_name": "Lan Nguyễn", "username": "lan"})
        self.assertEqual(data["chat_type"], "private")
        self.assertEqual(data["chat_instance"], "jkvivnNpwnmKUPzV")
        self.assertEqual(data["start_param"], "promo_1")
        self.assertEqual(data["auth_date"], AUTH_DATE)
        self.assertEqual(data["bot_id"], BOT_ID)
        self.assertEqual(data["tenant_id"], "primary")
        self.assertNotIn("signature", data["fields"])

    def test_rejects(self) -> None:
        cases: list[tuple[str, str, int, str, Optional[int], float]] = [
            ("another bot", INIT_DATA, BOT_ID + 1, KEY, None, AUTH_DATE),
            ("older than an hour", INIT_DATA, BOT_ID, KEY, None, AUTH_DATE + 3601),
            ("older than max age", INIT_DATA, BOT_ID, KEY, 60, AUTH_DATE + 120),
            ("from the future", INIT_DATA, BOT_ID, KEY, None, AUTH_DATE - 600),
            ("tampered", INIT_DATA.replace("chat_type=private", "chat_type=group"), BOT_ID, KEY, None, AUTH_DATE),
            ("field added", INIT_DATA + "&admin=1", BOT_ID, KEY, None, AUTH_DATE),
            ("field repeated", INIT_DATA + "&chat_type=private", BOT_ID, KEY, None, AUTH_DATE),
            ("another key", INIT_DATA, BOT_ID, "A" + KEY[1:], None, AUTH_DATE),
            ("bad key", INIT_DATA, BOT_ID, "short", None, AUTH_DATE),
            ("no signature", "auth_date=1760850000&bot_id=1234567", BOT_ID, KEY, None, AUTH_DATE),
        ]
        for name, init_data, bot_id, key, max_age, now in cases:
            with self.subTest(name):
                if max_age is None:
                    got = verify_mini_app_init_data(init_data, bot_id, key, now=now)
                else:
                    got = verify_mini_app_init_data(init_data, bot_id, key, max_age, now)
                self.assertIsNone(got)


@unittest.skipIf(HAS_CRYPTOGRAPHY, "cryptography is installed")
class WithoutCryptographyTest(unittest.TestCase):
    def test_clear_error(self) -> None:
        with self.assertRaisesRegex(RuntimeError, r"chat-bot-sdk\[miniapp\]"):
            verify_mini_app_init_data(INIT_DATA, BOT_ID, KEY, now=AUTH_DATE)


if __name__ == "__main__":
    unittest.main()
