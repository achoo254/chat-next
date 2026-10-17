"""The example bots, run as child processes against the fake API."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Callable, Dict, List, Optional

from fake_api import TOKEN, FakeApi, Recorded, Response, ok, part_text
from test_webhook import free_port, signed_headers

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
CHAT = {"id": 42, "type": "private"}
USER = {"id": 1, "is_bot": False, "name": "An"}


def command(update_id: int, text: str) -> Dict[str, object]:
    length = len(text.split()[0])
    return {"update_id": update_id, "message": {"chat": CHAT, "seq": update_id, "date": 0, "from": USER,
                                                "text": text,
                                                "entities": [{"type": "bot_command", "offset": 0, "length": length}]}}


def text(update_id: int, value: str, media: Optional[Dict[str, object]] = None) -> Dict[str, object]:
    message: Dict[str, object] = {"chat": CHAT, "seq": update_id, "date": 0, "from": USER, "text": value}
    if media is not None:
        message["media"] = media
    return {"update_id": update_id, "message": message}


class ExamplesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeApi()
        self.api.route("GET", "/me", ok({"id": 7, "is_bot": True, "name": "Bot", "username": "demo_bot",
                                         "privacy": True, "tier": "default"}))
        for method, path in (("DELETE", "/webhook"), ("PUT", "/webhook"), ("PUT", "/commands"),
                             ("POST", "/messages:edit"), ("POST", "/messages:editMarkup")):
            self.api.route(method, path, ok(True if "webhook" in path or "commands" in path else {"seq": 3}))
        self.api.route("POST", "/messages", ok({"chat": CHAT, "seq": 50, "date": 0}))
        self.process: Optional[subprocess.Popen[str]] = None

    def tearDown(self) -> None:
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            if self.process.stdout is not None:
                self.process.stdout.close()
        self.api.close()

    def serve_updates(self, *batch: Dict[str, object]) -> None:
        sent: List[bool] = []

        def responder(request: Recorded) -> Response:
            if not sent:
                sent.append(True)
                return ok(list(batch))
            time.sleep(0.2)  # A long poll with nothing pending.
            return ok([])

        self.api.route("GET", "/updates", responder)

    def start(self, name: str, **env: str) -> None:
        environment = dict(os.environ, BOT_TOKEN=TOKEN, BOT_API=self.api.url, **env)
        self.process = subprocess.Popen([sys.executable, str(EXAMPLES / f"{name}.py")], env=environment,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        assert self.process.stdout is not None
        self.assertEqual(self.process.stdout.readline(), "ready\n")

    def wait_for(self, condition: Callable[[], bool]) -> None:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.05)
        self.fail("timed out; requests: " + ", ".join(f"{r.method} {r.path}" for r in self.api.requests))

    def sent_texts(self, count: int) -> List[object]:
        self.wait_for(lambda: len(self.api.calls("POST", "/messages")) >= count)
        return [r.json()["text"] for r in self.api.calls("POST", "/messages")]  # type: ignore[index]

    def test_echo(self) -> None:
        self.serve_updates(command(1, "/start"), text(2, "Có ai không?"), command(3, "/help"))
        self.start("echo")
        self.assertEqual(len(self.api.calls("DELETE", "/webhook")), 1)
        self.assertEqual(self.sent_texts(2), ["Xin chào! Gửi gì mình nhắc lại nấy.", "Có ai không?"])
        self.wait_for(lambda: any(r.query.get("offset") == "4" for r in self.api.calls("GET", "/updates")))
        self.assertEqual(len(self.api.calls("POST", "/messages")), 2)

    def test_keyboard(self) -> None:
        self.api.route("POST", "/callbacks/cb1:answer", ok())
        press = {"update_id": 2, "callback": {"id": "cb1", "from": USER, "data": "pick:b",
                                              "message": {"chat": CHAT, "seq": 50, "date": 0, "text": "Chọn một:"}}}
        self.serve_updates(command(1, "/start"), press)
        self.start("keyboard")
        self.wait_for(lambda: bool(self.api.calls("POST", "/messages:editMarkup")))
        (shown,) = self.api.calls("POST", "/messages")
        self.assertEqual(shown.json(), {"chat_id": 42, "text": "Chọn một:", "reply_markup": {"inline_keyboard": [[
            {"text": "A", "callback_data": "pick:a"}, {"text": "B", "callback_data": "pick:b"}]]}})
        self.assertEqual(self.api.calls("POST", "/callbacks/cb1:answer")[0].json(), {"text": "Đã chọn B"})
        self.assertEqual(self.api.calls("POST", "/messages:edit")[0].json(),
                         {"chat_id": 42, "seq": 50, "text": "Bạn chọn B"})
        self.assertEqual(self.api.calls("POST", "/messages:editMarkup")[0].json(), {"chat_id": 42, "seq": 50})

    def test_files(self) -> None:
        self.api.route("POST", "/messages:sendMedia", ok({"seq": 51}))
        self.api.route("GET", "/files/F1", ok({"file_id": "F1", "kind": "document", "size": 5,
                                               "url": self.api.origin + "/dl/F1", "url_expires": 0}))
        self.api.route("GET", "/dl/F1", (200, b"12345", {}))
        media = text(2, "", {"kind": "document", "file_id": "F1", "file_name": "a.txt"})
        photo = text(3, "", {"kind": "photo", "file_id": "F1"})
        self.serve_updates(command(1, "/file"), media, photo)
        self.start("files")
        self.assertEqual(self.sent_texts(2), ["Nhận a.txt: 5 byte", "Nhận photo: 5 byte"])
        (upload,) = self.api.calls("POST", "/messages:sendMedia")
        parts = {p.get_param("name", header="content-disposition"): p for p in upload.multipart()}
        self.assertEqual(parts["kind"].get_payload(decode=True), b"document")
        self.assertEqual(part_text(parts["text"]), "Tệp mẫu")
        self.assertEqual(parts["file"].get_filename(), "hello.txt")
        self.assertEqual(parts["file"].get_payload(decode=True), "xin chào".encode())
        self.assertEqual(len("xin chào".encode()), 9)

    def test_commands(self) -> None:
        self.serve_updates(command(1, "/help"), command(2, "/start"))
        self.start("commands")
        self.assertEqual(self.api.calls("PUT", "/commands")[0].json(), {"commands": [
            {"command": "start", "description": "Bắt đầu"}, {"command": "help", "description": "Trợ giúp"}]})
        self.assertEqual(self.sent_texts(2), ["Lệnh: /start, /help", "Sẵn sàng."])

    def test_inline(self) -> None:
        self.api.route("POST", "/inline/Q1:answer", ok())
        self.serve_updates({"update_id": 1, "inline_query": {"id": "Q1", "from": USER, "query": "mèo con",
                                                             "offset": "", "chat_type": "sender"}})
        self.start("inline")
        self.wait_for(lambda: bool(self.api.calls("POST", "/inline/Q1:answer")))
        self.assertEqual(self.api.calls("POST", "/inline/Q1:answer")[0].json(), {
            "results": [{"type": "article", "id": "1", "title": "MÈO CON", "text": "mèo con"}], "cache_time": 1})

    def test_echo_webhook(self) -> None:
        port = free_port()
        self.start("echo", BOT_MODE="webhook", WEBHOOK_PORT=str(port), WEBHOOK_SECRET="s3cret",
                   WEBHOOK_URL="https://bot.example.com/hook")
        self.assertEqual(self.api.calls("PUT", "/webhook")[0].json(),
                         {"url": "https://bot.example.com/hook", "secret": "s3cret"})
        body = json.dumps(text(1, "qua webhook")).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{port}/hook", data=body, method="POST",
                                         headers=signed_headers(body, secret="s3cret"))
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)
        self.assertEqual(self.sent_texts(1), ["qua webhook"])


if __name__ == "__main__":
    unittest.main()
