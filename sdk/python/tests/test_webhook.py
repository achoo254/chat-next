"""verify_webhook, the WSGI webhook app and serve_webhook."""

from __future__ import annotations

import hashlib
import hmac
import io
import json
import socket
import threading
import time
import unittest
import urllib.error
import urllib.request
from typing import Dict, List, Optional, Tuple
from wsgiref.util import setup_testing_defaults

import fake_api  # noqa: F401  (puts the package on sys.path)

from chatbot import MAX_BODY, Update, WebhookAnswer, serve_webhook, verify_webhook, webhook_app

SECRET = "my_secret"


def signed_headers(body: bytes, secret: str = SECRET, ts: Optional[int] = None,
                   token: Optional[str] = None) -> Dict[str, str]:
    stamp = str(int(time.time()) if ts is None else ts)
    signature = "v1=" + hmac.new(secret.encode(), stamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return {
        "X-Bot-Api-Secret-Token": secret if token is None else token,
        "X-Bot-Timestamp": stamp,
        "X-Bot-Signature": signature,
    }


class VerifyWebhookTest(unittest.TestCase):
    body = b'{"update_id":1}'
    vector = {
        "X-Bot-Api-Secret-Token": "my_secret",
        "X-Bot-Timestamp": "1760500000",
        "X-Bot-Signature": "v1=12ce7a96902e36f654800624244c841b5b6ce24b50f42f876fa551d508a6e8e1",
    }

    def test_documented_vector(self) -> None:
        self.assertTrue(verify_webhook(self.vector, self.body, "my_secret", now=1760500000))

    def test_header_names_are_case_insensitive(self) -> None:
        lower = {k.lower(): v for k, v in self.vector.items()}
        self.assertTrue(verify_webhook(lower, self.body, "my_secret", now=1760500000))

    def test_wrong_secret(self) -> None:
        self.assertFalse(verify_webhook(self.vector, self.body, "other_secret", now=1760500000))
        wrong_token = dict(self.vector, **{"X-Bot-Api-Secret-Token": "other_secret"})
        self.assertFalse(verify_webhook(wrong_token, self.body, "my_secret", now=1760500000))

    def test_wrong_signature(self) -> None:
        self.assertFalse(verify_webhook(self.vector, b'{"update_id":2}', "my_secret", now=1760500000))
        bad = dict(self.vector, **{"X-Bot-Signature": "v1=" + "0" * 64})
        self.assertFalse(verify_webhook(bad, self.body, "my_secret", now=1760500000))
        self.assertFalse(verify_webhook({k: v for k, v in self.vector.items() if k != "X-Bot-Signature"},
                                        self.body, "my_secret", now=1760500000))

    def test_clock_skew(self) -> None:
        self.assertTrue(verify_webhook(self.vector, self.body, "my_secret", now=1760500000 + 300))
        self.assertTrue(verify_webhook(self.vector, self.body, "my_secret", now=1760500000 - 300))
        self.assertFalse(verify_webhook(self.vector, self.body, "my_secret", now=1760500000 + 301))
        self.assertFalse(verify_webhook(self.vector, self.body, "my_secret", now=1760500000 - 301))

    def test_malformed_timestamp(self) -> None:
        for ts in ("", "-1", "1760500000.0", "١٧٦٠٥٠٠٠٠٠"):
            headers = dict(self.vector, **{"X-Bot-Timestamp": ts})
            self.assertFalse(verify_webhook(headers, self.body, "my_secret", now=1760500000), ts)

    def test_non_ascii_header_is_false_not_an_error(self) -> None:
        headers = dict(self.vector, **{"X-Bot-Api-Secret-Token": "bí mật"})
        self.assertFalse(verify_webhook(headers, self.body, "my_secret", now=1760500000))

    def test_empty_secret_never_verifies(self) -> None:
        headers = signed_headers(self.body, secret="", token="")
        self.assertFalse(verify_webhook(headers, self.body, ""))


class Recorder:
    """An update handler that records calls and answers as scripted."""

    def __init__(self, answer: Optional[WebhookAnswer] = None, fail: int = 0) -> None:
        self.updates: List[Update] = []
        self.answer = answer
        self.fail = fail

    def __call__(self, update: Update) -> Optional[WebhookAnswer]:
        self.updates.append(update)
        if self.fail > 0:
            self.fail -= 1
            raise RuntimeError("handler failed")
        return self.answer


def call_app(app: object, body: bytes, headers: Dict[str, str], method: str = "POST",
             content_length: Optional[str] = None) -> Tuple[int, Dict[str, str], bytes]:
    environ: Dict[str, object] = {
        "REQUEST_METHOD": method,
        "CONTENT_LENGTH": str(len(body)) if content_length is None else content_length,
        "CONTENT_TYPE": "application/json",
        "wsgi.input": io.BytesIO(body),
    }
    for name, value in headers.items():
        environ["HTTP_" + name.upper().replace("-", "_")] = value
    setup_testing_defaults(environ)  # type: ignore[arg-type]
    captured: Dict[str, object] = {}

    def start_response(status: str, response_headers: List[Tuple[str, str]]) -> None:
        captured["status"] = int(status.split()[0])
        captured["headers"] = dict(response_headers)

    chunks = app(environ, start_response)  # type: ignore[operator]
    return captured["status"], captured["headers"], b"".join(chunks)  # type: ignore[return-value]


def update_body(update_id: int) -> bytes:
    return json.dumps({"update_id": update_id, "message": {"chat": {"id": 42, "type": "private"},
                                                           "seq": 1, "date": 0, "text": "hi"}}).encode()


class WebhookAppTest(unittest.TestCase):
    def post(self, app: object, body: bytes, **kwargs: str) -> Tuple[int, Dict[str, str], bytes]:
        return call_app(app, body, signed_headers(body), **kwargs)

    def test_bad_signature_is_401_without_body(self) -> None:
        handler = Recorder()
        app = webhook_app(handler, SECRET)
        body = update_body(1)
        status, _, payload = call_app(app, body, signed_headers(body, secret="wrong", token=SECRET))
        self.assertEqual((status, payload), (401, b""))
        status, _, payload = call_app(app, body, signed_headers(body, ts=int(time.time()) - 600))
        self.assertEqual((status, payload), (401, b""))
        self.assertEqual(handler.updates, [])

    def test_signature_is_checked_before_parsing(self) -> None:
        app = webhook_app(Recorder(), SECRET)
        status, _, _ = call_app(app, b"not json", {"X-Bot-Api-Secret-Token": SECRET})
        self.assertEqual(status, 401)
        status, _, _ = self.post(app, b"not json")
        self.assertEqual(status, 400)

    def test_only_post(self) -> None:
        status, headers, _ = call_app(webhook_app(Recorder(), SECRET), b"", {}, method="GET")
        self.assertEqual((status, headers.get("Allow")), (405, "POST"))

    def test_body_over_1_mib_is_413(self) -> None:
        handler = Recorder()
        status, _, _ = call_app(webhook_app(handler, SECRET), b"", {}, content_length=str(MAX_BODY + 1))
        self.assertEqual(status, 413)
        self.assertEqual(handler.updates, [])

    def test_no_answer_is_204(self) -> None:
        handler = Recorder()
        status, _, payload = self.post(webhook_app(handler, SECRET), update_body(1))
        self.assertEqual((status, payload), (204, b""))
        self.assertEqual([u["update_id"] for u in handler.updates], [1])

    def test_answer_is_200_with_json(self) -> None:
        answer: WebhookAnswer = {"method": "sendMessage", "chat_id": 42, "text": "Đã nhận"}
        status, headers, payload = self.post(webhook_app(Recorder(answer), SECRET), update_body(1))
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(json.loads(payload), answer)

    def test_duplicate_update_is_200_without_running_again(self) -> None:
        handler = Recorder({"method": "sendMessage", "chat_id": 42, "text": "x"})
        app = webhook_app(handler, SECRET)
        self.assertEqual(self.post(app, update_body(5))[0], 200)
        status, _, payload = self.post(app, update_body(5))
        self.assertEqual((status, payload), (200, b""))
        self.assertEqual(len(handler.updates), 1)

    def test_handler_error_is_500_and_redelivery_runs_again(self) -> None:
        handler = Recorder(fail=1)
        app = webhook_app(handler, SECRET)
        with self.assertLogs("chatbot", "ERROR"):
            self.assertEqual(self.post(app, update_body(7))[0], 500)
        self.assertEqual(self.post(app, update_body(7))[0], 204)
        self.assertEqual(len(handler.updates), 2)

    def test_keeps_the_last_1000_update_ids(self) -> None:
        handler = Recorder()
        app = webhook_app(handler, SECRET)
        for update_id in range(1, 1002):
            self.post(app, json.dumps({"update_id": update_id}).encode())
        self.post(app, json.dumps({"update_id": 1001}).encode())  # still remembered
        self.post(app, json.dumps({"update_id": 1}).encode())  # forgotten: runs again
        self.assertEqual(len(handler.updates), 1002)
        self.assertEqual(handler.updates[-1]["update_id"], 1)

    def test_not_an_update_is_400(self) -> None:
        app = webhook_app(Recorder(), SECRET)
        for body in (b"[1]", b'{"update_id": "1"}', b"\xff"):
            self.assertEqual(self.post(app, body)[0], 400, body)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class ServeWebhookTest(unittest.TestCase):
    def test_serves_over_http_until_stopped(self) -> None:
        port = free_port()
        stop, ready = threading.Event(), threading.Event()
        handler = Recorder({"method": "answerCallback", "callback_id": "c1", "text": "ok"})
        thread = threading.Thread(target=serve_webhook, args=(handler,), kwargs={
            "secret": SECRET, "host": "127.0.0.1", "port": port, "stop": stop, "on_ready": ready.set})
        thread.start()
        try:
            self.assertTrue(ready.wait(5))
            body = update_body(3)
            request = urllib.request.Request(f"http://127.0.0.1:{port}/hook", data=body,
                                             headers=signed_headers(body), method="POST")
            with urllib.request.urlopen(request, timeout=5) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read())["callback_id"], "c1")
            bad = urllib.request.Request(f"http://127.0.0.1:{port}/hook", data=body, method="POST")
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(bad, timeout=5)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
        finally:
            stop.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(len(handler.updates), 1)


if __name__ == "__main__":
    unittest.main()
