# lurkapi

The official Python client for [LurkAPI](https://lurkapi.com): public social media data as clean JSON. Profiles, posts, comments, transcripts and ads from TikTok, Instagram, YouTube, Reddit, X (Twitter), LinkedIn, Facebook, Google and more, one GET request per call.

No dependencies: the standard library only. Python 3.9+.

```bash
pip install lurkapi
export LURKAPI_API_KEY=lk_live_…   # free at https://lurkapi.com/login
```

```python
from lurkapi import LurkAPI

lurk = LurkAPI()  # reads LURKAPI_API_KEY

profile = lurk.tiktok.profile(handle="nike")
print(profile["user"]["nickname"], profile["stats"]["followerCount"])

text = lurk.youtube.transcript(url="https://www.youtube.com/watch?v=dQw4w9WgXcQ")["transcript_only_text"]
```

Every answer is the API's JSON as a dict: the endpoint's fields beside `success`, `credits_charged` and `credits_remaining`.

## Every endpoint, including ones added after you installed

The client holds no list of endpoints. It reads the API's own index, so anything in the [docs](https://lurkapi.com/docs) works without an update:

```python
lurk.tiktok.profile_videos(handle="nike")               # lurk.<platform>.<endpoint>()
lurk.get("tiktok_profile_videos", handle="nike")        # by name
lurk.get("/v3/tiktok/profile/videos", {"handle": "nike"})  # by path: no lookup, the fastest

endpoints = lurk.endpoints()  # [{"name", "path", "summary", "credits", "cost", "docs"}, …]
```

The first call by name reads the index once (5 KB); a call by path never does. Parameters go as keywords, as a dict, or both; `True` and `False` are sent as the API expects them.

Your editor completes the endpoints known when your version was released, with their parameters and a line on what each costs. A newer endpoint works the same way; it just isn't suggested yet.

## Errors

A failed call raises `LurkAPIError` with the API's `code`, `status`, `message`, `docs` link and, for bad parameters, `issues`:

```python
from lurkapi import LurkAPI, LurkAPIError

try:
    lurk.tiktok.profile(handle="someone-who-is-not-there")
except LurkAPIError as e:
    if e.code != "not_found":
        raise
    print("no such account")
```

The codes are in the [docs](https://lurkapi.com/docs#errors). When there was no answer at all, `status` is 0 and `code` is `timeout`, `connection_error`, `bad_response` or `unknown_endpoint`.

Retried for you, twice by default: any 5xx (never charged), a `429` that says when to come back, and a connection that failed. Nothing else is: a `not_found` is charged, so it's never asked twice.

## Pages

Endpoints page the way their platform does, so the cursor's name is on each endpoint's docs page. The loop is the same everywhere:

```python
after = None
while True:
    page = lurk.reddit.subreddit_posts(subreddit="marketing", after=after)
    for post in page["posts"]:
        print(post["title"])
    after = page.get("after")
    if not after:
        break
```

## Options

```python
lurk = LurkAPI(
    "lk_live_…",      # default: LURKAPI_API_KEY
    timeout=100,      # seconds to wait (default 100: a web page can take 90)
    max_retries=2,
)
```

One client keeps its connections open, so make it once and share it; it's safe across threads. In async code, `await asyncio.to_thread(lurk.tiktok.profile, handle="nike")`.

It doesn't read `HTTPS_PROXY`.

## Links

[Docs](https://lurkapi.com/docs) · [Pricing](https://lurkapi.com/pricing) · [Status](https://lurkapi.com/status) · [JavaScript client and CLI](https://www.npmjs.com/package/lurkapi) · support@lurkapi.com

MIT
