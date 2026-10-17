"""Python SDK of the chat platform's Bot API (stdlib only).

``Client`` calls the API, ``Bot`` routes updates to handlers, ``run_polling``
and ``serve_webhook`` receive them. The model types (TypedDicts) and API methods
are generated from ``spec/bot-api/openapi.yaml``.
"""

from ._generated import *  # noqa: F403 (the models, listed in their __all__)
from ._generated import __all__ as _models
from .client import DEFAULT_BASE_URL, ApiError, Client, NetworkError
from .files import InputFile
from .polling import run_polling
from .router import Bot, Context, Handler
from .webhook import MAX_BODY, UpdateHandler, serve_webhook, verify_webhook, webhook_app

__version__ = "0.1.0"

__all__ = [
    *_models,
    "ApiError",
    "Bot",
    "Client",
    "Context",
    "DEFAULT_BASE_URL",
    "Handler",
    "InputFile",
    "MAX_BODY",
    "NetworkError",
    "UpdateHandler",
    "run_polling",
    "serve_webhook",
    "verify_webhook",
    "webhook_app",
]
