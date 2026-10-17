"""run_polling: offsets, error handling, answers and stopping."""

from __future__ import annotations

import threading
import unittest
from typing import List, Optional

from fake_api import FakeApi, Recorded, Response, error, ok

from chatbot import ApiError, Update, WebhookAnswer, run_polling


def updates(*ids: int) -> Response:
    return ok([{"update_id": i, "message": {"chat": {"id": 42, "type": "private"}, "seq": i, "date": 0,
                                           "text": f"m{i}"}} for i in ids])


class PollingTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeApi()
        self.client = self.api.client()
        self.stop = threading.Event()

    def tearDown(self) -> None:
        self.api.close()

    def stop_then(self, response: Response) -> object:
        def responder(_: Recorded) -> Response:
            self.stop.set()
            return response
        return responder

    def poll_queries(self) -> List[dict[str, str]]:
        return [r.query for r in self.api.calls("GET", "/updates")]

    def test_offsets_and_order(self) -> None:
        self.api.route("GET", "/updates", updates(1, 2), updates(3), self.stop_then(ok([])))
        seen: List[int] = []
        run_polling(self.client, lambda u: seen.append(u["update_id"]), stop=self.stop, timeout=0,
                    allowed_updates=["message", "reaction"])
        self.assertEqual(seen, [1, 2, 3])
        queries = self.poll_queries()
        self.assertEqual(queries[0], {"timeout": "0", "allowed_updates": "message,reaction"})
        self.assertEqual(queries[1], {"offset": "3", "timeout": "0"})
        self.assertEqual(queries[2], {"offset": "4", "timeout": "0"})
        self.assertEqual(len(queries), 3)  # Nothing new was handled after the last poll.

    def test_handler_error_still_acknowledges(self) -> None:
        self.api.route("GET", "/updates", updates(1, 2), self.stop_then(ok([])))
        seen: List[int] = []

        def handler(update: Update) -> None:
            seen.append(update["update_id"])
            if update["update_id"] == 1:
                raise RuntimeError("boom")

        with self.assertLogs("chatbot", "ERROR"):
            run_polling(self.client, handler, stop=self.stop, timeout=0)
        self.assertEqual(seen, [1, 2])
        self.assertEqual(self.poll_queries()[1]["offset"], "3")

    def test_conflict_stops_the_loop(self) -> None:
        self.api.route("GET", "/updates", updates(1), error(409, "conflict"))
        with self.assertRaises(ApiError) as caught:
            run_polling(self.client, lambda u: None, stop=self.stop, timeout=0)
        self.assertEqual(caught.exception.code, "conflict")
        self.assertEqual(len(self.poll_queries()), 2)

    def test_unauthorized_stops_the_loop(self) -> None:
        self.api.route("GET", "/updates", error(401, "unauthorized"))
        with self.assertRaises(ApiError):
            run_polling(self.client, lambda u: None, stop=self.stop, timeout=0)

    def test_unavailable_waits_and_polls_again(self) -> None:
        client = self.api.client(retries=0)
        self.api.route("GET", "/updates", error(503, "unavailable", retry_after=1), updates(1),
                       self.stop_then(ok([])))
        seen: List[int] = []
        with self.assertLogs("chatbot", "WARNING"):
            run_polling(client, lambda u: seen.append(u["update_id"]), stop=self.stop, timeout=0)
        self.assertEqual(seen, [1])

    def test_stop_acknowledges_handled_updates(self) -> None:
        self.api.route("GET", "/updates", updates(1, 2), ok([]))
        seen: List[int] = []

        def handler(update: Update) -> None:
            seen.append(update["update_id"])
            self.stop.set()

        run_polling(self.client, handler, stop=self.stop, timeout=0)
        self.assertEqual(seen, [1])  # Update 2 stays pending for the next run.
        self.assertEqual(self.poll_queries()[-1], {"offset": "2", "timeout": "0", "limit": "1"})

    def test_returned_answer_is_run_through_the_api(self) -> None:
        self.api.route("GET", "/updates", updates(1), self.stop_then(ok([])))
        self.api.route("POST", "/messages", ok({"seq": 1}))

        def handler(update: Update) -> Optional[WebhookAnswer]:
            return {"method": "sendMessage", "chat_id": 42, "text": "pong"}

        run_polling(self.client, handler, stop=self.stop, timeout=0)
        (sent,) = self.api.calls("POST", "/messages")
        self.assertEqual(sent.json(), {"chat_id": 42, "text": "pong"})


if __name__ == "__main__":
    unittest.main()
