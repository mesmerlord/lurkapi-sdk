// The type generator on a small spec. Run: npx tsx sdk/js/test/generate.test.ts
// The repo's shared/__tests__/sdk.test.ts runs it on the real registry and type-checks the result.

import assert from "node:assert/strict";
import { generate, typeOf, type Spec } from "../scripts/generate.js";

const op = (more: object = {}) => ({
  operationId: "demo_echo",
  summary: "Echo",
  description: "Says it back.\n\nMore.\n\nCost: 1 credit.",
  externalDocs: { url: "https://lurkapi.com/docs/demo/echo" },
  parameters: [
    { name: "query", in: "query", required: true, description: "What to say.", schema: { type: "string" } },
    { name: "count", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
    { name: "trim", in: "query", required: false, schema: { type: "string", enum: ["true", "false"], default: "false" } },
  ],
  responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { success: { type: "boolean", const: true }, top: { $ref: "#/components/schemas/Item" } }, required: ["success"] } } } } },
  ...more,
});
const spec = (get: object = op()): Spec => ({
  paths: { "/v2/demo/echo": { get } } as Spec["paths"],
  components: { schemas: { Item: { type: "object", properties: { replies: { type: "array", items: { $ref: "#/components/schemas/Item" } } } }, Error: { type: "object", properties: { code: { type: "string" } } } } },
});

const code = generate(spec(), "test");
assert.match(code, /\/\*\* Echo\. Says it back\. Cost: 1 credit\. https:\/\/lurkapi\.com\/docs\/demo\/echo \*\/\n {2}demo_echo: \{\n {4}path: "\/v2\/demo\/echo";/);
assert.match(code, /\/\*\* What to say\. \*\/\n {6}query: string;\n {6}count\?: number;\n {6}trim\?: boolean \| "true" \| "false";/);
assert.match(code, /response: \{\n {6}success: true;\n {6}top\?: Item;\n {4}\};/);
assert.match(code, /export type Item = \{\n {2}replies\?: Item\[\];\n\};/);
assert.doesNotMatch(code, /export type Error/, "the error body isn't part of an answer");
console.log("PASS an operation becomes its path, params and response; only the named schemas answers use are written");

assert.equal(typeOf({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
assert.equal(typeOf({ type: ["number", "null"] }), "number | null");
assert.equal(typeOf({ type: "array", items: { enum: ["a", "b"] } }), '("a" | "b")[]');
assert.equal(typeOf({ type: "object", additionalProperties: { type: "number" }, propertyNames: { type: "string" } }), "Record<string, number>");
assert.equal(typeOf({ type: "object", properties: { "a-b": {} }, additionalProperties: {} }), '{\n  "a-b"?: unknown;\n  [key: string]: unknown;\n}');
assert.equal(typeOf({ description: "anything" }), "unknown");
console.log("PASS unions, arrays, records, open objects and untyped values");

const stops = (get: object, why: RegExp) => assert.throws(() => generate(spec(get), "test"), why);
stops(op({ parameters: [{ name: "id", in: "path", schema: { type: "string" } }] }), /isn't a query parameter/);
stops(op({ operationId: "Echo" }), /operationId/);
stops(op({ responses: {} }), /no JSON 200 response/);
stops(op({ parameters: [{ name: "q", in: "query", schema: { type: "string", if: {} } }] }), /unknown schema keyword "if"/);
assert.throws(() => generate({ paths: { "/v1/a": { get: op(), post: op() } } } as unknown as Spec, "test"), /isn't GET only/);
assert.throws(() => generate({ paths: { "/v1/a/{id}": { get: op() } } } as unknown as Spec, "test"), /path parameter/);
console.log("PASS it stops on what the clients don't assume: another method, a path parameter, an unknown schema keyword");
