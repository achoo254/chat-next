"""Verifying the init data of Mini Apps.

Ed25519 is not in the Python standard library, so this module uses the
``cryptography`` package, an optional dependency (``pip install
'chat-bot-sdk[miniapp]'``); the rest of the SDK needs only the standard
library. The import happens on the first call, with a clear error when the
package is missing.
"""

from __future__ import annotations

import base64
import binascii
import json
import time
from typing import Dict, Optional, TypedDict, cast
from urllib.parse import parse_qsl

__all__ = [
    "MINI_APP_MAX_AGE",
    "MiniAppInitData",
    "MiniAppUser",
    "verify_mini_app_init_data",
]

MINI_APP_MAX_AGE = 3600
"""Seconds of age (``auth_date``) verify_mini_app_init_data accepts by default."""

_FUTURE_SKEW = 300
"""Seconds ``auth_date`` may be in the future (clock skew)."""


class MiniAppUser(TypedDict, total=False):
    id: int
    first_name: str
    username: str


class MiniAppInitData(TypedDict):
    user: MiniAppUser
    chat_type: str
    """private, group, channel, or sender (opened from the bot's profile); new types may be added."""
    chat_instance: str
    """Stable for a chat and the bot (for sender: the user and the bot), without telling the chat id."""
    start_param: str
    """"" when none was given."""
    auth_date: int
    bot_id: int
    tenant_id: str
    fields: Dict[str, str]
    """Every field but signature, as received."""


def _b64url(text: str) -> bytes:
    return base64.b64decode(text + "=" * (-len(text) % 4), altchars=b"-_", validate=True)


def _check_string(bot_id: int, fields: Dict[str, str]) -> str:
    lines = [f"{key}={fields[key]}" for key in sorted(fields)]
    return "\n".join([f"{bot_id}:WebAppData", *lines])


def verify_mini_app_init_data(
    init_data: str,
    bot_id: int,
    public_key: str,
    max_age: int = MINI_APP_MAX_AGE,
    now: Optional[float] = None,
) -> Optional[MiniAppInitData]:
    """The fields of genuine Mini App init data, or None.

    ``init_data`` is the query string the client passes in ``#chatAppData``.
    The signature is Ed25519 over ``"<bot_id>:WebAppData\\n"`` followed by the
    other fields as ``key=value`` lines sorted by key and joined by ``"\\n"``,
    checked with ``public_key`` (``client.get_mini_app_key()``, base64url);
    ``bot_id`` must match and ``auth_date`` be at most ``max_age`` seconds old
    at ``now`` (default: the current time). Raises RuntimeError when the
    ``cryptography`` package is not installed.
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        raise RuntimeError(
            "verify_mini_app_init_data needs the 'cryptography' package: pip install 'chat-bot-sdk[miniapp]'"
        ) from exc

    try:
        pairs = parse_qsl(init_data, keep_blank_values=True, strict_parsing=True)
    except ValueError:
        return None
    fields: Dict[str, str] = {}
    for key, value in pairs:
        if key in fields:
            return None
        fields[key] = value
    signature_text = fields.pop("signature", "")
    if fields.get("bot_id") != str(bot_id):
        return None
    try:
        key_bytes = _b64url(public_key)
        signature = _b64url(signature_text)
    except (binascii.Error, ValueError):
        return None
    if len(key_bytes) != 32 or len(signature) != 64:
        return None
    try:
        Ed25519PublicKey.from_public_bytes(key_bytes).verify(signature, _check_string(bot_id, fields).encode("utf-8"))
    except (InvalidSignature, ValueError):
        return None
    auth_date_text = fields.get("auth_date", "")
    if not (auth_date_text.isascii() and auth_date_text.isdigit()):
        return None
    auth_date = int(auth_date_text)
    age = (time.time() if now is None else now) - auth_date
    if age > max_age or age < -_FUTURE_SKEW:
        return None
    try:
        user = json.loads(fields.get("user", ""))
    except ValueError:
        return None
    if not isinstance(user, dict) or not isinstance(user.get("id"), int):
        return None
    return MiniAppInitData(
        user=cast(MiniAppUser, user),
        chat_type=fields.get("chat_type", ""),
        chat_instance=fields.get("chat_instance", ""),
        start_param=fields.get("start_param", ""),
        auth_date=auth_date,
        bot_id=bot_id,
        tenant_id=fields.get("tenant_id", ""),
        fields=fields,
    )
