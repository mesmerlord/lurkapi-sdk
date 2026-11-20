# lurkapi

The official JavaScript and TypeScript client for [LurkAPI](https://lurkapi.com): public social media data as clean JSON. Profiles, posts, comments, transcripts and ads from TikTok, Instagram, YouTube, Reddit, X (Twitter), LinkedIn, Facebook, Google and more, one GET request per call.

No dependencies. Node 18+, Bun, Deno and Cloudflare Workers. It also ships a CLI and a stdio launcher for the LurkAPI MCP server.

```bash
npm install lurkapi
export LURKAPI_API_KEY=lk_live_…   # free at https://lurkapi.com/login
```

```ts
import { LurkAPI } from "lurkapi";

const lurk = new LurkAPI(); // reads LURKAPI_API_KEY

const profile = await lurk.tiktok.profile({ handle: "nike" });
console.log(profile.user.nickname, profile.stats.followerCount);

const { transcript_only_text } = await lurk.youtube.transcript({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
```

Every answer is the API's JSON: the endpoint's fields beside `success`, `credits_charged` and `credits_remaining`.

## Every endpoint, including ones added after you installed

The client holds no list of endpoints. It reads the API's own index, so anything in the [docs](https://lurkapi.com/docs) works without an update:

```ts
await lurk.tiktok.profileVideos({ handle: "nike" });         // lurk.<platform>.<endpoint>()
await lurk.get("tiktok_profile_videos", { handle: "nike" }); // by name
await lurk.get("/v3/tiktok/profile/videos", { handle: "nike" }); // by path: no lookup, the fastest

const endpoints = await lurk.endpoints(); // [{ name, path, summary, credits, cost, docs }, …]
```

The first call by name reads the index once (5 KB); a call by path never does.

Names known when your version was released are fully typed: parameters, required ones, and each answer's fields. A newer endpoint still works through `get("its_name", …)`, loosely typed, or `get<YourType>(…)`.

## Errors

A failed call throws `LurkAPIError` with the API's `code`, `status`, `message`, `docs` link and, for bad parameters, `issues`:

```ts
import { LurkAPI, LurkAPIError } from "lurkapi";

try {
  await lurk.tiktok.profile({ handle: "someone-who-is-not-there" });
} catch (e) {
  if (e instanceof LurkAPIError && e.code === "not_found") console.log("no such account");
  else throw e;
}
```

The codes are in the [docs](https://lurkapi.com/docs#errors). When there was no answer at all, `status` is 0 and `code` is `timeout`, `connection_error`, `bad_response` or `unknown_endpoint`.

Retried for you, twice by default: any 5xx (never charged), a `429` that says when to come back, and a connection that failed. Nothing else is: a `not_found` is charged, so it's never asked twice.

## Pages

Endpoints page the way their platform does, so the cursor's name is on each endpoint's docs page. The loop is the same everywhere:

```ts
let after: string | undefined;
do {
  const page = await lurk.reddit.subredditPosts({ subreddit: "marketing", after });
  for (const post of page.posts) console.log(post.title);
  after = page.after ?? undefined;
} while (after);
```

## Options

```ts
const lurk = new LurkAPI({
  apiKey: "lk_live_…", // default: LURKAPI_API_KEY
  timeout: 100_000,    // ms to wait for one answer (default 100 s: a web page can take 90)
  maxRetries: 2,
});

await lurk.web.scrape({ url: "https://example.com" }, { timeout: 30_000, signal, maxRetries: 0 }); // per call
```

## From the shell

```bash
npx lurkapi list tiktok                      # endpoints and prices, live
npx lurkapi tiktok profile --handle nike     # JSON on stdout
npx lurkapi tiktok profile --help            # its parameters
npx lurkapi /v1/tiktok/profile --handle nike | jq .stats.followerCount
```

Errors go to stderr with exit code 1.

## MCP

LurkAPI's MCP server is hosted at `https://api.lurkapi.com/mcp`; apps that take a URL (Claude, ChatGPT, Cursor, VS Code) should use that and sign in. For an app that only launches a command, this package bridges stdio to it:

```json
{
  "mcpServers": {
    "lurkapi": {
      "command": "npx",
      "args": ["-y", "lurkapi", "mcp"],
      "env": { "LURKAPI_API_KEY": "lk_live_…" }
    }
  }
}
```

Every endpoint is a tool. `"args": ["-y", "lurkapi", "mcp", "--platforms", "tiktok,reddit"]` keeps the list to those platforms, and `--compact` gives two tools that search and call the whole catalog.

## Links

[Docs](https://lurkapi.com/docs) · [Pricing](https://lurkapi.com/pricing) · [Status](https://lurkapi.com/status) · [Python client](https://pypi.org/project/lurkapi/) · support@lurkapi.com

MIT
