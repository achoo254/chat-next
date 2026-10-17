"""Receiving updates by long poll (``GET /updates``)."""

from __future__ import annotations

import logging
import threading
from typing import Optional, Sequence, cast

from ._generated import SendMessageRequest, UpdateKind, WebhookAnswer, WebhookAnswer2
from .client import ApiError, Client, NetworkError
from .webhook import UpdateHandler

__all__ = ["run_polling"]

_log = logging.getLogger("chatbot")

_MAX_BACKOFF = 30.0


def run_polling(
    client: Client,
    handler: UpdateHandler,
    *,
    stop: Optional[threading.Event] = None,
    timeout: int = 50,
    limit: Optional[int] = None,
    allowed_updates: Optional[Sequence[UpdateKind]] = None,
) -> None:
    """Long polls ``get_updates`` and hands each update to ``handler``, in order.

    Each request acknowledges the updates before it (``offset`` = last
    ``update_id`` + 1). A handler error is logged and its update still
    acknowledged. A WebhookAnswer returned by the handler is run through the
    API, so a handler behaves the same as at a webhook. Network errors, 5xx and
    429 wait (1 s doubling up to 30 s, or ``retry_after``) and poll again; other
    API errors, ``409 conflict`` (another poll or a webhook) included, are
    raised. Returns when ``stop`` is set (checked between polls, so it can take
    up to ``timeout`` seconds), after acknowledging the handled updates;
    without ``stop`` it runs until an error.
    """
    event = stop if stop is not None else threading.Event()
    offset: Optional[int] = None
    backoff = 1.0
    # The server remembers allowed_updates, so it is sent with the first poll only.
    allowed = ",".join(allowed_updates) if allowed_updates is not None else None
    unacknowledged = False
    while not event.is_set():
        try:
            updates = client.get_updates(offset=offset, timeout=timeout, limit=limit, allowed_updates=allowed)
        except ApiError as err:
            if err.status == 429 or err.status >= 500:
                delay = float(err.retry_after) if err.retry_after else backoff
                _log.warning("poll failed (%d %s), retrying in %.0f s", err.status, err.code, delay)
                backoff = min(backoff * 2, _MAX_BACKOFF)
                event.wait(delay)
                continue
            raise
        except NetworkError as err:
            _log.warning("poll failed (%s), retrying in %.0f s", err, backoff)
            event.wait(backoff)
            backoff = min(backoff * 2, _MAX_BACKOFF)
            continue
        backoff = 1.0
        allowed = None
        unacknowledged = False
        for update in updates:
            if event.is_set():
                break  # The rest is not acknowledged and comes again next time.
            offset = update["update_id"] + 1
            unacknowledged = True
            try:
                answer = handler(update)
                if answer is not None:
                    _run_answer(client, answer)
            except Exception:
                _log.exception("update handler failed for update %d", update["update_id"])
    if unacknowledged and offset is not None:
        _acknowledge(client, offset)


def _acknowledge(client: Client, offset: int) -> None:
    """Acknowledges handled updates on stop, so a restart does not get them again."""
    try:
        client.get_updates(offset=offset, timeout=0, limit=1)
    except (ApiError, NetworkError) as err:
        _log.warning("could not acknowledge the last updates on stop: %s", err)


def _run_answer(client: Client, answer: WebhookAnswer) -> None:
    """Runs a WebhookAnswer through the API, as the server does for a webhook."""
    method = answer.get("method")
    if method == "sendMessage":
        # The answer carries the fields of SendMessageRequest besides "method".
        request = cast(SendMessageRequest, {k: v for k, v in answer.items() if k != "method"})
        client.send_message(**request)
    elif method == "answerCallback":
        callback = cast(WebhookAnswer2, answer)
        client.answer_callback(callback["callback_id"], text=callback.get("text"),
                               show_alert=callback.get("show_alert"), url=callback.get("url"))
    else:
        _log.warning("ignoring a handler answer with unknown method %r", method)
