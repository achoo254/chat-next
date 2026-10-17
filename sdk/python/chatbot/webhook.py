"""Receiving updates at a webhook: signature check, WSGI app and a small server."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import threading
import time
from collections import OrderedDict
from socketserver import ThreadingMixIn
from typing import Callable, Iterable, List, Mapping, Optional, Protocol, Tuple
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from ._generated import Update, WebhookAnswer

__all__ = [
    "MAX_BODY",
    "UpdateHandler",
    "serve_webhook",
    "verify_webhook",
    "webhook_app",
]

_log = logging.getLogger("chatbot")

MAX_BODY = 1 << 20
"""Largest update body accepted (1 MiB); larger ones answer 413."""

MAX_SKEW = 300
"""Seconds X-Bot-Timestamp may differ from the local clock."""

_DEDUPE_SIZE = 1000

UpdateHandler = Callable[[Update], Optional[WebhookAnswer]]
"""Handles one update; may return a WebhookAnswer for the server to run."""


class _StartResponse(Protocol):
    def __call__(self, status: str, headers: List[Tuple[str, str]], /) -> object: ...


WSGIApp = Callable[[dict[str, object], _StartResponse], Iterable[bytes]]


def verify_webhook(
    headers: Mapping[str, str],
    raw_body: bytes,
    secret: str,
    now: Optional[float] = None,
) -> bool:
    """True when a webhook request comes from the server.

    Checks that ``X-Bot-Api-Secret-Token`` equals ``secret``, that
    ``X-Bot-Signature`` is ``v1=`` + hex(HMAC-SHA256(secret, timestamp + "." +
    raw body)) and that ``X-Bot-Timestamp`` is within 5 minutes of ``now``
    (default: the current time). Header names are case-insensitive; comparisons
    run in constant time.
    """
    if not secret:
        return False
    lower = {str(k).lower(): str(v) for k, v in headers.items()}
    ts = lower.get("x-bot-timestamp", "")
    if not (ts.isascii() and ts.isdigit()):
        return False
    current = time.time() if now is None else now
    if abs(current - int(ts)) > MAX_SKEW:
        return False
    key = secret.encode("utf-8")
    want = "v1=" + hmac.new(key, ts.encode("ascii") + b"." + bytes(raw_body), hashlib.sha256).hexdigest()
    token_ok = hmac.compare_digest(lower.get("x-bot-api-secret-token", "").encode("utf-8"), key)
    signature_ok = hmac.compare_digest(lower.get("x-bot-signature", "").encode("utf-8"), want.encode("ascii"))
    return token_ok and signature_ok


class _Dedupe:
    """The update_ids handled recently, plus the ones being handled now."""

    def __init__(self, size: int = _DEDUPE_SIZE) -> None:
        self._size = size
        self._done: OrderedDict[int, None] = OrderedDict()
        self._running: set[int] = set()
        self._lock = threading.Lock()

    def begin(self, update_id: int) -> str:
        """``"new"`` (now running), ``"done"`` (handled before) or ``"running"``."""
        with self._lock:
            if update_id in self._done:
                return "done"
            if update_id in self._running:
                return "running"
            self._running.add(update_id)
            return "new"

    def finish(self, update_id: int, ok: bool) -> None:
        with self._lock:
            self._running.discard(update_id)
            if ok:
                self._done[update_id] = None
                while len(self._done) > self._size:
                    self._done.popitem(last=False)


def _request_headers(environ: Mapping[str, object]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in environ.items():
        if key.startswith("HTTP_") and isinstance(value, str):
            headers[key[5:].replace("_", "-").lower()] = value
    return headers


def webhook_app(handler: UpdateHandler, secret: str) -> WSGIApp:
    """A WSGI application receiving updates for ``handler``.

    Answers ``405`` to anything but POST, ``413`` to a body over 1 MiB,
    ``401`` (no body) when ``verify_webhook`` fails, ``400`` to a body that is
    not an update, ``200`` without running the handler for an update_id handled
    recently (the last 1000), ``200`` with the handler's WebhookAnswer as JSON,
    ``204`` when it returns None and ``500`` when it raises (the server sends
    the update again).
    """
    if not secret:
        raise ValueError("webhook secret must not be empty")
    dedupe = _Dedupe()

    def respond(start: _StartResponse, status: str, body: bytes = b"",
                extra: Optional[List[Tuple[str, str]]] = None) -> List[bytes]:
        headers = [("Content-Length", str(len(body)))]
        if body:
            headers.append(("Content-Type", "application/json"))
        headers.extend(extra or [])
        start(status, headers)
        return [body]

    def app(environ: dict[str, object], start_response: _StartResponse) -> Iterable[bytes]:
        if environ.get("REQUEST_METHOD") != "POST":
            return respond(start_response, "405 Method Not Allowed", extra=[("Allow", "POST")])
        try:
            length = int(str(environ.get("CONTENT_LENGTH") or "0"))
        except ValueError:
            return respond(start_response, "400 Bad Request")
        if length < 0:
            return respond(start_response, "400 Bad Request")
        if length > MAX_BODY:
            return respond(start_response, "413 Content Too Large")
        stream = environ.get("wsgi.input")
        read = getattr(stream, "read", None)
        raw = read(length) if (callable(read) and length) else b""
        if not isinstance(raw, bytes):
            return respond(start_response, "400 Bad Request")
        # The signature is checked on the raw bytes before any parsing.
        if not verify_webhook(_request_headers(environ), raw, secret):
            return respond(start_response, "401 Unauthorized")
        try:
            update = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return respond(start_response, "400 Bad Request")
        update_id = update.get("update_id") if isinstance(update, dict) else None
        if not isinstance(update_id, int) or isinstance(update_id, bool):
            return respond(start_response, "400 Bad Request")
        state = dedupe.begin(update_id)
        if state == "done":
            return respond(start_response, "200 OK")
        if state == "running":
            # Still being handled: ask for a later redelivery instead of losing
            # the update if the first attempt fails.
            return respond(start_response, "503 Service Unavailable", extra=[("Retry-After", "1")])
        try:
            answer = handler(update)
        except Exception:
            dedupe.finish(update_id, ok=False)
            _log.exception("webhook handler failed for update %d", update_id)
            return respond(start_response, "500 Internal Server Error")
        dedupe.finish(update_id, ok=True)
        if answer is None:
            return respond(start_response, "204 No Content")
        body = json.dumps(answer, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return respond(start_response, "200 OK", body)

    return app


class _ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class _QuietHandler(WSGIRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        _log.debug("webhook %s - %s", self.address_string(), format % args)


def serve_webhook(
    handler: UpdateHandler,
    *,
    secret: str,
    host: str = "0.0.0.0",
    port: int = 8080,
    stop: Optional[threading.Event] = None,
    on_ready: Optional[Callable[[], None]] = None,
) -> None:
    """Serves ``webhook_app(handler, secret)`` on ``host:port``, one thread per request.

    ``on_ready`` runs once the port is bound (for example to call
    ``set_webhook``). Returns when ``stop`` is set; without ``stop`` it runs
    until the process ends.
    """
    app = webhook_app(handler, secret)
    server = make_server(host, port, app, server_class=_ThreadingWSGIServer, handler_class=_QuietHandler)
    watcher: Optional[threading.Thread] = None
    try:
        if stop is not None:
            event = stop

            def shutdown_on_stop() -> None:
                event.wait()
                server.shutdown()

            watcher = threading.Thread(target=shutdown_on_stop, name="chatbot-webhook-stop", daemon=True)
            watcher.start()
        if on_ready is not None:
            on_ready()
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
