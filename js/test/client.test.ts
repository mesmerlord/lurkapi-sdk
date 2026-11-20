// The client against a stand-in API. Run: npx tsx sdk/js/test/client.test.ts

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LurkAPI, LurkAPIError, VERSION } from "../src/index.js";
import { fail, INDEX, ok, stub, type Answer, type Seen } from "./stub.js";

const server = async (answer: (req: Seen, nth: number) => Answer = () => ({ body: ok() })) => {
  const s = await stub(answer);
  return { ...s, lurk: new LurkAPI({ apiKey: "lk_live_test", baseUrl: s.url }) };
};
const thrown = async (work: Promise<unknown>): Promise<LurkAPIError> => {
  const e = await work.then(
    () => assert.fail("expected the call to fail"),
    (e: unknown) => e,
  );
  assert.ok(e instanceof LurkAPIError, `expected a LurkAPIError, got ${String(e)}`);
  return e;
};

{
  const s = await server(() => ({ body: ok({ user: { uniqueId: "nike" } }) }));
  const res = await s.lurk.get("/v1/tiktok/profile", { handle: "nike", trim: false, count: 3, skip: undefined, none: null });
  assert.deepEqual(res, ok({ user: { uniqueId: "nike" } }));
  assert.equal(s.seen.length, 1, "a path needs no index");
  const [req] = s.seen;
  assert.equal(req!.url, "/v1/tiktok/profile?handle=nike&trim=false&count=3");
  assert.equal(req!.headers["x-api-key"], "lk_live_test");
  assert.equal(req!.headers["user-agent"], `lurkapi-js/${VERSION}`);
  s.close();
  console.log("PASS a path is sent as is: one request, the key, booleans and numbers as text, unset params left out");
}

{
  const s = await server();
  await s.lurk.get("tiktok_video", { url: "https://www.tiktok.com/@nike/video/1" });
  await s.lurk.tiktok.profileVideos({ handle: "nike" });
  await s.lurk.linkinbio.linktree({ handle: "nike" });
  await s.lurk.google.maps_search({ query: "coffee" });
  await s.lurk.google_maps.search({ query: "coffee" });
  assert.deepEqual(s.seen.map((r) => r.url), [
    "/",
    "/v2/tiktok/video?url=https%3A%2F%2Fwww.tiktok.com%2F%40nike%2Fvideo%2F1",
    "/v3/tiktok/profile/videos?handle=nike",
    "/v1/linktree?handle=nike",
    "/v1/google/maps/search?query=coffee",
    "/v1/google/maps/search?query=coffee",
  ]);
  assert.equal((await s.lurk.endpoints()).length, INDEX.endpoints.length);
  assert.equal(Reflect.get(s.lurk, "then"), undefined, "the client isn't thenable");
  assert.equal(Reflect.get(s.lurk.tiktok, "then"), undefined, "nor is a platform");
  s.close();
  console.log("PASS a name is looked up in the index, read once; lurk.platform.endpoint() is the same name, camelCase or snake_case");
}

{
  const s = await server();
  const e = await thrown(s.lurk.get("tiktok_profil", { handle: "nike" }));
  assert.equal(e.code, "unknown_endpoint");
  assert.equal(e.status, 0);
  assert.match(e.message, /tiktok has: tiktok_profile, tiktok_video, tiktok_profile_videos/);
  assert.match((await thrown(s.lurk.nope.thing())).message, /Platforms: tiktok, linkinbio, google, account/);
  assert.deepEqual(s.seen.map((r) => r.url), ["/"], "nothing was called, and a fresh index isn't read twice");

  // Six minutes on, an unknown name makes it read the index again: that's how a running process meets a new endpoint.
  const now = Date.now;
  Date.now = () => now() + 360_000;
  INDEX.endpoints.push({ ...INDEX.endpoints[0]!, url: "https://api.lurkapi.com/v1/pinterest/pin", mcp_tool: "pinterest_pin" });
  try {
    await s.lurk.pinterest.pin({ url: "x" });
  } finally {
    Date.now = now;
    INDEX.endpoints.pop();
  }
  assert.deepEqual(s.seen.map((r) => r.url), ["/", "/", "/v1/pinterest/pin?url=x"]);
  s.close();
  console.log("PASS an unknown name fails with the near names; an endpoint added later is found once the index is 5 minutes old");
}

{
  const issues = [{ path: "handle", message: "required" }];
  const s = await server(() => ({ status: 400, body: fail("invalid_params", "handle: required", { issues }) }));
  const e = await thrown(s.lurk.tiktok.profile());
  assert.deepEqual([e.status, e.code, e.message, e.docs, e.issues], [400, "invalid_params", "handle: required", "https://lurkapi.com/docs#errors", issues]);
  assert.equal(s.calls().length, 1);
  s.close();

  const gone = await server(() => ({ status: 404, body: fail("not_found") }));
  assert.equal((await thrown(gone.lurk.get("/v1/tiktok/profile", { handle: "x" }))).code, "not_found");
  assert.equal(gone.calls().length, 1, "a 404 is charged: never asked twice");
  gone.close();
  console.log("PASS an error carries status, code, message, docs and issues; a 4xx isn't retried");
}

{
  const busy = await server((_, nth) => (nth < 3 ? { status: 503, headers: { "retry-after": "0" }, body: fail("upstream_busy") } : { body: ok() }));
  assert.equal((await busy.lurk.get("/v1/a")).success, true);
  assert.equal(busy.calls().length, 3);
  busy.close();

  const limited = await server((_, nth) => (nth < 2 ? { status: 429, headers: { "retry-after": "0" }, body: fail("rate_limited") } : { body: ok() }));
  await limited.lurk.get("/v1/a");
  assert.equal(limited.calls().length, 2);
  limited.close();

  const signup = await server(() => ({ status: 429, body: fail("signup_required") }));
  assert.equal((await thrown(signup.lurk.get("/v1/a"))).code, "signup_required");
  assert.equal(signup.calls().length, 1, "a 429 that doesn't say when isn't retried");
  signup.close();

  const broke = await server((_, nth) => (nth < 2 ? { status: 500, body: fail("internal_error") } : { body: ok() }));
  const start = Date.now();
  await broke.lurk.get("/v1/a");
  assert.ok(Date.now() - start >= 450, "a 5xx without retry-after waits half a second");
  broke.close();

  const down = await server(() => ({ status: 502, headers: { "retry-after": "0" }, body: fail("upstream_error") }));
  assert.equal((await thrown(down.lurk.get("/v1/a"))).status, 502);
  assert.equal(down.calls().length, 3, "two retries by default, then the last error");
  await thrown(down.lurk.get("/v1/a", {}, { maxRetries: 0 }));
  assert.equal(down.calls().length, 4);
  down.close();
  console.log("PASS retries: a 5xx, a 429 with retry-after; waits what retry-after says; maxRetries bounds it");
}

{
  const html = await server(() => ({ status: 502, headers: { "retry-after": "0" }, body: "<html>Bad gateway</html>" }));
  const e = await thrown(html.lurk.get("/v1/a", {}, { maxRetries: 1 }));
  assert.deepEqual([e.status, e.code], [502, "bad_response"]);
  assert.equal(html.calls().length, 2);
  html.close();

  const slow = await server(() => ({ hang: true }));
  const late = await thrown(slow.lurk.get("/v1/a", {}, { timeout: 100 }));
  assert.deepEqual([late.status, late.code], [0, "timeout"]);
  assert.equal(slow.calls().length, 1, "a timeout isn't retried: the call may still finish and be charged");

  const stop = new AbortController();
  const waiting = slow.lurk.get("/v1/a", {}, { signal: stop.signal });
  setTimeout(() => stop.abort(), 50);
  const aborted: unknown = await waiting.catch((e: unknown) => e);
  assert.ok(aborted instanceof Error && !(aborted instanceof LurkAPIError) && aborted.name === "AbortError", "the caller's own abort comes back as it was");
  slow.close();

  const nobody = new LurkAPI({ baseUrl: "http://127.0.0.1:9", maxRetries: 0 });
  assert.equal((await thrown(nobody.get("/v1/a"))).code, "connection_error");
  console.log("PASS no answer: bad_response for a body that isn't ours, timeout, the caller's abort, connection_error");
}

{
  const s = await server();
  process.env.LURKAPI_API_KEY = "lk_live_env";
  process.env.LURKAPI_BASE_URL = `${s.url}/`;
  await new LurkAPI().get("/v1/a");
  delete process.env.LURKAPI_API_KEY;
  await new LurkAPI().get("/v1/a");
  delete process.env.LURKAPI_BASE_URL;
  assert.deepEqual(s.seen.map((r) => r.headers["x-api-key"]), ["lk_live_env", undefined], "no key: the API's own 401 explains it");
  s.close();
  console.log("PASS the key and base URL default to LURKAPI_API_KEY and LURKAPI_BASE_URL");
}

{
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  assert.equal((JSON.parse(read("../package.json")) as { version: string }).version, VERSION);
  assert.equal(/^__version__ = "(.+)"$/m.exec(read("../../python/src/lurkapi/_version.py"))?.[1], VERSION);
  console.log(`PASS both packages and the user agent say ${VERSION}`);
}
