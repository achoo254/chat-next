"""An in-process fake of the Bot API for the unit tests."""

from __future__ import annotations

import json
import logging
import sys
import threading
import urllib.parse
from dataclasses import dataclass, field
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Dict, List, Optional, Tuple, Union

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from chatbot import Client  # noqa: E402

# Keep the SDK's retry warnings out of the test output; assertLogs still sees them.
logging.getLogger("chatbot").addHandler(logging.NullHandler())

PREFIX = "/bot/v1"
TOKEN = "123456:secret-token-value"

DROP = object()
"""A response that closes the connection without answering."""


@dataclass
class Recorded:
    """One request the fake received."""

    method: str
    path: str
    query: Dict[str, str]
    headers: Dict[str, str]
    body: bytes

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))

    def multipart(self) -> List[EmailMessage]:
        content_type = self.headers.get("content-type", "")
        raw = b"Content-Type: " + content_type.encode("ascii") + b"\r\n\r\n" + self.body
        message = BytesParser(policy=policy.HTTP).parsebytes(raw)
        assert isinstance(message, EmailMessage)
        return list(message.iter_parts())  # type: ignore[arg-type]


def part_text(part: EmailMessage) -> str:
    """The UTF-8 text of a multipart form field."""
    payload = part.get_payload(decode=True)
    assert isinstance(payload, bytes)
    return payload.decode("utf-8")


Response = Tuple[int, Union[object, bytes], Dict[str, str]]
Responder = Union[Response, object, Callable[[Recorded], Union[Response, object]]]


def ok(result: object = True) -> Response:
    return 200, {"ok": True, "result": result}, {}


def error(status: int, code: str, description: str = "detail", retry_after: Optional[int] = None,
          headers: Optional[Dict[str, str]] = None) -> Response:
    err: Dict[str, object] = {"code": code, "description": description}
    if retry_after is not None:
        err["retry_after"] = retry_after
    return status, {"ok": False, "error": err}, dict(headers or {})


@dataclass
class FakeApi:
    """Answers scripted responses per (method, path); the last response repeats."""

    requests: List[Recorded] = field(default_factory=list)
    routes: Dict[Tuple[str, str], List[Responder]] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: object) -> None:
                pass

            def handle_any(self) -> None:
                parts = urllib.parse.urlsplit(self.path)
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                path = parts.path[len(PREFIX):] if parts.path.startswith(PREFIX) else parts.path
                query = {k: v[0] for k, v in urllib.parse.parse_qs(parts.query, keep_blank_values=True).items()}
                recorded = Recorded(self.command, path, query, {k.lower(): v for k, v in self.headers.items()}, body)
                with fake.lock:
                    fake.requests.append(recorded)
                    queue = fake.routes.get((self.command, path))
                    responder: Responder = (404, {"ok": False, "error": {"code": "not_found",
                                                                         "description": "no route"}}, {})
                    if queue:
                        responder = queue.pop(0) if len(queue) > 1 else queue[0]
                if callable(responder):
                    responder = responder(recorded)
                if responder is DROP:
                    self.close_connection = True
                    return
                assert isinstance(responder, tuple)
                status, payload, headers = responder
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                if not isinstance(payload, bytes):
                    self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = handle_any

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()

    @property
    def origin(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    @property
    def url(self) -> str:
        return self.origin + PREFIX

    def route(self, method: str, path: str, *responses: Responder) -> None:
        with self.lock:
            self.routes[(method, path)] = list(responses)

    def calls(self, method: str, path: str) -> List[Recorded]:
        with self.lock:
            return [r for r in self.requests if r.method == method and r.path == path]

    def client(self, **options: object) -> Client:
        client = Client(TOKEN, base_url=self.url, timeout=5, **options)  # type: ignore[arg-type]
        self.sleeps: List[float] = []
        client._sleep = self.sleeps.append
        return client

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
