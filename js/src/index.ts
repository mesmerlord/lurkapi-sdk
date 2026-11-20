// The LurkAPI client. It holds no endpoint: a path is sent as is, and a name is looked up in the
// API's own index (GET /), so a new or renamed endpoint needs no release. See ../../PLAN.md.

import type { Operations } from "./operations.js";

export const VERSION = "0.1.0";
export const API_URL = "https://api.lurkapi.com";
/** The index's own max-age: a name missing from an older copy is looked up again. */
const INDEX_TTL_MS = 300_000;

export type Params = Record<string, string | number | boolean | null | undefined>;

/** A success response: the endpoint's fields beside these three. */
export interface Result {
  success: true;
  credits_remaining: number;
  credits_charged: number;
  [field: string]: unknown;
}

/** One line of the API's index. */
export interface Endpoint {
  /** The operation id, e.g. `tiktok_profile`. */
  name: string;
  path: string;
  summary: string;
  credits: number;
  /** "1 credit", "1 credit; 2 if speech-to-text runs", "free". */
  cost: string;
  docs: string;
}

export interface ClientOptions {
  /** Default: `LURKAPI_API_KEY`. */
  apiKey?: string;
  /** Default: `LURKAPI_BASE_URL`, else https://api.lurkapi.com. */
  baseUrl?: string;
  /** Milliseconds to wait for one answer. Default 100,000: a web page can take 90 s. */
  timeout?: number;
  /** Retries of a 5xx, a 429 with `retry-after` or a failed connection. Default 2. */
  maxRetries?: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxRetries?: number;
}

export interface Issue {
  path: string;
  message: string;
}

/**
 * Any failed call. `code` is the API's (`not_found`, `rate_limited`, …: https://lurkapi.com/docs#errors),
 * or with `status` 0 one of ours: `connection_error`, `timeout`, `bad_response`, `unknown_endpoint`.
 */
export class LurkAPIError extends Error {
  override name = "LurkAPIError";
  readonly status: number;
  readonly code: string;
  /** The page that explains the fix. */
  readonly docs?: string;
  /** One entry per invalid parameter (`invalid_params`). */
  readonly issues?: Issue[];
  /** The response body as sent. */
  readonly body?: unknown;

  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
    if (isRecord(body)) {
      if (typeof body.docs === "string") this.docs = body.docs;
      if (Array.isArray(body.issues)) this.issues = body.issues as Issue[];
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** `profileVideos` and `profile-videos` → `profile_videos`. */
export const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replaceAll("-", "_");
const env = (name: string) => (typeof process === "undefined" ? undefined : process.env[name]) || undefined;

class Client {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private index: { at: number; list: Endpoint[]; paths: Map<string, string> } | undefined;

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? env("LURKAPI_API_KEY");
    this.baseUrl = (options.baseUrl ?? env("LURKAPI_BASE_URL") ?? API_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 100_000;
    this.maxRetries = options.maxRetries ?? 2;
    // lurk.tiktok.profile(params) is get("tiktok_profile", params): nothing here knows a platform.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop !== "string" || prop in target || prop === "then") return Reflect.get(target, prop, receiver);
        return new Proxy(
          {},
          {
            get: (_, name) =>
              typeof name !== "string" || name === "then"
                ? undefined
                : (params?: Params, options?: CallOptions) => target.get(`${snake(prop)}_${snake(name)}`, params, options),
          },
        );
      },
    });
  }

  /**
   * Call an endpoint by operation id (`tiktok_profile`) or by path (`/v1/tiktok/profile`, no lookup).
   * A name or path known at release is typed; any other string works too, loosely typed (`get<Mine>(…)` to type it).
   */
  async get<T = never, N extends string = string>(nameOrPath: N, ...args: ArgsFor<N>): Promise<[T] extends [never] ? ResponseFor<N> : T>;
  async get(nameOrPath: string, params: Params = {}, options: CallOptions = {}): Promise<unknown> {
    const path = nameOrPath.startsWith("/") ? nameOrPath : await this.pathOf(nameOrPath, options);
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) query.set(k, String(v));
    const qs = query.toString();
    return this.request(path + (qs ? `?${qs}` : ""), options);
  }

  /** The API's live index: every listed endpoint with its name, path, price and docs page. */
  async endpoints(options: CallOptions = {}): Promise<Endpoint[]> {
    const body = await this.request("/", options);
    const rows = isRecord(body) && Array.isArray(body.endpoints) ? (body.endpoints as Record<string, unknown>[]) : [];
    const list = rows.map((e) => ({
      name: String(e.mcp_tool),
      path: new URL(String(e.url)).pathname,
      summary: String(e.summary ?? ""),
      credits: Number(e.credits ?? 0),
      cost: String(e.cost ?? ""),
      docs: String(e.docs ?? ""),
    }));
    if (!list.length) throw new LurkAPIError(0, "bad_response", `${this.baseUrl}/ listed no endpoints.`, body);
    // Kept as a value, not a promise: a Worker's request can't await another request's fetch.
    this.index = { at: Date.now(), list, paths: new Map(list.map((e) => [e.name, e.path])) };
    return list;
  }

  private async pathOf(name: string, options: CallOptions): Promise<string> {
    if (!this.index) await this.endpoints(options);
    let path = this.index!.paths.get(name);
    if (!path && Date.now() - this.index!.at > INDEX_TTL_MS) {
      await this.endpoints(options);
      path = this.index!.paths.get(name);
    }
    if (path) return path;
    const names = this.index!.list.map((e) => e.name);
    const platform = name.split("_")[0]!;
    const near = names.filter((n) => n.startsWith(`${platform}_`));
    const hint = near.length ? `${platform} has: ${near.join(", ")}.` : `Platforms: ${[...new Set(names.map((n) => n.split("_")[0]))].join(", ")}.`;
    throw new LurkAPIError(0, "unknown_endpoint", `No endpoint named "${name}". ${hint} Or pass a path, like "/v1/tiktok/profile".`);
  }

  private async request(pathAndQuery: string, options: CallOptions): Promise<unknown> {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeout = options.timeout ?? this.timeout;
    const headers: Record<string, string> = { accept: "application/json", "user-agent": `lurkapi-js/${VERSION}` };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxRetries;
      const abort = new AbortController();
      const hangUp = () => abort.abort();
      const timer = setTimeout(hangUp, timeout);
      options.signal?.addEventListener("abort", hangUp, { once: true });
      let res: Response;
      let text: string;
      try {
        options.signal?.throwIfAborted();
        res = await fetch(this.baseUrl + pathAndQuery, { headers, signal: abort.signal });
        text = await res.text();
      } catch (e) {
        if (options.signal?.aborted) throw e;
        // A call we hung up on still finishes, and may be charged: asking again is the caller's decision.
        if (abort.signal.aborted) throw new LurkAPIError(0, "timeout", `No answer in ${timeout / 1000} s.`);
        if (last) throw new LurkAPIError(0, "connection_error", `Couldn't reach ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
        await sleep(500 * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", hangUp);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (res.ok && isRecord(body) && body.success !== false) return body;

      const error = isRecord(body) && typeof body.code === "string"
        ? new LurkAPIError(res.status, body.code, String(body.error ?? body.code), body)
        : new LurkAPIError(res.ok ? 0 : res.status, "bad_response", `HTTP ${res.status} without a LurkAPI body: ${text.slice(0, 200)}`, text);
      // Every 5xx is free and says to retry; a 429 says when (signup_required sends no retry-after).
      const retryAfter = res.headers.get("retry-after");
      if (last || !(res.status >= 500 || (res.status === 429 && retryAfter !== null))) throw error;
      const seconds = Number(retryAfter);
      await sleep(retryAfter !== null && Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt);
    }
  }
}

// ── types: all optional, generated into operations.d.ts at release ───────────

type Op = { path: string; params: object; response: object };
type Known = keyof Operations & string;
type Of<K, F extends keyof Op> = K extends Known ? (Operations[K] extends Op ? Operations[K][F] : never) : never;
type ByPath = { [K in Known as Of<K, "path">]: K };
type Loose = [params?: Params, options?: CallOptions];
type Args<K> = object extends Of<K, "params"> ? [params?: Of<K, "params">, options?: CallOptions] : [params: Of<K, "params">, options?: CallOptions];
type ArgsFor<N> = N extends Known ? Args<N> : N extends keyof ByPath ? Args<ByPath[N]> : Loose;
type ResponseFor<N> = N extends Known ? Of<N, "response"> : N extends keyof ByPath ? Of<ByPath[N], "response"> : Result;
type Camel<S extends string> = S extends `${infer A}_${infer B}` ? `${A}${Capitalize<Camel<B>>}` : S;
type Platform = Known extends `${infer A}_${string}` ? A : never;

/** `lurk.<platform>.<endpoint>(params)`: the operations known at release, or anything when none were generated. */
type Sugar = [Known] extends [never]
  ? { readonly [platform: string]: { readonly [endpoint: string]: (...args: Loose) => Promise<Result> } }
  : { readonly [P in Platform]: { readonly [K in Known as K extends `${P}_${infer R}` ? Camel<R> : never]: (...args: Args<K>) => Promise<Of<K, "response">> } };

export type LurkAPI = Client & Sugar;
export const LurkAPI = Client as new (options?: ClientOptions) => LurkAPI;
export type { Operations };
