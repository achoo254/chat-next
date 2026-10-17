"""Client: envelope, ApiError, retries, multipart uploads and downloads."""

from __future__ import annotations

import io
import json
import unittest

from fake_api import DROP, TOKEN, FakeApi, error, ok, part_text

from chatbot import ApiError, Client, InputFile, NetworkError


class ClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = FakeApi()
        self.client = self.api.client()

    def tearDown(self) -> None:
        self.api.close()

    def test_result_of_envelope_and_bearer_token(self) -> None:
        me = {"id": 7, "is_bot": True, "name": "Echo", "username": "echo_bot", "privacy": True, "tier": "default"}
        self.api.route("GET", "/me", ok(me))
        self.assertEqual(self.client.get_me(), me)
        (request,) = self.api.calls("GET", "/me")
        self.assertEqual(request.headers["authorization"], "Bearer " + TOKEN)
        self.assertEqual(request.body, b"")

    def test_json_body_leaves_out_absent_fields(self) -> None:
        self.api.route("POST", "/messages", ok({"chat": {"id": 42, "type": "private"}, "seq": 1, "date": 0}))
        self.client.send_message(chat_id=42, text="Xin chào")
        (request,) = self.api.calls("POST", "/messages")
        self.assertEqual(request.headers["content-type"], "application/json")
        self.assertEqual(request.json(), {"chat_id": 42, "text": "Xin chào"})

    def test_query_parameters(self) -> None:
        self.api.route("GET", "/updates", ok([]))
        self.api.route("DELETE", "/webhook", ok())
        self.client.get_updates(offset=5, timeout=0, allowed_updates="message,reaction")
        self.client.delete_webhook(drop_pending=True)
        self.assertEqual(self.api.calls("GET", "/updates")[0].query,
                         {"offset": "5", "timeout": "0", "allowed_updates": "message,reaction"})
        self.assertEqual(self.api.calls("DELETE", "/webhook")[0].query, {"drop_pending": "true"})

    def test_path_parameters_are_escaped(self) -> None:
        self.api.route("POST", "/callbacks/a%2Fb:answer", ok())
        self.client.answer_callback("a/b", text="x")
        self.assertEqual(len(self.api.calls("POST", "/callbacks/a%2Fb:answer")), 1)

    def test_api_error_fields_without_token(self) -> None:
        self.api.route("POST", "/messages", error(403, "no_consent", "the user did not start the bot"))
        with self.assertRaises(ApiError) as caught:
            self.client.send_message(chat_id=42, text="hi")
        err = caught.exception
        self.assertEqual((err.status, err.code, err.description, err.retry_after),
                         (403, "no_consent", "the user did not start the bot", 0))
        self.assertNotIn(TOKEN, str(err))
        self.assertNotIn(TOKEN, repr(self.client))
        self.assertEqual(self.api.sleeps, [])

    def test_retries_429_after_retry_after(self) -> None:
        self.api.route("GET", "/me", error(429, "rate_limited", retry_after=2), ok({"id": 1}))
        self.assertEqual(self.client.get_me(), {"id": 1})
        self.assertEqual(self.api.sleeps, [2.0])
        self.assertEqual(len(self.api.calls("GET", "/me")), 2)

    def test_retries_503_after_retry_after_header(self) -> None:
        self.api.route("POST", "/messages", error(503, "unavailable", headers={"Retry-After": "3"}), ok({"seq": 1}))
        self.assertEqual(self.client.send_message(chat_id=1, text="x"), {"seq": 1})
        self.assertEqual(self.api.sleeps, [3.0])

    def test_retries_503_after_one_second_by_default(self) -> None:
        self.api.route("GET", "/me", error(503, "unavailable"), ok({"id": 1}))
        self.client.get_me()
        self.assertEqual(self.api.sleeps, [1.0])

    def test_gives_up_after_retries(self) -> None:
        self.api.route("GET", "/me", error(429, "rate_limited", retry_after=1))
        with self.assertRaises(ApiError) as caught:
            self.client.get_me()
        self.assertEqual(caught.exception.retry_after, 1)
        self.assertEqual(len(self.api.calls("GET", "/me")), 4)  # 1 try + 3 retries
        self.assertEqual(self.api.sleeps, [1.0, 1.0, 1.0])

    def test_does_not_retry_other_errors(self) -> None:
        self.api.route("POST", "/messages:bulk", error(429, "bulk_quota"))
        self.api.route("GET", "/me", error(500, "internal"))
        with self.assertRaises(ApiError):
            self.client.send_bulk(all=True, text="x")
        with self.assertRaises(ApiError):
            self.client.get_me()
        self.assertEqual(len(self.api.requests), 2)
        self.assertEqual(self.api.sleeps, [])

    def test_network_error_of_get_is_retried(self) -> None:
        self.api.route("GET", "/me", DROP, ok({"id": 1}))
        self.assertEqual(self.client.get_me(), {"id": 1})
        self.assertEqual(self.api.sleeps, [1.0])

    def test_network_error_of_request_with_body_is_not_retried(self) -> None:
        self.api.route("POST", "/messages", DROP, ok({"seq": 1}))
        with self.assertRaises(NetworkError) as caught:
            self.client.send_message(chat_id=1, text="x")
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertEqual(len(self.api.calls("POST", "/messages")), 1)

    def test_answer_without_envelope(self) -> None:
        self.api.route("GET", "/me", (502, b"<html>bad gateway</html>", {"Content-Type": "text/html"}))
        with self.assertRaises(ApiError) as caught:
            self.client.get_me()
        self.assertEqual((caught.exception.status, caught.exception.code), (502, "invalid_response"))

    def test_redirect_is_not_followed(self) -> None:
        self.api.route("GET", "/me", (302, b"", {"Location": self.api.origin + "/elsewhere"}))
        with self.assertRaises(ApiError) as caught:
            self.client.get_me()
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual([r.path for r in self.api.requests], ["/me"])

    def test_rejects_non_http_urls(self) -> None:
        with self.assertRaises(ValueError):
            Client(TOKEN, base_url="file:///etc")
        with self.assertRaises(ValueError):
            self.client.download_file("file:///etc/passwd")

    def test_send_media_upload_multipart(self) -> None:
        self.api.route("POST", "/messages:sendMedia", ok({"seq": 9}))
        result = self.client.send_media_upload(
            chat_id=42, kind="document", file=InputFile("hello.txt", "xin chào".encode()),
            text="Tệp mẫu", entities=[{"type": "bold", "offset": 0, "length": 3}], reply_to_seq=5)
        self.assertEqual(result, {"seq": 9})
        (request,) = self.api.calls("POST", "/messages:sendMedia")
        self.assertTrue(request.headers["content-type"].startswith("multipart/form-data; boundary="))
        parts = {p.get_param("name", header="content-disposition"): p for p in request.multipart()}
        self.assertEqual(set(parts), {"chat_id", "kind", "text", "entities", "reply_to_seq", "file"})
        self.assertEqual(part_text(parts["chat_id"]), "42")
        self.assertEqual(part_text(parts["kind"]), "document")
        self.assertEqual(part_text(parts["text"]), "Tệp mẫu")
        self.assertEqual(part_text(parts["reply_to_seq"]), "5")
        self.assertEqual(json.loads(part_text(parts["entities"])), [{"type": "bold", "offset": 0, "length": 3}])
        self.assertEqual(parts["file"].get_filename(), "hello.txt")
        self.assertEqual(parts["file"].get_content_type(), "text/plain")
        self.assertEqual(parts["file"].get_payload(decode=True), "xin chào".encode())
        for name in ("chat_id", "kind", "text", "entities", "reply_to_seq"):
            self.assertIsNone(parts[name].get_filename())

    def test_upload_file_name_outside_ascii(self) -> None:
        self.api.route("POST", "/messages:sendMedia", ok({"seq": 1}))
        self.client.send_media_upload(chat_id=1, kind="document", file=InputFile("báo cáo.pdf", b"%PDF"))
        (part,) = [p for p in self.api.requests[0].multipart()
                   if p.get_param("name", header="content-disposition") == "file"]
        self.assertEqual(part.get_filename(), "báo cáo.pdf")

    def test_upload_is_resent_on_retry(self) -> None:
        self.api.route("POST", "/messages:sendMedia", error(429, "rate_limited", retry_after=1), ok({"seq": 1}))
        upload = InputFile("a.bin", io.BytesIO(b"\x00\x01\x02"))
        self.client.send_media_upload(chat_id=1, kind="document", file=upload)
        bodies = [r.body for r in self.api.calls("POST", "/messages:sendMedia")]
        self.assertEqual(len(bodies), 2)
        self.assertEqual(bodies[0], bodies[1])
        self.assertIn(b"\x00\x01\x02", bodies[1])

    def test_send_album_upload_part_names(self) -> None:
        self.api.route("POST", "/messages:sendAlbum", ok([{"seq": 1}, {"seq": 2}]))
        items = [{"attach": "a", "kind": "photo", "text": "Trước"}, {"attach": "b", "kind": "photo"}]
        self.client.send_album_upload(
            chat_id=42, items=items,  # type: ignore[arg-type]
            files={"a": InputFile("before.jpg", b"A"), "b": InputFile("after.jpg", b"B")})
        (request,) = self.api.calls("POST", "/messages:sendAlbum")
        parts = {p.get_param("name", header="content-disposition"): p for p in request.multipart()}
        self.assertEqual(set(parts), {"chat_id", "items", "a", "b"})
        self.assertEqual(json.loads(part_text(parts["items"])), items)
        self.assertEqual(parts["a"].get_filename(), "before.jpg")
        self.assertEqual(parts["a"].get_payload(decode=True), b"A")
        self.assertEqual(parts["b"].get_payload(decode=True), b"B")

    def test_send_album_upload_checks_attachments(self) -> None:
        with self.assertRaises(ValueError):
            self.client.send_album_upload(chat_id=1, items=[{"attach": "a", "kind": "photo"}], files={})
        with self.assertRaises(ValueError):
            self.client.send_album_upload(chat_id=1, items=[{"file_id": "F"}], files={"x": InputFile("x", b"")})
        self.assertEqual(self.api.requests, [])

    def test_download_file_without_token(self) -> None:
        self.api.route("GET", "/files/F1", ok({"file_id": "F1", "kind": "document", "size": 3,
                                               "url": self.api.origin + "/dl/F1?sig=x", "url_expires": 0}))
        self.api.route("GET", "/dl/F1", (200, b"abc", {"Content-Type": "application/octet-stream"}))
        info = self.client.get_file("F1")
        self.assertEqual(self.client.download_file(info), b"abc")
        (download,) = self.api.calls("GET", "/dl/F1")
        self.assertNotIn("authorization", download.headers)
        self.assertEqual(download.query, {"sig": "x"})

    def test_download_failure(self) -> None:
        self.api.route("GET", "/dl/gone", (403, b"expired", {}))
        with self.assertRaises(ApiError) as caught:
            self.client.download_file(self.api.origin + "/dl/gone")
        self.assertEqual(caught.exception.status, 403)


class InputFileTest(unittest.TestCase):
    def test_reads_stream_once(self) -> None:
        upload = InputFile("x.png", io.BytesIO(b"png"))
        self.assertEqual(upload.read(), b"png")
        self.assertEqual(upload.read(), b"png")
        self.assertEqual(upload.content_type, "image/png")

    def test_rejects_bad_input(self) -> None:
        with self.assertRaises(ValueError):
            InputFile("", b"x")
        with self.assertRaises(ValueError):
            InputFile("a\r\nb", b"x")
        with self.assertRaises(TypeError):
            InputFile("a", "text")  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            InputFile("a", io.StringIO("text")).read()  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
