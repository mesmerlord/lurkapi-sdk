// The CLI and the MCP launcher as child processes, against a stand-in API. Run: npx tsx sdk/js/test/cli.test.ts

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { VERSION } from "../src/index.js";
import { fail, ok, stub, type Answer, type Seen } from "./stub.js";

const here = fileURLToPath(new URL("..", import.meta.url));

function run(base: string, args: string[], { stdin = "", key = "lk_live_test" } = {}) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, LURKAPI_BASE_URL: base, LURKAPI_API_KEY: key };
    if (!key) delete env.LURKAPI_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: here, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => done({ code, out, err }));
    child.stdin.end(stdin);
  });
}

const SPEC = {
  paths: {
    "/v1/tiktok/profile": {
      get: {
        operationId: "tiktok_profile",
        summary: "Profile",
        description: "A creator's bio and counts.\n\nCost: 1 credit.",
        externalDocs: { url: "https://lurkapi.com/docs/tiktok/profile" },
        parameters: [
          { name: "handle", in: "query", required: true, description: "TikTok username.", schema: { type: "string" } },
          { name: "trim", in: "query", required: false, description: "Shorter answer.", schema: { type: "string", enum: ["true", "false"] } },
        ],
      },
    },
  },
};

const rpc = (req: Seen): Answer => {
  const msg = JSON.parse(req.body) as { id?: number; method: string };
  if (msg.id === undefined) return { status: 202 };
  if (msg.method === "initialize") return { status: 401, body: fail("missing_api_key", "No API key.") };
  const answer = { jsonrpc: "2.0", id: msg.id, result: { method: msg.method } };
  // The server answers JSON today; the launcher also reads the transport's other form, an event stream.
  if (msg.method === "tools/list") return { headers: { "content-type": "text/event-stream" }, body: `event: message\ndata: ${JSON.stringify(answer)}\n\n` };
  return { body: answer };
};

const api = await stub((req) => {
  if (req.url === "/openapi.json") return { body: SPEC };
  if (req.url.startsWith("/mcp")) return rpc(req);
  if (req.url.includes("handle=ghost")) return { status: 404, body: fail("not_found", "No such account.") };
  return { body: ok({ url: req.url }) };
});

{
  const all = await run(api.url, ["list"]);
  assert.equal(all.code, 0, all.err);
  assert.match(all.out, /^tiktok_profile +1 credit\. A creator's bio and counts\.$/m);
  assert.match(all.out, /^account_credit_balance +free\. Your balance\.$/m);
  const some = await run(api.url, ["list", "tiktok"]);
  assert.deepEqual(some.out.trim().split("\n").map((line) => line.split(" ")[0]), ["tiktok_profile", "tiktok_video", "tiktok_profile_videos"]);
  assert.equal((await run(api.url, ["list", "nope"])).code, 1);
  console.log("PASS lurkapi list [platform] prints the live index");
}

{
  const called = async (...args: string[]) => {
    const r = await run(api.url, args);
    assert.equal(r.code, 0, r.err);
    return (JSON.parse(r.out) as { url: string }).url;
  };
  assert.equal(await called("tiktok", "profile", "--handle", "nike"), "/v1/tiktok/profile?handle=nike");
  assert.equal(await called("tiktok", "profile-videos", "--handle=nike", "--trim"), "/v3/tiktok/profile/videos?handle=nike&trim=true");
  assert.equal(await called("tiktok_video", "--url", "https://x.test/?a=1"), "/v2/tiktok/video?url=https%3A%2F%2Fx.test%2F%3Fa%3D1");
  assert.equal(await called("/v1/linktree", "--handle", "nike", "--offset", "-1"), "/v1/linktree?handle=nike&offset=-1");
  assert.equal(api.seen.at(-1)!.headers["x-api-key"], "lk_live_test");

  const missing = await run(api.url, ["tiktok", "profile", "--handle", "ghost"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.out, "");
  assert.equal((JSON.parse(missing.err) as { code: string }).code, "not_found");
  const unknown = await run(api.url, ["tiktok", "profil"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown_endpoint: No endpoint named "tiktok_profil"\. tiktok has: tiktok_profile,/);
  console.log("PASS a call by words, name or path prints the JSON; an error goes to stderr with exit code 1");
}

{
  const help = await run(api.url, ["tiktok", "profile", "--help"]);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^tiktok_profile: Profile\nGET \/v1\/tiktok\/profile\n/);
  assert.match(help.out, /--handle \(required\) {2}string\n {6}TikTok username\./);
  assert.match(help.out, /--trim {2}true \| false/);
  assert.match((await run(api.url, [])).out, /lurkapi list \[platform\]/);
  assert.equal((await run(api.url, ["--version"])).out.trim(), VERSION);
  console.log("PASS --help reads an endpoint's parameters from the live openapi.json");
}

{
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "initialize" },
  ];
  const before = api.seen.length;
  const r = await run(api.url, ["mcp", "--platforms", "tiktok,reddit", "--compact"], { stdin: lines.map((l) => JSON.stringify(l)).join("\n") + "\n" });
  assert.equal(r.code, 0, r.err);
  const answers = r.out.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } });
  assert.deepEqual(answers.sort((a, b) => a.id - b.id), [
    { jsonrpc: "2.0", id: 1, result: { method: "ping" } },
    { jsonrpc: "2.0", id: 2, result: { method: "tools/list" } },
    { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "No API key." } },
  ]);
  const sent = api.seen.slice(before);
  assert.equal(sent.length, 4, "the notification is sent too; its 202 prints nothing");
  assert.ok(sent.every((s) => s.method === "POST" && s.url === "/mcp?platforms=tiktok%2Creddit&compact=true" && s.headers["x-api-key"] === "lk_live_test"));

  const keyless = await run(api.url, ["mcp"], { key: "" });
  assert.equal(keyless.code, 1);
  assert.match(keyless.err, /needs LURKAPI_API_KEY/);
  console.log("PASS lurkapi mcp pipes each JSON-RPC line to /mcp and back; an answer that isn't JSON-RPC becomes an error for its id");
}

api.close();
