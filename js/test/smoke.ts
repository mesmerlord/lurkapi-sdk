// The live API, free calls only: the index, openapi.json, a keyless 401, and with LURKAPI_API_KEY the free
// balance call and the MCP launcher. Run: npm run smoke (or `npm run smoke:sdk` in the lurkapi repo).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generate, type Spec } from "../scripts/generate.js";
import { API_URL, LurkAPI, LurkAPIError } from "../src/index.js";

const key = process.env.LURKAPI_API_KEY;
const keyless = new LurkAPI({ apiKey: "" });

const endpoints = await keyless.endpoints();
assert.ok(endpoints.length > 50 && endpoints.every((e) => /^\/v\d+\//.test(e.path) && /^[a-z0-9_]+$/.test(e.name)), "the index lists endpoints with a name and a path");
console.log(`PASS the index: ${endpoints.length} endpoints`);

const refused: unknown = await keyless.account.creditBalance().catch((e: unknown) => e);
assert.ok(refused instanceof LurkAPIError && refused.status === 401 && refused.code === "missing_api_key" && refused.docs, String(refused));
console.log("PASS a name resolves through the live index, and a keyless call fails as LurkAPIError 401 missing_api_key");

const spec = (await (await fetch(`${API_URL}/openapi.json`)).json()) as Spec;
const types = generate(spec, API_URL);
assert.deepEqual(Object.values(spec.paths).map((p) => p.get?.operationId).sort(), endpoints.map((e) => e.name).sort(), "openapi.json and the index list the same operations");
console.log(`PASS types generate from the live openapi.json (${Math.round(types.length / 1024)} KB), which names what the index names`);

if (!key) console.log("SKIP the balance call and the MCP launcher: set LURKAPI_API_KEY");
else {
  const balance = await new LurkAPI().account.creditBalance();
  assert.ok(balance.success === true && balance.credits_charged === 0 && typeof balance.credits_remaining === "number");
  console.log("PASS account_credit_balance with the key: free");

  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "mcp", "--platforms", "reddit"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  await new Promise((done) => child.on("close", done));
  const answers = out.trim().split("\n").map((line) => JSON.parse(line) as { id: number; result?: { tools?: { name: string }[] } });
  const tools = answers.find((a) => a.id === 2)?.result?.tools ?? [];
  assert.ok(answers.some((a) => a.id === 1 && a.result) && tools.some((t) => t.name.startsWith("reddit_")), out.slice(0, 300));
  console.log(`PASS lurkapi mcp: ping and tools/list (${tools.length} tools for --platforms reddit)`);
}
