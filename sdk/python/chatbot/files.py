"""Files to upload with ``Client.send_media_upload`` and ``Client.send_album_upload``."""

from __future__ import annotations

import mimetypes
from typing import BinaryIO, Optional, Union

__all__ = ["InputFile"]


class InputFile:
    """A file to upload: its name and its bytes.

    ``data`` is ``bytes`` or a file opened in binary mode; an open file is read
    once, on the first upload, and the bytes are kept so a retried request sends
    the same content. The name becomes the message's ``file_name``.
    ``content_type`` defaults to a guess from the name.
    """

    __slots__ = ("name", "content_type", "_data", "_stream")

    def __init__(
        self,
        name: str,
        data: Union[bytes, bytearray, memoryview, BinaryIO],
        content_type: Optional[str] = None,
    ) -> None:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("InputFile needs a non-empty file name")
        if any(c in name for c in "\r\n\0"):
            raise ValueError("InputFile name must not contain line breaks or NUL")
        if content_type is not None and any(c in content_type for c in "\r\n\0"):
            raise ValueError("InputFile content_type must not contain line breaks or NUL")
        self.name = name
        self.content_type = content_type or mimetypes.guess_type(name)[0] or "application/octet-stream"
        self._data: Optional[bytes]
        self._stream: Optional[BinaryIO]
        if isinstance(data, (bytes, bytearray, memoryview)):
            self._data = bytes(data)
            self._stream = None
        elif hasattr(data, "read"):
            self._data = None
            self._stream = data
        else:
            raise TypeError("InputFile data must be bytes or a binary file object")

    def read(self) -> bytes:
        """The file's bytes (reads an open file once)."""
        if self._data is None:
            stream = self._stream
            if stream is None:  # pragma: no cover - one of the two is always set
                raise RuntimeError("InputFile has no data")
            raw = stream.read()
            if not isinstance(raw, (bytes, bytearray)):
                raise TypeError("InputFile stream must be opened in binary mode")
            self._data = bytes(raw)
            self._stream = None
        return self._data

    def __repr__(self) -> str:
        return f"InputFile(name={self.name!r}, content_type={self.content_type!r})"
