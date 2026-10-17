"""HTTP client of the Bot API: transport, envelope, retries and file transfer."""

from __future__ import annotations

import http.client
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from email.message import Message as _HeaderMap
from typing import Any, Callable, List, Literal, Mapping, Optional, Sequence, Tuple, Union

from ._generated import AlbumItem, Entity, File, GeneratedMethods, Id, MediaKind, Message
from .files import InputFile

__all__ = ["ApiError", "Client", "DEFAULT_BASE_URL", "NetworkError"]

DEFAULT_BASE_URL = "https://chat.hoandat.com/bot/v1"
"""Base URL used when none is given."""

_log = logging.getLogger("chatbot")

_RETRYABLE = {(429, "rate_limited"), (503, "unavailable")}


class ApiError(Exception):
    """An answer with ``ok: false`` (or a non-envelope HTTP error).

    Branch on ``code`` (stable), never on ``description`` (human-readable).
    ``retry_after`` is in seconds, 0 when the server gave none.
    """

    def __init__(self, status: int, code: str, description: str, retry_after: int = 0) -> None:
        super().__init__(f"{status} {code}: {description}")
        self.status = status
        self.code = code
        self.description = description
        self.retry_after = retry_after


class NetworkError(Exception):
    """The request did not get an HTTP answer (connection, TLS, timeout, broken body)."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuses redirects so the bot token is never sent to another URL."""

    def redirect_request(self, req: urllib.request.Request, fp: Any, code: int, msg: str,
                         headers: _HeaderMap, newurl: str) -> None:
        return None


def _check_http_url(url: str, what: str) -> None:
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"{what} must be an http or https URL")


def _query_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _header_int(headers: Optional[_HeaderMap], name: str) -> int:
    if headers is None:
        return 0
    raw = headers.get(name)
    if raw is None:
        return 0
    try:
        return max(0, int(str(raw).strip()))
    except ValueError:
        return 0  # An HTTP date is not used by this API; ignore it.


class Client(GeneratedMethods):
    """Bot API client: every API method plus uploads and downloads.

    ``Client(token)`` talks to ``DEFAULT_BASE_URL``; ``base_url`` points it at
    another tenant. ``timeout`` is per request in seconds (a long poll adds its
    own ``timeout``). ``retries`` is how many times a ``429 rate_limited`` or
    ``503 unavailable`` answer, or a network error of a ``GET``, is retried
    before the error is raised.
    """

    def __init__(
        self,
        token: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 60.0,
        retries: int = 3,
    ) -> None:
        if not isinstance(token, str) or not token or any(c in token for c in "\r\n "):
            raise ValueError("token must be a non-empty string without spaces or line breaks")
        _check_http_url(base_url, "base_url")
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        if retries < 0:
            raise ValueError("retries must be zero or more")
        self._token = token
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self.retries = int(retries)
        self._api_opener = urllib.request.build_opener(_NoRedirect())
        self._download_opener = urllib.request.build_opener()
        self._sleep: Callable[[float], None] = time.sleep

    def __repr__(self) -> str:
        return f"Client(base_url={self.base_url!r})"

    # Transport -----------------------------------------------------------

    def _call(
        self,
        method: str,
        path: str,
        *,
        query: Optional[dict[str, Any]] = None,
        body: Optional[dict[str, Any]] = None,
    ) -> Any:
        """Sends one API request and returns the envelope's ``result``."""
        data: Optional[bytes] = None
        headers = {"Accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        timeout = self.timeout
        if query and isinstance(query.get("timeout"), int):
            timeout += query["timeout"]
        return self._api(method, path, query, data, headers, timeout)

    def _api(
        self,
        method: str,
        path: str,
        query: Optional[Mapping[str, object]],
        data: Optional[bytes],
        headers: dict[str, str],
        timeout: float,
    ) -> Any:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode({k: _query_value(v) for k, v in query.items()})
        headers = dict(headers)
        headers["Authorization"] = "Bearer " + self._token
        # A request with a body may already have run when the network fails,
        # so only GET is retried after a network error.
        network_retry = method == "GET"
        attempt = 0
        while True:
            try:
                status, answer_headers, raw = self._send(
                    self._api_opener, method, url, data, headers, timeout)
            except NetworkError:
                if network_retry and attempt < self.retries:
                    attempt += 1
                    _log.warning("%s %s: network error, retrying in 1 s", method, path)
                    self._sleep(1.0)
                    continue
                raise
            try:
                return self._envelope(status, answer_headers, raw)
            except ApiError as err:
                if (err.status, err.code) in _RETRYABLE and attempt < self.retries:
                    attempt += 1
                    wait = err.retry_after or 1
                    _log.warning("%s %s: %s %s, retrying in %d s", method, path, err.status, err.code, wait)
                    self._sleep(float(wait))
                    continue
                raise

    @staticmethod
    def _send(
        opener: urllib.request.OpenerDirector,
        method: str,
        url: str,
        data: Optional[bytes],
        headers: Mapping[str, str],
        timeout: float,
    ) -> Tuple[int, Optional[_HeaderMap], bytes]:
        request = urllib.request.Request(url, data=data, headers=dict(headers), method=method)
        try:
            with opener.open(request, timeout=timeout) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as err:
            try:
                raw = err.read()
            except (OSError, http.client.HTTPException):
                raw = b""
            finally:
                err.close()
            return err.code, err.headers, raw
        except urllib.error.URLError as err:
            raise NetworkError(f"{method} request failed: {err.reason}") from err
        except (OSError, http.client.HTTPException) as err:
            raise NetworkError(f"{method} request failed: {type(err).__name__}: {err}") from err

    @staticmethod
    def _envelope(status: int, headers: Optional[_HeaderMap], raw: bytes) -> Any:
        try:
            envelope = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, ValueError):
            envelope = None
        if not isinstance(envelope, dict) or not isinstance(envelope.get("ok"), bool):
            raise ApiError(status, "invalid_response", f"HTTP {status} without a Bot API envelope",
                           _header_int(headers, "Retry-After"))
        if envelope["ok"]:
            if status >= 300:
                raise ApiError(status, "invalid_response", f"HTTP {status} with ok: true")
            return envelope.get("result")
        error = envelope.get("error")
        if not isinstance(error, dict):
            error = {}
        code = error.get("code")
        description = error.get("description")
        retry_after = error.get("retry_after")
        if not isinstance(retry_after, int) or isinstance(retry_after, bool) or retry_after < 0:
            retry_after = _header_int(headers, "Retry-After")
        return_code = code if isinstance(code, str) and code else "unknown"
        return_description = description if isinstance(description, str) else ""
        raise ApiError(status, return_code, return_description, retry_after)

    # Files -----------------------------------------------------------------

    def send_media_upload(
        self,
        *,
        chat_id: Id,
        kind: MediaKind,
        file: InputFile,
        topic_id: Optional[Id] = None,
        text: Optional[str] = None,
        entities: Optional[List[Entity]] = None,
        parse_mode: Optional[Literal["markdown", "html"]] = None,
        reply_to_seq: Optional[Id] = None,
        random_id: Optional[int] = None,
    ) -> Message:
        """Uploads one file and sends it as a photo, video, audio, voice message or document.

        ``multipart/form-data``: the file in the part ``file`` (its name becomes
        ``file_name``), ``entities`` as a JSON string, the rest as form fields.
        ``text`` is the caption.
        """
        if not isinstance(file, InputFile):
            raise TypeError("file must be an InputFile")
        fields = _form_fields({
            "chat_id": chat_id,
            "topic_id": topic_id,
            "kind": kind,
            "text": text,
            "entities": entities,
            "parse_mode": parse_mode,
            "reply_to_seq": reply_to_seq,
            "random_id": random_id,
        })
        result: Message = self._upload("/messages:sendMedia", fields, [("file", file)])
        return result

    def send_album_upload(
        self,
        *,
        chat_id: Id,
        items: Sequence[AlbumItem],
        files: Mapping[str, InputFile],
        topic_id: Optional[Id] = None,
        reply_to_seq: Optional[Id] = None,
    ) -> List[Message]:
        """Uploads 2 to 10 files and sends them as one album.

        Each item names either a ``file_id`` or, with ``attach``, the key in
        ``files`` holding its upload; each file goes in a part of that name and
        ``items`` is sent as a JSON string.
        """
        attached = [item["attach"] for item in items if item.get("attach")]
        for name in attached:
            if name not in files:
                raise ValueError(f"album item attaches {name!r} but files has no such entry")
        reserved = {"chat_id", "topic_id", "reply_to_seq", "items"}
        for name, value in files.items():
            if name in reserved:
                raise ValueError(f"{name!r} is a form field and cannot name a file part")
            if name not in attached:
                raise ValueError(f"file {name!r} is not attached by any album item")
            if not isinstance(value, InputFile):
                raise TypeError(f"files[{name!r}] must be an InputFile")
        fields = _form_fields({
            "chat_id": chat_id,
            "topic_id": topic_id,
            "reply_to_seq": reply_to_seq,
            "items": list(items),
        })
        result: List[Message] = self._upload("/messages:sendAlbum", fields, list(files.items()))
        return result

    def _upload(self, path: str, fields: List[Tuple[str, str]], files: List[Tuple[str, InputFile]]) -> Any:
        body, content_type = _multipart(fields, files)
        headers = {"Accept": "application/json", "Content-Type": content_type}
        return self._api("POST", path, None, body, headers, self.timeout)

    def download_file(self, file: Union[File, str]) -> bytes:
        """Downloads a file by its ``File.url`` (from ``get_file``) and returns its bytes.

        The URL is signed, so no token is sent. A network error is retried like a ``GET``.
        """
        url = file if isinstance(file, str) else file["url"]
        _check_http_url(url, "file url")
        attempt = 0
        while True:
            try:
                status, _, raw = self._send(self._download_opener, "GET", url, None, {}, self.timeout)
            except NetworkError:
                if attempt < self.retries:
                    attempt += 1
                    self._sleep(1.0)
                    continue
                raise
            if 200 <= status < 300:
                return raw
            raise ApiError(status, "download_failed", f"file download answered HTTP {status}")


def _form_fields(values: Mapping[str, object]) -> List[Tuple[str, str]]:
    """Form fields of a multipart request: numbers as decimals, lists as JSON, None left out."""
    fields: List[Tuple[str, str]] = []
    for name, value in values.items():
        if value is None:
            continue
        if isinstance(value, str):
            fields.append((name, value))
        elif isinstance(value, bool):
            fields.append((name, "true" if value else "false"))
        elif isinstance(value, int):
            fields.append((name, str(value)))
        else:
            fields.append((name, json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
    return fields


def _part_name(name: str) -> str:
    if not name or any(c in name for c in '"\\\r\n\0'):
        raise ValueError(f"invalid multipart part name {name!r}")
    return name


def _filename_param(name: str) -> str:
    """Content-Disposition ``filename`` as RFC 7578 and browsers send it: UTF-8, quoted."""
    escaped = name.replace("\\", "\\\\").replace('"', '\\"')
    return f'filename="{escaped}"'


def _multipart(fields: List[Tuple[str, str]], files: List[Tuple[str, InputFile]]) -> Tuple[bytes, str]:
    """Encodes a ``multipart/form-data`` body; returns it and its Content-Type."""
    boundary = "chatbot-" + uuid.uuid4().hex
    chunks: List[bytes] = []
    for name, value in fields:
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{_part_name(name)}"\r\n\r\n'.encode("utf-8"))
        chunks.append(value.encode("utf-8"))
        chunks.append(b"\r\n")
    for name, input_file in files:
        head = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{_part_name(name)}"; {_filename_param(input_file.name)}\r\n'
            f"Content-Type: {input_file.content_type}\r\n\r\n"
        )
        chunks.append(head.encode("utf-8"))
        chunks.append(input_file.read())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode("ascii"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"
