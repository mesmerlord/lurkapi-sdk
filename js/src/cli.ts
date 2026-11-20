#!/usr/bin/env node
// `lurkapi`: any endpoint from the shell, and the stdio launcher for the hosted MCP server.
// Like the client, it knows no endpoint: names, prices and parameters come from the API when asked.

import { createInterface } from "node:readline";
import { API_URL, LurkAPI, LurkAPIError, snake, VERSION, type Params } from "./index.js";

const USAGE = `lurkapi ${VERSION}: public social media data as JSON. https://lurkapi.com/docs

  lurkapi list [platform]                    every endpoint, with its price
  lurkapi tiktok profile --handle nike       call one (the words join into its name)
  lurkapi /v1/tiktok/profile --handle nike   or by path
  lurkapi tiktok profile --help              its parameters
  lurkapi mcp [--platforms a,b] [--compact]  the MCP server over stdio

Set LURKAPI_API_KEY (free at https://lurkapi.com/login). Answers are JSON on stdout.`;

const base = () => (process.env.LURKAPI_BASE_URL || API_URL).replace(/\/+$/, "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const print = (line: string) => process.stdout.write(`${line}\n`);

/** Words before the first flag, then `--name value`, `--name=value` or a bare `--name` (true). */
function parse(argv: string[]): { words: string[]; flags: Record<string, string> } {
  const words: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h") flags.help = "true";
    else if (!arg.startsWith("--")) words.push(arg);
    else if (arg.includes("=")) flags[arg.slice(2, arg.indexOf("="))] = arg.slice(arg.indexOf("=") + 1);
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) flags[arg.slice(2)] = argv[++i]!;
    else flags[arg.slice(2)] = "true";
  }
  return { words, flags };
}

async function list(platform?: string): Promise<void> {
  const all = await new LurkAPI().endpoints();
  const rows = platform ? all.filter((e) => e.name.startsWith(`${snake(platform)}_`)) : all;
  if (!rows.length) throw new LurkAPIError(0, "unknown_endpoint", `No platform named "${platform}". Run: lurkapi list`);
  const wide = Math.max(...rows.map((e) => e.name.length));
  for (const e of rows) print(`${e.name.padEnd(wide)}  ${e.cost}. ${e.summary}`);
}

/** One endpoint's parameters, read from the live openapi.json. */
async function describe(target: string): Promise<void> {
  const res = await fetch(`${base()}/openapi.json`);
  const spec = (await res.json()) as { paths?: Record<string, { get?: Record<string, unknown> }> };
  const found = Object.entries(spec.paths ?? {}).find(([path, item]) => path === target || item.get?.operationId === target);
  if (!found?.[1].get) throw new LurkAPIError(0, "unknown_endpoint", `No endpoint named "${target}". Run: lurkapi list`);
  const [path, { get: op }] = found;
  const docs = isRecord(op.externalDocs) ? String(op.externalDocs.url) : "";
  print(`${String(op.operationId)}: ${String(op.summary)}\nGET ${path}\n\n${String(op.description)}\n${docs}\n`);
  for (const p of (op.parameters ?? []) as Record<string, unknown>[]) {
    const schema = isRecord(p.schema) ? p.schema : {};
    const kind = Array.isArray(schema.enum) ? schema.enum.join(" | ") : String(schema.type ?? "string");
    print(`  --${String(p.name)}${p.required ? " (required)" : ""}  ${kind}\n      ${String(p.description ?? "")}`);
  }
}

/** Stdio to the hosted MCP server, which is stateless: each JSON-RPC line is one POST, its answer one line back. */
async function mcp(flags: Record<string, string>): Promise<number> {
  const key = process.env.LURKAPI_API_KEY;
  if (!key) {
    console.error("lurkapi mcp needs LURKAPI_API_KEY. Get a key free at https://lurkapi.com/login");
    return 1;
  }
  const url = new URL(`${base()}/mcp`);
  for (const [k, v] of Object.entries(flags)) url.searchParams.set(k, v);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "x-api-key": key, "user-agent": `lurkapi-mcp/${VERSION}` };

  const relay = async (line: string) => {
    let id: unknown;
    const fail = (message: string) => id !== undefined && print(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
    try {
      const sent: unknown = JSON.parse(line);
      if (isRecord(sent)) id = sent.id;
      const res = await fetch(url, { method: "POST", headers, body: line });
      const text = await res.text();
      const frames = res.headers.get("content-type")?.includes("text/event-stream")
        ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n"))
        : [text];
      for (const frame of frames) {
        if (!frame.trim()) continue; // a notification's 202
        const message: unknown = JSON.parse(frame);
        if (Array.isArray(message) || (isRecord(message) && message.jsonrpc)) print(JSON.stringify(message));
        else fail(isRecord(message) && typeof message.error === "string" ? message.error : `HTTP ${res.status}`);
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  };

  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const job: Promise<void> = relay(line).finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { words, flags } = parse(argv);
  const [first, ...rest] = words;
  if (flags.version) return print(VERSION), 0;
  if (!first || first === "help") return print(USAGE), 0;
  if (first === "mcp") return mcp(flags);
  try {
    if (first === "list") return await list(rest[0]), 0;
    const target = first.startsWith("/") ? first : words.map(snake).join("_");
    if (flags.help) return await describe(target), 0;
    const params: Params = flags;
    print(JSON.stringify(await new LurkAPI().get(target, params), null, 2));
    return 0;
  } catch (e) {
    if (!(e instanceof LurkAPIError)) console.error(e instanceof Error ? e.message : String(e));
    else console.error(isRecord(e.body) ? JSON.stringify(e.body, null, 2) : `${e.code}: ${e.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
