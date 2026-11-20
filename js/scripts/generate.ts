// openapi.json → dist/operations.d.ts: each operation's path, params and response, for editors only.
// Run at release: npm run types [-- --from <file or url>] [--out <file>]. Calls never need its output.
// It stops on anything it doesn't understand, so a new kind of schema fails a test, not a release.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Schema = Record<string, unknown>;
export interface Spec {
  paths: Record<string, Record<string, Schema>>;
  components?: { schemas?: Record<string, Schema> };
}

/** Keywords that describe or narrow a value without changing its type. */
const ANNOTATIONS = ["description", "default", "title", "format", "pattern", "example", "examples", "deprecated", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "propertyNames"];
const KNOWN = new Set([...ANNOTATIONS, "type", "properties", "required", "additionalProperties", "items", "anyOf", "oneOf", "enum", "const", "$ref"]);

const isRecord = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const key = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name));
const doc = (text: unknown, pad: string) => (typeof text === "string" && text ? `${pad}/** ${text.replaceAll("*/", "*\\/").replace(/\s*\n\s*/g, " ")} */\n` : "");
const union = (types: string[]) => [...new Set(types)].map((t) => (/[|&]|=>/.test(t) && types.length > 1 ? `(${t})` : t)).join(" | ");

/** Named schemas (`components.schemas`) the types written so far refer to. */
const refs = new Set<string>();

/** A JSON Schema as a TypeScript type. */
export function typeOf(schema: unknown, pad = ""): string {
  if (schema === true || (isRecord(schema) && !Object.keys(schema).some((k) => !ANNOTATIONS.includes(k)))) return "unknown";
  if (!isRecord(schema)) throw new Error(`generate: not a schema: ${JSON.stringify(schema)}`);
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`generate: unknown schema keyword "${k}" in ${JSON.stringify(schema).slice(0, 200)}`);

  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").pop()!;
    refs.add(name);
    return name;
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return union(schema.enum.map((v) => JSON.stringify(v)));
  const anyOf = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(anyOf)) return union(anyOf.map((s) => typeOf(s, pad)));
  if (Array.isArray(schema.type)) return union(schema.type.map((type) => typeOf({ ...schema, type }, pad)));

  switch (schema.type ?? (schema.properties ? "object" : undefined)) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = schema.items === undefined ? "unknown" : typeOf(schema.items, pad);
      return /[|&]|=>/.test(item) ? `(${item})[]` : `${item}[]`;
    }
    case "object": {
      const props = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
      const extra = schema.additionalProperties;
      if (!props.length) return `Record<string, ${extra === undefined || extra === false ? "unknown" : typeOf(extra, pad)}>`;
      const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
      const inner = `${pad}  `;
      const lines = props.map(([name, s]) => `${doc(isRecord(s) && s.description, inner)}${inner}${key(name)}${required.has(name) ? "" : "?"}: ${typeOf(s, inner)};\n`);
      if (extra !== undefined && extra !== false) lines.push(`${inner}[key: string]: unknown;\n`);
      return `{\n${lines.join("")}${pad}}`;
    }
    default:
      throw new Error(`generate: unknown type in ${JSON.stringify(schema).slice(0, 200)}`);
  }
}

/** A query parameter: what the client sends for it. A `true`/`false` enum also takes a boolean. */
function paramType(schema: unknown): string {
  const type = typeOf(schema);
  return isRecord(schema) && Array.isArray(schema.enum) && [...schema.enum].sort().join() === "false,true" ? `boolean | ${type}` : type;
}

/** The whole file. Throws when the spec breaks what the clients assume (see PLAN.md). */
export function generate(spec: Spec, source: string): string {
  const seen = new Set<string>();
  const ops: string[] = [];
  refs.clear();
  for (const [path, item] of Object.entries(spec.paths)) {
    const methods = Object.keys(item);
    const op = item.get;
    if (methods.join() !== "get" || !op) throw new Error(`generate: ${path} isn't GET only (${methods.join()})`);
    if (path.includes("{")) throw new Error(`generate: ${path} has a path parameter`);
    const id = String(op.operationId);
    if (!/^[a-z0-9]+(_[a-z0-9]+)+$/.test(id) || seen.has(id)) throw new Error(`generate: ${path} has a missing, misshapen or repeated operationId (${id})`);
    seen.add(id);

    const params = ((op.parameters ?? []) as Schema[]).map((p) => {
      if (p.in !== "query") throw new Error(`generate: ${id}.${String(p.name)} isn't a query parameter`);
      return `${doc(p.description, "      ")}      ${key(String(p.name))}${p.required ? "" : "?"}: ${paramType(p.schema)};\n`;
    });
    const ok = (op.responses as Record<string, { content?: Record<string, { schema?: unknown }> }> | undefined)?.["200"]?.content?.["application/json"]?.schema;
    if (!ok) throw new Error(`generate: ${id} has no JSON 200 response`);
    const about = [op.summary, String(op.description ?? "").split("\n\n")[0], /Cost: [^\n]+/.exec(String(op.description))?.[0], isRecord(op.externalDocs) && op.externalDocs.url];
    ops.push(
      `${doc(about.filter(Boolean).join(". ").replaceAll("..", "."), "  ")}  ${id}: {\n    path: ${JSON.stringify(path)};\n` +
        `    params: {${params.length ? `\n${params.join("")}    ` : ""}};\n    response: ${typeOf(ok, "    ")};\n  };\n`,
    );
  }
  // Only the named schemas an answer uses (not the error body), and the ones those use in turn.
  const named: string[] = [];
  for (const name of refs) {
    const schema = spec.components?.schemas?.[name];
    if (!schema) throw new Error(`generate: no schema named ${name}`);
    named.push(`export type ${name} = ${typeOf(schema)};\n`);
  }
  return `// Generated from ${source}: ${ops.length} operations. Don't edit; run \`npm run types\`.\n\n${named.join("\n")}\nexport interface Operations {\n${ops.join("")}}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
  const from = arg("--from") ?? "https://api.lurkapi.com/openapi.json";
  const out = resolve(arg("--out") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../dist/operations.d.ts"));
  const text = /^https?:/.test(from) ? await (await fetch(from)).text() : readFileSync(from, "utf8");
  const code = generate(JSON.parse(text) as Spec, from);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, code);
  console.log(`${out}: ${Math.round(code.length / 1024)} KB`);
}
