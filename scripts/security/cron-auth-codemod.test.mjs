import assert from "node:assert/strict";
import { test } from "node:test";
import { addCronAuth, hardenBearer } from "./cron-auth-codemod.mjs";
import { syntaxOk } from "./cors-codemod.mjs";

const NOAUTH = `import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  return new Response("ok", { headers: { ...corsHeaders, "Content-Type": "text/plain" } });
});
`;

test("addCronAuth: adds fail-closed auth as the first statement, removes CORS, adds the import", () => {
  const r = addCronAuth(NOAUTH);
  assert.ok(r.text, r.error);
  assert.match(r.text, /Deno\.serve\(async \(req: Request\) => \{\n  const auth = requireCronAuth\(req, \{ allowBearer: true, extraEnvNames: \["SUPABASE_SERVICE_ROLE_KEY"\] \}\);\n  if \(!auth\.ok\) return auth\.response;\n  if \(req\.method === "OPTIONS"\)/);
  assert.match(r.text, /import \{ requireCronAuth \} from "\.\.\/_shared\/http\/cronAuth\.ts";/);
  assert.ok(!/Access-Control|corsHeaders/.test(r.text));
  assert.match(r.text, /status: 405 \}/);
  assert.ok(syntaxOk(r.text));
});

test("addCronAuth refuses already-authenticated or unusual handlers", () => {
  assert.match(addCronAuth(`${NOAUTH}\nrequireCronAuth(req);`).error, /already uses/);
  assert.match(addCronAuth(NOAUTH.replace("Deno.serve(async (req: Request) => {", "Deno.serve(handler); (async (x) => {")).error, /not `Deno\.serve/);
});

test("hardenBearer: replaces both timing-unsafe shapes", () => {
  const a = hardenBearer(`import x from "y";\nDeno.serve(async (req: Request) => {\n  const key = Deno.env.get("K") ?? "";\n  if (!key || req.headers.get("Authorization") !== \`Bearer \${key}\`) return json({ error: "Unauthorized" }, 401);\n  return json({});\n});\n`);
  assert.ok(a.text, a.error);
  assert.ok(!/!== `Bearer/.test(a.text));
  assert.match(a.text, /const auth = requireCronAuth\(req,/);
  assert.ok(syntaxOk(a.text));
  const b = hardenBearer(`import x from "y";\nDeno.serve(async (req: Request) => {\n  const key = Deno.env.get("K") ?? "";\n  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\\s+/i, "");\n  if (!key || bearer !== key) return json({ error: "Unauthorized" }, 401);\n  return json({});\n});\n`);
  assert.ok(b.text, b.error);
  assert.ok(!/bearer !== key/.test(b.text));
  assert.ok(syntaxOk(b.text));
});

test("hardenBearer refuses when the pattern is absent", () => {
  assert.match(hardenBearer(`import x from "y";\nDeno.serve(() => new Response("x"));`).error, /not found/);
});
