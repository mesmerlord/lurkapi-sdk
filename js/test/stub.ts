// A stand-in API for the tests: it records what it was sent and answers what the test says.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface Seen {
  method: string;
  /** Path and query. */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}
export interface Answer {
  status?: number;
  headers?: Record<string, string>;
  /** Sent as JSON; a string is sent as is. */
  body?: unknown;
  /** Never answer. */
  hang?: boolean;
}

/** The index as production sends it: absolute production URLs, paths that follow no rule. */
export const INDEX = {
  name: "LurkAPI",
  endpoints: [
    ["tiktok_profile", "/v1/tiktok/profile", "A creator's bio and counts.", 1, "1 credit"],
    ["tiktok_video", "/v2/tiktok/video", "One video.", 1, "1 credit"],
    ["tiktok_profile_videos", "/v3/tiktok/profile/videos", "A creator's videos.", 1, "1 credit"],
    ["linkinbio_linktree", "/v1/linktree", "A Linktree page.", 1, "1 credit"],
    ["google_maps_search", "/v1/google/maps/search", "Places.", 1, "1 credit"],
    ["account_credit_balance", "/v1/account/credit-balance", "Your balance.", 0, "free"],
  ].map(([mcp_tool, path, summary, credits, cost]) => ({ method: "GET", url: `https://api.lurkapi.com${path}`, summary, credits, cost, docs: `https://lurkapi.com/docs/${mcp_tool}`, mcp_tool })),
};

export const ok = (data: object = {}) => ({ success: true, credits_remaining: 99, credits_charged: 1, ...data });
export const fail = (code: string, error = code, more: object = {}) => ({ success: false, error, code, docs: "https://lurkapi.com/docs#errors", ...more });

export async function stub(answer: (req: Seen, nth: number) => Answer) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const got: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body };
      seen.push(got);
      const a = got.url === "/" ? { body: INDEX } : answer(got, seen.filter((s) => s.url !== "/").length);
      if (a.hang) return;
      const text = typeof a.body === "string" ? a.body : a.body === undefined ? "" : JSON.stringify(a.body);
      res.writeHead(a.status ?? 200, { "content-type": typeof a.body === "string" ? "text/html" : "application/json", ...a.headers });
      res.end(text);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    /** Calls that weren't the index. */
    calls: () => seen.filter((s) => s.url !== "/"),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
