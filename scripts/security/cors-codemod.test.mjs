import assert from "node:assert/strict";
import { test } from "node:test";
import { stripCors, syntaxOk } from "./cors-codemod.mjs";

const MULTI = `import x from "y";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Cron-Secret",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return new Response("no", { status: 405, headers: corsHeaders });
  return json({ ok: true });
});
`;

test("removes a multi-line CORS const, spreads, headers props; preflight becomes 405", () => {
  const r = stripCors(MULTI);
  assert.ok(r.text, r.error);
  assert.ok(!/Access-Control|corsHeaders/.test(r.text));
  assert.match(r.text, /status: 405 \}\);\n  if \(req\.method !== "POST"\)/);
  assert.match(r.text, /\{ status: 405 \}\);\n  return json/);
  assert.match(r.text, /headers: \{ "Content-Type": "application\/json" \}/);
  assert.ok(syntaxOk(r.text));
});

test("handles single-line const with another identifier name", () => {
  const src = `const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x" };
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { ...cors, "Content-Type": "application/json" } });
Deno.serve((req: Request) => req.method === "OPTIONS" ? new Response(null, { status: 200, headers: cors }) : json({}));
`;
  const r = stripCors(src);
  assert.ok(r.text, r.error);
  assert.ok(!/cors|Access-Control/.test(r.text));
  assert.ok(syntaxOk(r.text));
});

test("`{ headers: name }` and `{ ...name }` collapse cleanly", () => {
  const r = stripCors(`const c = { "Access-Control-Allow-Origin": "*" };
const a = new Response("x", { headers: c });
const b = { ...c };
`);
  assert.ok(r.text, r.error);
  assert.match(r.text, /new Response\("x", \{\}\)/);
  assert.match(r.text, /const b = \{\};/);
});

test("refuses when no CORS const exists (shared helper)", () => {
  assert.match(stripCors(`import { corsPreflight } from "../_shared/x.ts";\nDeno.serve(() => corsPreflight());`).error, /no `const X/);
});

test("refuses when the identifier is still used in an unsupported shape", () => {
  const r = stripCors(`const c = { "Access-Control-Allow-Origin": "*" };\nconst h = new Headers(c);\n`);
  assert.match(r.error, /still referenced/);
});

test("refuses when another Access-Control header is set elsewhere", () => {
  const r = stripCors(`const c = { "Access-Control-Allow-Origin": "*" };\nres.headers.set("Access-Control-Expose-Headers", "x");\n`);
  assert.match(r.error, /Access-Control header remains/);
});

test("syntaxOk rejects broken source", () => {
  assert.equal(syntaxOk("const a = {;"), false);
});
