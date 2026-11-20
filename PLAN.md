# The clients: plan

`lurkapi` on npm (JS/TS, with the CLI) and `lurkapi` on PyPI (Python). Both names were free on 2026-11-20.

The rule everything follows: **the clients hold no endpoint.** No path, no parameter name, no list of platforms is written in either package. An endpoint added, renamed, moved or re-priced on the API works in every client already installed, with no edit and no release.

## What the API gives us (checked against production, 2026-11-20)

- 89 operations, all `GET` with query parameters, no path templates, auth in `x-api-key`.
- Paths follow no pattern: `/v2/tiktok/video`, `/v3/tiktok/profile/videos`, `/v1/linktree` (`linkinbio_linktree`), `/v1/youtube/channel-videos`. A name can't be turned into a path by rule.
- `GET https://api.lurkapi.com/` is a public index, 5 KB gzipped: every listed endpoint's `url`, `mcp_tool`, `summary`, `credits`, `cost` and `docs`. `mcp_tool` is the operation id in `openapi.json`, `<platform>_<slug_with_underscores>`.
- `GET /openapi.json` (86 KB gzipped) has each operation's parameters and response schema.
- Errors are one shape, `{ success: false, error, code, docs, issues? }`. Every 5xx is free and says "Retry". `rate_limited`, `upstream_busy` and `upstream_timeout` send `retry-after`; `signup_required` (also 429) doesn't.
- Pagination is not uniform: `cursor`, `after`, `continuationToken`, `max_cursor`, `next_max_id`, `paginationToken` and `page` go in; `cursor`, `next_cursor`, `end_cursor`, `next_page` or only `has_more` come out.

## Dispatch

One method does the work, `get(nameOrPath, params)`:

- A string starting with `/` is a path. It's sent as is: no lookup, no extra request. This is the fastest call and also reaches an endpoint the index doesn't list.
- Anything else is an operation id (`tiktok_profile`). The client reads the index once, keeps `name → path` in memory, and calls the path. A name it doesn't find in an index older than 5 minutes (the index's own `max-age`) makes it read the index once more, so a long-running process meets new endpoints; still missing, it throws `unknown_endpoint` with the closest names.

Sugar is the same call with the name spelled as properties: `lurk.tiktok.profile({ handle })` and `lurk.tiktok.profileVideos(...)` in JS (a `Proxy`), `lurk.tiktok.profile_videos(handle=...)` in Python (`__getattr__`). Both join the two parts with `_` (JS first turns camelCase into snake_case) and call `get`. Where the platform ends doesn't matter: `google.maps_search` and `google_maps.search` are the same name.

The index is kept as a value, never as a shared in-flight promise (a Worker's request can't await another request's I/O).

Cost of the convenience: one 5 KB request per process, on the first named call. A caller who minds passes the path.

## Types and editor hints

Never needed for a call. They're made at release from the live `openapi.json` and aren't in git, so a registry change never leaves a stale file to regenerate.

- **JS:** `scripts/generate.ts` writes `dist/operations.d.ts`: per operation its path, parameters and response. `get("tiktok_profile", …)`, `get("/v1/tiktok/profile", …)` and `lurk.tiktok.profile(…)` are then typed, and a misspelled endpoint or parameter is an error. Any other string passed to `get` still compiles, loosely typed, which is how an old install calls a new endpoint (`lurk.newplatform.thing()` runs too, but TypeScript doesn't know it yet). In git, `src/operations.ts` is an empty interface, so a checkout is all loose.
- **Python:** `scripts/generate.py` writes `src/lurkapi/_operations.pyi`: each endpoint as a method with keyword parameters and a docstring (summary, cost, docs link). The stub types a base class of the client, so an endpoint it doesn't list still passes a type checker through `__getattr__`. Answers stay `dict[str, Any]`: TypedDicts for 89 responses would be most of the package and Python callers index dicts anyway.

Both generators stop on a schema keyword they don't know, so a new kind of schema fails the repo's test, not a release.

## CLI (npm only)

```
lurkapi list [platform]                  the live index: name, cost, summary
lurkapi tiktok profile --handle nike     the words join into the operation id
lurkapi /v1/tiktok/profile --handle nike a path, no lookup
lurkapi tiktok profile --help            its parameters, from the live openapi.json
lurkapi mcp [--platforms a,b] [--compact]
```

JSON on stdout, the API's error body on stderr with exit code 1. The key comes from `LURKAPI_API_KEY` only: a `--key` flag would collide with endpoint parameters and leak into shell history.

Python gets no CLI: `npx lurkapi` covers it, and two `lurkapi` commands on one PATH would shadow each other.

**MCP launcher: yes, as `lurkapi mcp`,** because it costs ~40 lines and no dependency. The hosted server is stateless Streamable HTTP, so the launcher is a pipe: each JSON-RPC line on stdin is POSTed to `https://api.lurkapi.com/mcp` with the key, and the answer is written to stdout. It knows no tool. It's for stdio-only clients and for MCP catalogs that list npm packages; clients that speak HTTP should keep using the URL (they get OAuth).

## Errors and retries

One error class, `LurkAPIError`, with `status`, `code`, `message`, `docs`, `issues` and `body`. No class per code: new codes need no release. Failures with no HTTP answer use status 0 and the codes `connection_error`, `timeout`, `bad_response` and `unknown_endpoint`.

Retried, up to `maxRetries` (default 2): any 5xx, a 429 that carries `retry-after`, and a connection that failed. The wait is `retry-after` when sent, else 0.5 s then 1 s. Not retried: every other 4xx, and a client timeout (the API finishes and may charge a call whose caller hung up; asking again is the caller's decision). The rule reads the status and the header, never a list of codes.

## Pagination

No helper. The API has no uniform cursor (above), and a guess that's wrong either stops early or loops while spending credits. The READMEs show the three-line loop. The honest way to add `paginate()` later is for `openapi.json` to say it per operation (an `x-next` naming the parameter and the response field); the clients would then read that, still without per-endpoint code.

## Dependencies

- JS: none. `fetch` (Node 18+, Bun, Deno, Workers). ESM only.
- Python: none. `http.client` with a small keep-alive pool, so a second call skips the TLS handshake (`urllib.request` reconnects every time). Sync only; Python 3.9+. Known limit: `http.client` ignores `HTTPS_PROXY`.

## Tests

- `npm run test:sdk` (part of `npm test`): each client against a stub HTTP server (dispatch, the index read once and re-read, query encoding, errors, each retry rule, timeouts), the CLI and the MCP pipe as child processes, the generators on a small spec, and that both packages carry the same version.
- `shared/__tests__/sdk.test.ts` (in `npm run test:site`): the contract. From the registry's own `openapi()` it checks what the clients assume (GET only, query parameters only, no path templates, operation ids that are unique and `[a-z0-9_]`, the error shape, the `x-api-key` scheme), runs both generators on it, and type-checks every endpoint's own example against the generated TypeScript, by name, by path and as `lurk.<platform>.<endpoint>()`. It also pins the 5xx codes, since the clients retry all of them. `api/test/pipeline.test.ts` checks the index's fields.
- `npm run smoke:sdk`: the live API with free calls only: the index, `openapi.json`, a keyless call's `missing_api_key`, both generators on the live `openapi.json`, and with `LURKAPI_API_KEY` set the free `account_credit_balance` and the MCP pipe's `ping` and `tools/list`.

## Versions and releases

Both packages carry the same version; a test fails when they differ. 0.x semver: a patch for fixes and fresh types, a minor for anything a caller could notice. A release is only ever about the clients' own behavior or fresher editor hints.

`sdk/` is the whole content of a public repo (as `plugin/` is), where a tag runs `.github/workflows/release.yml`: tests, types from the live `openapi.json`, then npm and PyPI through trusted publishing with provenance. No token is stored anywhere; npm's first version goes up by hand, because npm sets a trusted publisher on a package that exists. `PUBLISHING.md` has the owner's steps.

## Not built

A pagination helper, an async Python client, a Python CLI, response TypedDicts, a `fetch` option, and docs pages (after the first publish).
