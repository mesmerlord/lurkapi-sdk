"""The LurkAPI client. It holds no endpoint: a path is sent as is, and a name is looked up in the
API's own index (GET /), so a new or renamed endpoint needs no release. See ../../../PLAN.md."""

from __future__ import annotations

import gzip
import http.client
import json
import os
import socket
import threading
import time
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlencode, urlsplit

from ._operations import Operations
from ._version import __version__

API_URL = "https://api.lurkapi.com"
# The index's own max-age: a name missing from an older copy is looked up again.
_INDEX_TTL_S = 300.0


class LurkAPIError(Exception):
    """Any failed call. `code` is the API's (`not_found`, `rate_limited`, ...: https://lurkapi.com/docs#errors),
    or with `status` 0 one of ours: `connection_error`, `timeout`, `bad_response`, `unknown_endpoint`."""

    def __init__(self, status: int, code: str, message: str, body: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        #: The response body as sent.
        self.body = body
        known = body if isinstance(body, dict) else {}
        #: The page that explains the fix.
        self.docs: Optional[str] = known.get("docs")
        #: One entry per invalid parameter (`invalid_params`).
        self.issues: Optional[List[Dict[str, str]]] = known.get("issues")


class _Platform:
    """`lurk.tiktok`: any attribute is a call to `tiktok_<attribute>`."""

    def __init__(self, client: "LurkAPI", name: str) -> None:
        self._client = client
        self._name = name

    def __getattr__(self, endpoint: str) -> Callable[..., Dict[str, Any]]:
        if endpoint.startswith("_"):
            raise AttributeError(endpoint)
        name = f"{self._name}_{endpoint}"

        def call(params: Optional[Mapping[str, Any]] = None, /, **more: Any) -> Dict[str, Any]:
            return self._client.get(name, params, **more)

        call.__name__ = name
        return call


class LurkAPI(Operations):
    """`LurkAPI().tiktok.profile(handle="nike")`, `.get("tiktok_profile", handle="nike")` or
    `.get("/v1/tiktok/profile", {"handle": "nike"})`. Answers are the API's JSON as a dict.

    api_key: default `LURKAPI_API_KEY`. base_url: default `LURKAPI_BASE_URL`, else https://api.lurkapi.com.
    timeout: seconds to wait on the connection (default 100: a web page can take 90).
    max_retries: retries of a 5xx, a 429 with `retry-after` or a failed connection (default 2).
    """

    def __init__(self, api_key: Optional[str] = None, *, base_url: Optional[str] = None, timeout: float = 100.0, max_retries: int = 2) -> None:
        self._api_key = api_key or os.environ.get("LURKAPI_API_KEY") or None
        url = urlsplit(base_url or os.environ.get("LURKAPI_BASE_URL") or API_URL)
        self._secure = url.scheme == "https"
        self._host = url.netloc
        self._prefix = url.path.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._idle: List[http.client.HTTPConnection] = []
        self._lock = threading.Lock()
        self._index: Optional[Tuple[float, List[Dict[str, Any]], Dict[str, str]]] = None

    def __getattr__(self, platform: str) -> _Platform:
        # lurk.tiktok.profile(...) is get("tiktok_profile", ...): nothing here knows a platform.
        if platform.startswith("_"):
            raise AttributeError(platform)
        return _Platform(self, platform)

    def get(self, name_or_path: str, params: Optional[Mapping[str, Any]] = None, /, **more: Any) -> Dict[str, Any]:
        """Call an endpoint by operation id (`tiktok_profile`) or by path (`/v1/tiktok/profile`, no lookup).
        Parameters go in a dict, as keywords, or both. None is left out; True and False are sent as text."""
        path = name_or_path if name_or_path.startswith("/") else self._path_of(name_or_path)
        given = {**(params or {}), **more}
        query = urlencode({k: (str(v).lower() if isinstance(v, bool) else str(v)) for k, v in given.items() if v is not None})
        return self._request(path + ("?" + query if query else ""))

    def endpoints(self) -> List[Dict[str, Any]]:
        """The API's live index: every listed endpoint's name, path, summary, credits, cost and docs page."""
        body = self._request("/")
        found = [
            {
                "name": str(e.get("mcp_tool")),
                "path": urlsplit(str(e.get("url"))).path,
                "summary": e.get("summary", ""),
                "credits": e.get("credits", 0),
                "cost": e.get("cost", ""),
                "docs": e.get("docs", ""),
            }
            for e in body.get("endpoints") or []
        ]
        if not found:
            raise LurkAPIError(0, "bad_response", f"{self._host}/ listed no endpoints.", body)
        self._index = (time.monotonic(), found, {e["name"]: e["path"] for e in found})
        return found

    def close(self) -> None:
        """Close the kept connections. The client still works after; it reconnects."""
        with self._lock:
            idle, self._idle = self._idle, []
        for conn in idle:
            conn.close()

    def __enter__(self) -> "LurkAPI":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def _path_of(self, name: str) -> str:
        if self._index is None:
            self.endpoints()
        assert self._index is not None
        if name not in self._index[2] and time.monotonic() - self._index[0] > _INDEX_TTL_S:
            self.endpoints()
        _, found, paths = self._index
        if name in paths:
            return paths[name]
        names = [e["name"] for e in found]
        platform = name.split("_")[0]
        near = [n for n in names if n.startswith(platform + "_")]
        hint = f"{platform} has: {', '.join(near)}." if near else f"Platforms: {', '.join(dict.fromkeys(n.split('_')[0] for n in names))}."
        raise LurkAPIError(0, "unknown_endpoint", f'No endpoint named "{name}". {hint} Or pass a path, like "/v1/tiktok/profile".')

    def _request(self, path_and_query: str) -> Dict[str, Any]:
        headers = {"accept": "application/json", "accept-encoding": "gzip", "user-agent": f"lurkapi-python/{__version__}"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        attempt = 0
        while True:
            last = attempt >= self._max_retries
            try:
                status, retry_after, text = self._send(path_and_query, headers)
            except socket.timeout:
                # A call we hung up on still finishes, and may be charged: asking again is the caller's decision.
                raise LurkAPIError(0, "timeout", f"No answer in {self._timeout:g} s.") from None
            except (OSError, http.client.HTTPException) as e:
                if last:
                    raise LurkAPIError(0, "connection_error", f"Couldn't reach {self._host}: {e}") from e
                time.sleep(0.5 * 2**attempt)
                attempt += 1
                continue

            try:
                body = json.loads(text)
            except ValueError:
                body = None
            ok = 200 <= status < 300
            if ok and isinstance(body, dict) and body.get("success") is not False:
                return body
            if isinstance(body, dict) and isinstance(body.get("code"), str):
                error = LurkAPIError(status, body["code"], str(body.get("error") or body["code"]), body)
            else:
                error = LurkAPIError(0 if ok else status, "bad_response", f"HTTP {status} without a LurkAPI body: {text[:200]}", text)
            # Every 5xx is free and says to retry; a 429 says when (signup_required sends no retry-after).
            if last or not (status >= 500 or (status == 429 and retry_after is not None)):
                raise error
            try:
                wait = float(retry_after) if retry_after is not None else 0.5 * 2**attempt
            except ValueError:
                wait = 0.5 * 2**attempt
            time.sleep(wait)
            attempt += 1

    def _send(self, target: str, headers: Dict[str, str]) -> Tuple[int, Optional[str], str]:
        """One GET on a kept connection, so only the first call pays for the TLS handshake."""
        while True:
            with self._lock:
                conn = self._idle.pop() if self._idle else None
            reused = conn is not None
            if conn is None:
                conn = (http.client.HTTPSConnection if self._secure else http.client.HTTPConnection)(self._host, timeout=self._timeout)
            try:
                conn.request("GET", self._prefix + target, headers=headers)
                res = conn.getresponse()
            except socket.timeout:
                conn.close()
                raise
            except (OSError, http.client.HTTPException):
                conn.close()
                if reused:
                    continue  # the server had closed a kept connection: send it on another
                raise
            try:
                raw = res.read()
            except BaseException:
                conn.close()
                raise
            if res.will_close:
                conn.close()
            else:
                with self._lock:
                    self._idle.append(conn)
            if res.getheader("content-encoding") == "gzip":
                raw = gzip.decompress(raw)
            return res.status, res.getheader("retry-after"), raw.decode("utf-8", "replace")
