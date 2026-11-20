"""The client against a stand-in API. Run: python3 -m unittest discover -s sdk/python/tests"""

import gzip
import json
import os
import socket
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from lurkapi import LurkAPI, LurkAPIError, __version__  # noqa: E402

# The index as production sends it: absolute production URLs, paths that follow no rule.
INDEX = [
    ("tiktok_profile", "/v1/tiktok/profile"),
    ("tiktok_video", "/v2/tiktok/video"),
    ("tiktok_profile_videos", "/v3/tiktok/profile/videos"),
    ("linkinbio_linktree", "/v1/linktree"),
    ("google_maps_search", "/v1/google/maps/search"),
]


def index(rows=INDEX):
    return {"endpoints": [{"method": "GET", "url": "https://api.lurkapi.com" + path, "summary": "s", "credits": 1, "cost": "1 credit", "docs": "d", "mcp_tool": name} for name, path in rows]}


def ok(**data):
    return {"success": True, "credits_remaining": 99, "credits_charged": 1, **data}


def fail(code, error=None, **more):
    return {"success": False, "error": error or code, "code": code, "docs": "https://lurkapi.com/docs#errors", **more}


class Stub:
    """Records what it was sent and answers what the test says: answer(path, nth) -> (status, headers, body)."""

    def __init__(self, answer=lambda path, nth: (200, {}, ok())):
        stub = self
        self.seen = []  # (path, headers, client port)
        self.sockets = []
        self.release = threading.Event()
        self.rows = INDEX

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_):
                pass

            def do_GET(self):
                stub.seen.append((self.path, dict(self.headers), self.client_address[1]))
                stub.sockets.append(self.connection)
                status, headers, body = (200, {}, index(stub.rows)) if self.path == "/" else answer(self.path, len(stub.calls()))
                if body is None:  # never answer
                    stub.release.wait(10)
                    return
                raw = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode()
                self.send_response(status)
                for k, v in {"content-type": "application/json", "content-length": str(len(raw)), **headers}.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.lurk = LurkAPI("lk_live_test", base_url=self.url)

    def calls(self):
        return [s for s in self.seen if s[0] != "/"]

    def paths(self):
        return [s[0] for s in self.seen]

    def close(self):
        self.release.set()
        self.lurk.close()
        self.server.shutdown()
        self.server.server_close()


class ClientTest(unittest.TestCase):
    def stub(self, *args):
        s = Stub(*args)
        self.addCleanup(s.close)
        return s

    def client(self, *args, **options):
        lurk = LurkAPI(*args, **options)
        self.addCleanup(lurk.close)
        return lurk

    def error(self, call):
        with self.assertRaises(LurkAPIError) as raised:
            call()
        return raised.exception

    def test_a_path_is_sent_as_is(self):
        s = self.stub(lambda path, nth: (200, {}, ok(user="nike")))
        res = s.lurk.get("/v1/tiktok/profile", {"handle": "nike", "trim": False, "none": None}, count=3)
        self.assertEqual(res, ok(user="nike"))
        self.assertEqual(s.paths(), ["/v1/tiktok/profile?handle=nike&trim=false&count=3"], "one request: a path needs no index")
        headers = {k.lower(): v for k, v in s.seen[0][1].items()}
        self.assertEqual(headers["x-api-key"], "lk_live_test")
        self.assertEqual(headers["user-agent"], f"lurkapi-python/{__version__}")

    def test_a_name_is_looked_up_in_the_index_once(self):
        s = self.stub()
        s.lurk.get("tiktok_video", url="https://www.tiktok.com/@nike/video/1")
        s.lurk.tiktok.profile_videos(handle="nike")
        s.lurk.linkinbio.linktree({"handle": "nike"})
        s.lurk.google.maps_search(query="coffee shop")
        s.lurk.google_maps.search(query="coffee shop")
        self.assertEqual(
            s.paths(),
            [
                "/",
                "/v2/tiktok/video?url=https%3A%2F%2Fwww.tiktok.com%2F%40nike%2Fvideo%2F1",
                "/v3/tiktok/profile/videos?handle=nike",
                "/v1/linktree?handle=nike",
                "/v1/google/maps/search?query=coffee+shop",
                "/v1/google/maps/search?query=coffee+shop",
            ],
        )
        self.assertEqual([e["name"] for e in s.lurk.endpoints()], [name for name, _ in INDEX])
        self.assertEqual(s.lurk.endpoints()[1], {"name": "tiktok_video", "path": "/v2/tiktok/video", "summary": "s", "credits": 1, "cost": "1 credit", "docs": "d"})

    def test_an_unknown_name_and_an_endpoint_added_later(self):
        s = self.stub()
        e = self.error(lambda: s.lurk.get("tiktok_profil", handle="nike"))
        self.assertEqual((e.status, e.code), (0, "unknown_endpoint"))
        self.assertIn("tiktok has: tiktok_profile, tiktok_video, tiktok_profile_videos", str(e))
        self.assertIn("Platforms: tiktok, linkinbio, google", str(self.error(lambda: s.lurk.nope.thing())))
        self.assertEqual(s.paths(), ["/"], "nothing was called, and a fresh index isn't read twice")

        # Once the index is over 5 minutes old, an unknown name makes the client read it again.
        s.rows = INDEX + [("pinterest_pin", "/v1/pinterest/pin")]
        at, found, paths = s.lurk._index
        s.lurk._index = (at - 360, found, paths)
        s.lurk.pinterest.pin(url="x")
        self.assertEqual(s.paths(), ["/", "/", "/v1/pinterest/pin?url=x"])
        with self.assertRaises(AttributeError):
            s.lurk._private

    def test_an_error_carries_what_the_api_said(self):
        issues = [{"path": "handle", "message": "required"}]
        s = self.stub(lambda path, nth: (400, {}, fail("invalid_params", "handle: required", issues=issues)))
        e = self.error(lambda: s.lurk.tiktok.profile())
        self.assertEqual((e.status, e.code, e.message, str(e), e.docs, e.issues), (400, "invalid_params", "handle: required", "handle: required", "https://lurkapi.com/docs#errors", issues))
        self.assertEqual(len(s.calls()), 1)

        gone = self.stub(lambda path, nth: (404, {}, fail("not_found")))
        self.assertEqual(self.error(lambda: gone.lurk.get("/v1/a")).code, "not_found")
        self.assertEqual(len(gone.calls()), 1, "a 404 is charged: never asked twice")

    def test_retries(self):
        busy = self.stub(lambda path, nth: (503, {"retry-after": "0"}, fail("upstream_busy")) if nth < 3 else (200, {}, ok()))
        self.assertTrue(busy.lurk.get("/v1/a")["success"])
        self.assertEqual(len(busy.calls()), 3)

        limited = self.stub(lambda path, nth: (429, {"retry-after": "0"}, fail("rate_limited")) if nth < 2 else (200, {}, ok()))
        limited.lurk.get("/v1/a")
        self.assertEqual(len(limited.calls()), 2)

        signup = self.stub(lambda path, nth: (429, {}, fail("signup_required")))
        self.assertEqual(self.error(lambda: signup.lurk.get("/v1/a")).code, "signup_required")
        self.assertEqual(len(signup.calls()), 1, "a 429 that doesn't say when isn't retried")

        broke = self.stub(lambda path, nth: (500, {}, fail("internal_error")) if nth < 2 else (200, {}, ok()))
        start = time.monotonic()
        broke.lurk.get("/v1/a")
        self.assertGreaterEqual(time.monotonic() - start, 0.45, "a 5xx without retry-after waits half a second")

        down = self.stub(lambda path, nth: (502, {"retry-after": "0"}, fail("upstream_error")))
        self.assertEqual(self.error(lambda: down.lurk.get("/v1/a")).status, 502)
        self.assertEqual(len(down.calls()), 3, "two retries by default, then the last error")
        once = self.client("k", base_url=down.url, max_retries=0)
        self.error(lambda: once.get("/v1/a"))
        self.assertEqual(len(down.calls()), 4)

    def test_no_answer(self):
        html = self.stub(lambda path, nth: (502, {"retry-after": "0", "content-type": "text/html"}, "<html>Bad gateway</html>"))
        e = self.error(lambda: self.client("k", base_url=html.url, max_retries=1).get("/v1/a"))
        self.assertEqual((e.status, e.code), (502, "bad_response"))
        self.assertEqual(len(html.calls()), 2)

        slow = self.stub(lambda path, nth: (200, {}, None))
        late = self.error(lambda: self.client("k", base_url=slow.url, timeout=0.2).get("/v1/a"))
        self.assertEqual((late.status, late.code), (0, "timeout"))
        self.assertEqual(len(slow.calls()), 1, "a timeout isn't retried: the call may still finish and be charged")

        nobody = self.client("k", base_url="http://127.0.0.1:9", max_retries=0)
        self.assertEqual(self.error(lambda: nobody.get("/v1/a")).code, "connection_error")

    def test_the_connection_is_kept_and_a_closed_one_replaced(self):
        s = self.stub(lambda path, nth: (200, {"content-encoding": "gzip"}, gzip.compress(json.dumps(ok(n=nth)).encode())))
        self.assertEqual(s.lurk.get("/v1/a")["n"], 1, "gzip is read")
        s.lurk.get("/v1/a")
        self.assertEqual(s.seen[0][2], s.seen[1][2], "the second call reuses the first's connection")

        for sock in s.sockets:  # the server hangs up on the kept connection
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        time.sleep(0.05)
        self.assertEqual(s.lurk.get("/v1/a")["n"], 3, "it's sent again on a new connection, without counting as a retry")
        self.assertNotEqual(s.seen[2][2], s.seen[0][2])

        results = []
        threads = [threading.Thread(target=lambda: results.append(s.lurk.get("/v1/a")["success"])) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(results, [True] * 8, "threads share one client")

    def test_the_key_and_base_url_default_to_the_environment(self):
        s = self.stub()
        os.environ["LURKAPI_API_KEY"] = "lk_live_env"
        os.environ["LURKAPI_BASE_URL"] = s.url + "/"
        try:
            with LurkAPI() as lurk:
                lurk.get("/v1/a")
            del os.environ["LURKAPI_API_KEY"]
            self.client().get("/v1/a")
        finally:
            os.environ.pop("LURKAPI_API_KEY", None)
            del os.environ["LURKAPI_BASE_URL"]
        keys = [{k.lower(): v for k, v in headers.items()}.get("x-api-key") for _, headers, _ in s.seen]
        self.assertEqual(keys, ["lk_live_env", None], "no key: the API's own 401 explains it")


if __name__ == "__main__":
    unittest.main()
