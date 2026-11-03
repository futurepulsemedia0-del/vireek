#!/usr/bin/env node
// scripts/security/function-matrix.mjs
//
// Static security inventory of every Supabase edge function.
//
//   node scripts/security/function-matrix.mjs --write    regenerate docs/security/function-matrix.{md,json}
//   node scripts/security/function-matrix.mjs --check    CI gate (exit 1 on stale matrix or new violations)
//   node scripts/security/function-matrix.mjs --update-baseline   accept the current legacy violations (review the diff!)
//   node scripts/security/function-matrix.mjs --fix-config       rewrite supabase/config.toml: drop duplicate/stale tables, add header-declared verify_jwt=false (fixes config-drift)
//   node scripts/security/function-matrix.mjs --emit-config      print only the blocks --fix-config would append
//
// IMPORTANT: this is a *static heuristic* (regex over the function and the _shared modules it imports,
// up to 3 levels). It is an inventory and a ratchet, not a proof of correctness. Proof comes from the
// tests (webhook/authorization tests, pgTAP). Every row records its evidence so a reviewer can verify it.
//
// Ratchet model: violations that exist today are frozen in docs/security/function-baseline.json.
// CI fails when (a) a NEW function violates a rule, (b) an existing function gains a violation,
// (c) a new function lacks a `declared` entry in docs/security/function-policy.json,
// (d) a declared auth mode is not backed by what the code actually does, or (e) the committed matrix is stale.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posix, readText, sortKeys, stripComments, walk } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------------------------
// Detection patterns (applied to comment-stripped source)
// ---------------------------------------------------------------------------------------------
const P = {
  jwtInFunction: [/\.auth\.getUser\s*\(/, /\.auth\.getClaims\s*\(/, /\bgetUser\s*\(\s*(?:jwt|token|bearer)/i],
  cronSecret: [/CRON_SECRET/, /x-cron-secret/i, /CRON_AUTH/],
  // Custom shared-secret header between Postgres/pg_net/vendors and the function (e.g. x-push-dispatch-secret, x-ovb-secret).
  sharedSecret: [/PUSH_DISPATCH_SECRET/, /headers\.get\(\s*["']x-[\w-]*secret["']/i, /[A-Z_]*WEBHOOK_SECRET/],
  apiKey: [/headers\.get\(\s*["'](?:x-api-key|apikey|x-vireek-key|x-device-key|x-[\w-]*-key)["']/i, /\bvrk_agent_/, /\bdevice_key(?:_hash)?\b/i, /\bapi_keys\b/, /\bbi_tokens\b/, /\bhashApiKey\b/, /\bverifyApiKey\b/, /\bkey_hash\b/, /\btoken_hash\b/, /startsWith\(\s*["']Bearer\s?["']\s*\)[\s\S]{0,200}sha256/i],
  // Unguessable capability in the URL/body (signed OAuth state, quote/portal/sink token). Not a session, still a credential.
  capabilityToken: [
    /\bSTATE_SECRET\b/, /\bverify\w*State\b/, /\bquote_token\b/, /\bsink_token\b/, /\bportal_token\b/, /\bshare_token\b/, /\.eq\(\s*["']\w*token\w*["']/, /\bUUID(?:_RE)?\.test\(\s*(?:token|id|plan\w*|link\w*)/,
    /searchParams\.get\(\s*["'](?:t|token|state)["']\s*\)/, /\bbody\??\.token\b/, /\bconst\s*\{[^}]*\btoken\b[^}]*\}\s*=\s*(?:await\s+req\.json\(\)|body)/,
  ],
  webhookSignature: [
    // Verification only. Plain "hmac"/"crypto.subtle.sign" are deliberately NOT matched: they also appear in OUTBOUND signing.
    /timingSafeEqual/, /\bverify\w*Signature\b/, /\bverify\w*Secret\b/, /\bverifyHmac\b/i, /constructEvent(?:Async)?\s*\(/,
    /headers\.get\(\s*["'](?:stripe-signature|x-twilio-signature|x-hub-signature(?:-256)?|x-slack-signature|x-signature|svix-signature|x-vapi-secret|x-webhook-secret|x-[\w-]*-signature)["']/i,
    /\bcrypto\.subtle\.verify\b/, /\bvalidateRequest\b/,
  ],
  webhookTimestamp: [/tolerance/i, /timestamp/i, /Math\.abs\([^)]*Date\.now\(\)/, /\bt=\d/],
  webhookReplay: [/\bnonce\b/i, /webhook_events?\b/, /\breplay\b/i, /\bprocessed_events?\b/, /\bevent_id\b/, /\bdedupe/i, /idempotency_key/i],
  rateLimit: [/\brate[_-]?limit/i, /\bcheckRate/i, /\bbi_begin_request\b/, /\bthrottle/i],
  zod: [/\bz\.object\s*\(/, /\.safeParse\s*\(/, /from\s+["'](?:npm:)?zod/, /from\s+["'](?:npm:)?valibot/],
  manualValidation: [
    /Array\.isArray\s*\(/, /typeof\s+[\w.[\]]+\s*[!=]==\s*["'](?:string|number|boolean|object)["']/, /\bisUuid\b/i, /\bUUID_RE\b/i,
    /\bvalidate\w*\s*\(/i, /\bparse\w*Body\s*\(/, /\bsanitize\w*\s*\(/i, /Payload too large|too large|413/,
  ],
  idempotency: [/idempoten/i, /onConflict/, /ignoreDuplicates/, /\bON CONFLICT\b/i, /\bdedup/i, /\bupsert\s*\(/, /\bnonce\b/i],
  corsWildcard: [/Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']/i, /["']Access-Control-Allow-Origin["']\s*:\s*["']\*["']/i],
  corsAllowlist: [/ALLOWED_ORIGINS/i, /allowedOrigins?/i, /originAllowed/i, /isAllowedOrigin/i, /corsFor\w*\s*\(/],
  corsAny: [/Access-Control-Allow-Origin/i, /\bcorsHeaders\b/],
  authzCheck: [
    /\bcanManage\b/, /\brole\s*[!=]==\s*["']/, /\baccount_owner_id\b/, /\bteam_members\b/, /\brequireRole\b/, /\bhas_role\b/,
    /\bis_admin\b/i, /\bisAdmin\b/, /\bplatform_admins?\b/, /\bget_account_owner_id\b/, /\bassertOwner\b/, /\brequireOwner\b/, /\bpermission/i,
  ],
  tenantScope: [
    /\.eq\(\s*["'](?:user_id|account_owner_id|owner_id|tenant_id|organization_id|org_id|company_id)["']/, /\.match\(\s*\{\s*(?:user_id|account_owner_id|owner_id)/,
    /\bp_(?:user|owner|tenant|org)_id\b/, /\baccount_owner_id\b/,
  ],
  userScopedClient: [/createClient\([^)]*SUPABASE_ANON_KEY/s, /global\s*:\s*\{\s*headers\s*:\s*\{\s*Authorization/s],
  serviceRole: [/SUPABASE_SERVICE_ROLE_KEY/, /SERVICE_ROLE/],
  // `if (expectedSecret && provided !== expectedSecret)` => request is accepted when the secret is NOT configured.
  failOpenSecret: [/if\s*\(\s*(?:expected\w*|\w*(?:Secret|SECRET|Token|TOKEN)\w*)\s*&&[^\n]{0,200}?(?:!==|!=)/],
  plainSecretCompare: [
    /(?:searchParams\.get|headers\.get)\(\s*["'][^"']*(?:secret|token|key)[^"']*["']\s*\)\s*(?:!==|===|!=|==)\s*\w*(?:[sS]ecret|[tT]oken|[kK]ey)/i,
    /\w*(?:[sS]ecret|[tT]oken)\w*\s*(?:!==|===)\s*Deno\.env\.get/,
  ],
  piiLog: [
    /console\.(?:log|info|warn|error|debug)\s*\([^;]{0,240}?(?:\bemail\b|\bphone\b|\bto_number\b|\bfrom_number\b|\bcustomer_?name\b|\baddress\b|\bpayload\b|\bbody\b|\btranscript\b|\bssn\b|\bdob\b|\btoken\b|JSON\.stringify\(\s*(?:body|payload|data|event|req))/si,
  ],
};

const SECRET_NAME = /(SECRET|_KEY$|TOKEN|PASSWORD|CREDENTIAL|SIGNING|PRIVATE|WEBHOOK_SIGN|AUTH_KEY)/;
const INBOUND_NAME = /(webhook|-callback$|-inbound$|-sink$|-ingest$|^sms-webhook|^voice-)/;

const RISK_RULES = [
  ["critical", /(^|-)(pay|payout|payouts|stripe|billing|invoice|invoices|refund|refunds|bank|capital|payroll|wallet|card|cards|dispute|disputes|checkout|payment|payments|instant)(-|$)/],
  ["critical", /(^|-)(admin|sso|mfa|impersonat\w*|scim|api-v1|auth|secrets?|keys?)(-|$)/],
  ["high", /(^|-)(sms|voice|call|calls|twilio|vapi|pbx|dialer|message|messages|messenger|email|mail|notify|alert|alerts|campaign|campaigns)(-|$)/],
  ["high", /(^|-)(export|exports|dsar|bi|siem|data-platform|download|import|erase|delete|purge|backup)(-|$)/],
  ["high", /(webhook|oauth)/],
];
const RISK_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

export function riskTier(name, flags) {
  let tier = "low";
  for (const [t, re] of RISK_RULES) if (re.test(name) && RISK_ORDER[t] < RISK_ORDER[tier]) tier = t;
  if (flags.serviceRole && flags.public && RISK_ORDER.high < RISK_ORDER[tier]) tier = "high";
  if (tier === "low" && (flags.serviceRole || flags.public)) tier = "medium";
  return tier;
}

// ---------------------------------------------------------------------------------------------
// config.toml
// ---------------------------------------------------------------------------------------------
export function parseVerifyJwt(configText) {
  const map = new Map();
  let current = null;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const sec = line.match(/^\[functions\.([^\].]+|"[^"]+")\]$/);
    if (sec) { current = sec[1].replace(/"/g, ""); continue; }
    if (line.startsWith("[")) { current = null; continue; }
    const kv = line.match(/^verify_jwt\s*=\s*(true|false)$/);
    if (kv && current) map.set(current, kv[1] === "true");
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// Source collection (function files + transitive local/_shared imports)
// ---------------------------------------------------------------------------------------------
const IMPORT_RE = /(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

const isTestFile = (f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f) || f.includes(`${path.sep}__tests__${path.sep}`);

/** Returns [{file, depth, text}] — the function's own non-test sources first, then imported modules. */
export function collectSources(fnDir, maxDepth = 3) {
  const seen = new Map();
  const queue = [];
  const own = walk(fnDir, (f) => /\.[cm]?tsx?$/.test(f) && !isTestFile(f));
  for (const f of own) queue.push([f, 0]);
  while (queue.length) {
    const [file, depth] = queue.shift();
    if (seen.has(file)) continue;
    const text = stripComments(readText(file));
    seen.set(file, { file, depth, text });
    if (depth >= maxDepth) continue;
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const target = spec && resolveImport(file, spec);
      if (target && !isTestFile(target) && !seen.has(target)) queue.push([target, depth + 1]);
    }
  }
  return [...seen.values()];
}

function find(sources, patterns) {
  const hits = [];
  for (const s of sources) {
    if (patterns.some((re) => re.test(s.text))) hits.push(s);
  }
  return hits;
}

const rel = (root, f) => posix(path.relative(root, f));

// ---------------------------------------------------------------------------------------------
// Per-function analysis
// ---------------------------------------------------------------------------------------------
export function analyzeFunction({ root, name, verifyJwt: cfgVerifyJwt, policy }) {
  const fnDir = path.join(root, "supabase", "functions", name);
  // config.toml is only part of the truth: many functions document `--no-verify-jwt` in their header and are deployed by hand.
  const rawIndex = readText(path.join(fnDir, "index.ts"));
  const headerNoVerify = rawIndex.split(/\r?\n/).some((l) => /--no-verify-jwt/.test(l) && !/\b(?:not|never|without|don'?t)\b[^\n]*--no-verify-jwt/i.test(l));
  const verifyJwt = cfgVerifyJwt && !headerNoVerify;
  const configDrift = headerNoVerify && cfgVerifyJwt; // documented as public, but config.toml would still enforce the gateway JWT
  const sources = collectSources(fnDir);
  const ownTexts = sources.filter((s) => s.depth === 0);
  const hit = (pats) => find(sources, pats);
  const ev = (list) => list.slice(0, 3).map((s) => rel(root, s.file));

  const jwtHits = hit(P.jwtInFunction);
  const cronHits = hit(P.cronSecret);
  const apiKeyHits = hit(P.apiKey);
  const sigHits = hit(P.webhookSignature);
  const capHits = hit(P.capabilityToken);
  const sharedHits = hit(P.sharedSecret);
    const zodHits = hit(P.zod);
  const manualHits = hit(P.manualValidation);
  const idemHits = hit(P.idempotency);
  const wildcardHits = hit(P.corsWildcard);
  const allowlistHits = hit(P.corsAllowlist);
  const corsAnyHits = hit(P.corsAny);
  const authzHits = hit(P.authzCheck);
  const tenantHits = hit(P.tenantScope);
  const userClientHits = hit(P.userScopedClient);
  const serviceHits = hit(P.serviceRole);
  const tsHits = hit(P.webhookTimestamp);
  const replayHits = hit(P.webhookReplay);
  const failOpenHits = hit(P.failOpenSecret);
  const plainCmpHits = hit(P.plainSecretCompare).filter((x) => !/timingSafeEqual/.test(x.text));
  const piiHits = ownTexts.filter((s) => P.piiLog.some((re) => re.test(s.text)));

  const authModes = [];
  if (jwtHits.length) authModes.push("jwt");
  if (verifyJwt && !jwtHits.length) authModes.push("gateway-jwt");
  if (cronHits.length) authModes.push("cron-secret");
  if (apiKeyHits.length) authModes.push("api-key");
  if (sigHits.length) authModes.push("webhook-signature");
  if (capHits.length) authModes.push("capability-token");
  if (sharedHits.length) authModes.push("shared-secret");
  const credentialed = authModes.some((m) => m !== "gateway-jwt");
  const isPublic = !verifyJwt && !credentialed;
  if (isPublic) authModes.push("public");

  const secrets = new Set();
  for (const s of sources) for (const m of s.text.matchAll(/Deno\.env\.get\(\s*["']([A-Z0-9_]+)["']\s*\)/g)) {
    if (SECRET_NAME.test(m[1])) secrets.add(m[1]);
  }

  // Tests: a test file inside the function dir ("own") or beside an imported _shared module ("shared").
  const ownTests = walk(fnDir, (f) => isTestFile(f)).length;
  let sharedTests = 0;
  for (const s of sources.filter((x) => x.depth > 0 && x.file.includes(`${path.sep}_shared${path.sep}`))) {
    const base = s.file.replace(/\.[cm]?tsx?$/, "");
    if (["test", "spec"].some((k) => fs.existsSync(`${base}.${k}.ts`))) sharedTests++;
  }
  const tests = ownTests > 0 ? "own" : sharedTests > 0 ? "shared" : "none";

  const inbound = INBOUND_NAME.test(name) || sigHits.length > 0 && !jwtHits.length;
  const corsPolicy = wildcardHits.length ? "wildcard" : allowlistHits.length ? "allowlist" : corsAnyHits.length ? "custom" : "none";
  const rateLimit = hit(P.rateLimit).length > 0;
  const validation = zodHits.length ? "schema" : manualHits.length ? "manual" : "none";
  const tenancy = userClientHits.length ? "rls-user-client"
    : serviceHits.length && tenantHits.length ? "service-role+scoped"
    : serviceHits.length ? "service-role-unscoped"
    : "none";

  const flags = { serviceRole: serviceHits.length > 0, public: isPublic };
  const declared = policy.declared?.[name] ?? null;
  const row = {
    name,
    risk: declared?.risk ?? riskTier(name, flags),
    verifyJwt,
    configDrift,
    authModes,
    inboundWebhook: inbound && (isPublic || sigHits.length > 0 || !verifyJwt),
    authorization: authzHits.length > 0,
    tenancy,
    rateLimit,
    validation,
    idempotency: idemHits.length > 0,
    cors: corsPolicy,
    piiLogRisk: piiHits.length > 0,
    failOpenSecret: failOpenHits.length > 0,
    plainSecretCompare: plainCmpHits.length > 0,
    secrets: [...secrets].sort(),
    tests,
    webhook: {
      signature: sigHits.length > 0,
      timestampTolerance: sigHits.length > 0 && tsHits.length > 0,
      replayStore: sigHits.length > 0 && replayHits.length > 0,
    },
    evidence: {
      jwt: ev(jwtHits), cron: ev(cronHits), apiKey: ev(apiKeyHits), signature: ev(sigHits), rateLimit: ev(hit(P.rateLimit)),
      validation: ev(zodHits.length ? zodHits : manualHits),
    },
  };
  row.violations = evaluateRules(row, declared);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Rules. severity: "error" gates NEW code; legacy hits are frozen in the baseline.
// ---------------------------------------------------------------------------------------------
export const RULES = {
  "no-auth": "verify_jwt=false but no JWT / cron-secret / API-key / signature check was found, and the function is not declared public.",
  "public-no-rate-limit": "Public endpoint without rate limiting.",
  "public-no-validation": "Public endpoint without any input validation.",
  "webhook-no-signature": "Inbound webhook without signature verification.",
  "webhook-no-replay": "Inbound webhook with a signature but no timestamp tolerance AND replay/idempotency store.",
  "gateway-jwt-only": "Relies on verify_jwt alone: the public anon key is a valid JWT, so any internet caller passes the gateway. Needs an in-function getUser/cron/service check.",
  "service-role-unscoped": "Uses the service-role key without any tenant scoping pattern (user_id/account_owner_id filter or tenant RPC arg).",
  "wildcard-cors-non-browser": "Wildcard CORS on a server-to-server endpoint (webhook/cron/api-key) that never needs a browser origin.",
  "config-drift": "Header says --no-verify-jwt but supabase/config.toml has no verify_jwt=false entry: the gateway would reject the provider unless the deploy command is remembered.",
  "fail-open-secret": "Shared secret is only enforced when configured (`if (secret && provided !== secret)`): an unset env var silently opens the endpoint.",
  "plain-secret-compare": "Secret/token compared with ===/!== instead of a constant-time comparison.",
  "no-tests": "No test file in the function directory or beside an imported _shared module.",
};

export function evaluateRules(row, declared) {
  const v = [];
  const declaredPublic = declared?.auth === "public";
  const m = new Set(row.authModes);
  const hasCred = [...m].some((x) => !["gateway-jwt", "public"].includes(x));
  if (!row.verifyJwt && !hasCred && !declaredPublic) v.push("no-auth");
  if (m.has("public") || declaredPublic) {
    if (!row.rateLimit) v.push("public-no-rate-limit");
    if (row.validation === "none") v.push("public-no-validation");
  }
  if (row.inboundWebhook && !row.verifyJwt && !row.webhook.signature && !m.has("cron-secret") && !m.has("shared-secret") && !m.has("api-key") && !declaredPublic) v.push("webhook-no-signature");
  if (row.webhook.signature && !(row.webhook.timestampTolerance && row.webhook.replayStore)) v.push("webhook-no-replay");
  if (m.has("gateway-jwt") && !m.has("jwt") && !m.has("cron-secret") && !m.has("api-key") && !m.has("webhook-signature") && !m.has("shared-secret")) v.push("gateway-jwt-only");
  if (row.tenancy === "service-role-unscoped" && !m.has("cron-secret")) v.push("service-role-unscoped");
  if (row.configDrift) v.push("config-drift");
  if (row.failOpenSecret) v.push("fail-open-secret");
  if (row.plainSecretCompare) v.push("plain-secret-compare");
  if (row.cors === "wildcard" && (m.has("cron-secret") || m.has("webhook-signature")) && !m.has("jwt") && !m.has("public")) v.push("wildcard-cors-non-browser");
  if (row.tests === "none") v.push("no-tests");
  return v.sort();
}

// ---------------------------------------------------------------------------------------------
// Whole-repo run
// ---------------------------------------------------------------------------------------------
export function loadPolicy(root) {
  const p = path.join(root, "docs", "security", "function-policy.json");
  return fs.existsSync(p) ? JSON.parse(readText(p)) : { version: 1, declared: {} };
}
export function loadBaseline(root) {
  const p = path.join(root, "docs", "security", "function-baseline.json");
  return fs.existsSync(p) ? JSON.parse(readText(p)) : { version: 1, functions: {} };
}

/** config.toml integrity: duplicate [functions.x] tables are invalid TOML; entries for deleted functions are stale. Never baselined. */
export function configIntegrity(root) {
  const cfgPath = path.join(root, "supabase", "config.toml");
  if (!fs.existsSync(cfgPath)) return [];
  const seen = new Map();
  const problems = [];
  const existing = new Set(listFunctions(root));
  readText(cfgPath).split(/\r?\n/).forEach((raw, i) => {
    const m = raw.replace(/#.*$/, "").trim().match(/^\[functions\.([^\].]+|"[^"]+")\]$/);
    if (!m) return;
    const fn = m[1].replace(/"/g, "");
    if (seen.has(fn)) problems.push(`supabase/config.toml:${i + 1}: duplicate table [functions.${fn}] (first at line ${seen.get(fn)}) — duplicate TOML tables are invalid.`);
    else seen.set(fn, i + 1);
    if (!existing.has(fn)) problems.push(`supabase/config.toml:${i + 1}: [functions.${fn}] has no supabase/functions/${fn}/index.ts.`);
  });
  return problems;
}

/** Rewrites config.toml text: drops duplicate/stale [functions.x] tables and appends verify_jwt=false for header-declared public functions. */
export function fixConfigText(text, existing, driftNames) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = { header: null, lines: [] };
  for (const l of lines) {
    if (/^\s*\[/.test(l.replace(/#.*$/, ""))) { blocks.push(cur); cur = { header: l.replace(/#.*$/, "").trim(), lines: [l] }; }
    else cur.lines.push(l);
  }
  blocks.push(cur);
  const seen = new Set();
  const out = [];
  for (const b of blocks) {
    const m = b.header?.match(/^\[functions\.([^\].]+|"[^"]+")\]$/);
    if (m) {
      const fn = m[1].replace(/"/g, "");
      if (!existing.has(fn) || seen.has(fn)) continue;
      seen.add(fn);
    }
    out.push(b.lines.join("\n").replace(/\n+$/, ""));
  }
  const body = out.filter((x) => x.trim() !== "").join("\n");
  const add = [...driftNames].filter((n) => !seen.has(n)).sort().map((n) => `[functions.${n}]\nverify_jwt = false`);
  return `${body}${add.length ? `\n\n# verify_jwt = false is declared in each function header (added by scripts/security/function-matrix.mjs --fix-config)\n${add.join("\n")}` : ""}\n`;
}

export function listFunctions(root) {
  const dir = path.join(root, "supabase", "functions");
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && fs.existsSync(path.join(dir, e.name, "index.ts")))
    .map((e) => e.name).sort();
}

export function buildMatrix(root = DEFAULT_ROOT) {
  const cfgPath = path.join(root, "supabase", "config.toml");
  const jwtCfg = fs.existsSync(cfgPath) ? parseVerifyJwt(readText(cfgPath)) : new Map();
  const policy = loadPolicy(root);
  const rows = listFunctions(root).map((name) =>
    analyzeFunction({ root, name, verifyJwt: jwtCfg.has(name) ? jwtCfg.get(name) : true, policy }));
  return { rows, policy };
}

// ---------------------------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------------------------
const REQUIRED_DECLARED = ["auth", "risk", "owner"];
const AUTH_VALUES = new Set(["jwt", "gateway-jwt", "cron-secret", "api-key", "webhook-signature", "capability-token", "shared-secret", "public"]);

export function gate(rows, policy, baseline, root = null) {
  const errors = [];
  const legacy = baseline.functions ?? {};
  for (const r of rows) {
    const accepted = new Set(legacy[r.name] ?? []);
    const isLegacy = Object.hasOwn(legacy, r.name);
    const declared = policy.declared?.[r.name];
    if (!isLegacy) {
      if (!declared) {
        errors.push(`${r.name}: new function has no entry in docs/security/function-policy.json "declared" (required: ${REQUIRED_DECLARED.join(", ")}).`);
      } else {
        for (const k of REQUIRED_DECLARED) if (!declared[k]) errors.push(`${r.name}: declared.${k} is missing.`);
        if (declared.auth && !AUTH_VALUES.has(declared.auth)) errors.push(`${r.name}: declared.auth "${declared.auth}" is not one of ${[...AUTH_VALUES].join("|")}.`);
        if (declared.auth && !r.authModes.includes(declared.auth)) errors.push(`${r.name}: declared auth "${declared.auth}" is not backed by the code (detected: ${r.authModes.join(", ") || "none"}).`);
        if (declared.auth === "public" && !declared.justification) errors.push(`${r.name}: public functions need declared.justification.`);
      }
    }
    for (const rule of r.violations) {
      if (!accepted.has(rule)) errors.push(`${r.name}: violates "${rule}" — ${RULES[rule]}${isLegacy ? " (new regression on a legacy function)" : ""}`);
    }
  }
  if (root) errors.push(...configIntegrity(root));
  const names = new Set(rows.map((r) => r.name));
  for (const n of Object.keys(legacy)) if (!names.has(n)) errors.push(`baseline lists "${n}" but the function no longer exists — run --update-baseline.`);
  return errors;
}

export function makeBaseline(rows, previous) {
  const prevNames = new Set(Object.keys(previous.functions ?? {}));
  const functions = {};
  for (const r of rows) {
    // Only functions that already existed (or were baselined before) are frozen; brand-new ones must pass cleanly.
    if (prevNames.size === 0 || prevNames.has(r.name)) functions[r.name] = r.violations;
  }
  return { version: 1, note: "Frozen legacy violations. Only ever shrink this file. Generated by scripts/security/function-matrix.mjs --update-baseline.", functions };
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const MODE_CODE = { jwt: "JWT", "gateway-jwt": "GW-JWT", "cron-secret": "CRON", "api-key": "KEY", "webhook-signature": "SIG", "capability-token": "CAP", "shared-secret": "SECRET", public: "PUBLIC" };
const yn = (b) => (b ? "✔" : "✘");

export function summarize(rows) {
  const c = (f) => rows.filter(f).length;
  const rules = {};
  for (const r of rows) for (const v of r.violations) rules[v] = (rules[v] ?? 0) + 1;
  return {
    functions: rows.length,
    verifyJwtFalse: c((r) => !r.verifyJwt),
    inFunctionJwt: c((r) => r.authModes.includes("jwt")),
    gatewayJwtOnly: c((r) => r.violations.includes("gateway-jwt-only")),
    cronSecret: c((r) => r.authModes.includes("cron-secret")),
    apiKey: c((r) => r.authModes.includes("api-key")),
    webhookSignature: c((r) => r.webhook.signature),
    inboundWebhooks: c((r) => r.inboundWebhook),
    webhooksWithReplayProtection: c((r) => r.webhook.signature && r.webhook.timestampTolerance && r.webhook.replayStore),
    publicEndpoints: c((r) => r.authModes.includes("public")),
    rateLimited: c((r) => r.rateLimit),
    schemaValidation: c((r) => r.validation === "schema"),
    manualValidation: c((r) => r.validation === "manual"),
    noValidation: c((r) => r.validation === "none"),
    wildcardCors: c((r) => r.cors === "wildcard"),
    piiLogReview: c((r) => r.piiLogRisk),
    testsOwn: c((r) => r.tests === "own"),
    testsShared: c((r) => r.tests === "shared"),
    testsNone: c((r) => r.tests === "none"),
    ruleViolations: rules,
  };
}

export function renderMarkdown(rows, summary) {
  const L = [];
  L.push("# Function security matrix", "");
  L.push("> Generated by `node scripts/security/function-matrix.mjs --write` — do not edit by hand. Deterministic; CI fails when this file is stale.");
  L.push("> **Static heuristic.** Each cell is derived from regex evidence over the function and the `_shared` modules it imports (≤3 levels). It is an inventory and a ratchet, not a proof. Evidence paths per function are in `function-matrix.json`.", "");
  L.push("## Summary", "");
  L.push("| Metric | Count |", "|---|---:|");
  const labels = {
    functions: "Edge functions", verifyJwtFalse: "verify_jwt = false", inFunctionJwt: "In-function JWT check (getUser)", gatewayJwtOnly: "Gateway-JWT only (anon key passes)",
    cronSecret: "Cron secret", apiKey: "API key / token", webhookSignature: "Signature verification", inboundWebhooks: "Inbound webhooks",
    webhooksWithReplayProtection: "Webhooks with timestamp tolerance + replay store", publicEndpoints: "Public endpoints (no credential)", rateLimited: "Rate limited",
    schemaValidation: "Schema validation (zod/valibot)", manualValidation: "Manual validation only", noValidation: "No validation detected", wildcardCors: "Wildcard CORS",
    piiLogReview: "Logging statements to review for PII", testsOwn: "Own tests", testsShared: "Tests only via shared module", testsNone: "No tests",
  };
  for (const [k, label] of Object.entries(labels)) L.push(`| ${label} | ${summary[k]} |`);
  L.push("", "### Rule violations (legacy frozen in baseline; new ones fail CI)", "", "| Rule | Functions | Meaning |", "|---|---:|---|");
  for (const [rule, n] of Object.entries(summary.ruleViolations).sort((a, b) => b[1] - a[1])) L.push(`| \`${rule}\` | ${n} | ${RULES[rule]} |`);

  const section = (title, filter) => {
    const list = rows.filter(filter);
    L.push("", `## ${title} (${list.length})`, "");
    if (!list.length) { L.push("_None._"); return; }
    L.push(list.map((r) => `\`${r.name}\``).join(", "));
  };
  section("Inbound webhooks WITHOUT signature verification", (r) => r.violations.includes("webhook-no-signature"));
  section("Signed webhooks WITHOUT timestamp tolerance + replay store", (r) => r.violations.includes("webhook-no-replay"));
  section("Public endpoints without rate limit", (r) => r.violations.includes("public-no-rate-limit"));
  section("Critical/high-risk functions relying only on the gateway JWT", (r) => r.violations.includes("gateway-jwt-only") && ["critical", "high"].includes(r.risk));

  L.push("", "## Matrix", "", "Legend — Auth: JWT = in-function `getUser`; GW-JWT = gateway `verify_jwt` only; CRON; KEY; SIG; CAP = unguessable token/signed state; SECRET = shared-secret header; PUBLIC = no credential detected. Tenancy: `rls` = user-scoped client, `svc+scope` = service role with owner filter, `svc!` = service role without detected scoping. Val: schema / manual / none. CORS: `*` wildcard, `allow` allowlist, `cust` custom, `–` none. Tests: own / shared / none.", "");
  L.push("| Function | Risk | Auth | Authz | Tenancy | RL | Val | Idem | CORS | PII-log | Secrets | Tests | Webhook (sig/ts/replay) | Violations |");
  L.push("|---|---|---|:-:|---|:-:|---|:-:|---|:-:|---|---|---|---|");
  const order = [...rows].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || b.violations.length - a.violations.length || a.name.localeCompare(b.name));
  const tenancyCode = { "rls-user-client": "rls", "service-role+scoped": "svc+scope", "service-role-unscoped": "svc!", none: "–" };
  const corsCode = { wildcard: "*", allowlist: "allow", custom: "cust", none: "–" };
  for (const r of order) {
    const wh = r.inboundWebhook || r.webhook.signature ? `${yn(r.webhook.signature)}/${yn(r.webhook.timestampTolerance)}/${yn(r.webhook.replayStore)}` : "–";
    L.push(`| \`${r.name}\` | ${r.risk} | ${r.authModes.map((m) => MODE_CODE[m]).join("+") || "–"} | ${yn(r.authorization)} | ${tenancyCode[r.tenancy]} | ${yn(r.rateLimit)} | ${r.validation} | ${yn(r.idempotency)} | ${corsCode[r.cors]} | ${r.piiLogRisk ? "review" : "–"} | ${r.secrets.length ? r.secrets.join(", ") : "–"} | ${r.tests} | ${wh} | ${r.violations.join(", ") || "–"} |`);
  }
  L.push("");
  return L.join("\n");
}

export function renderJson(rows, summary) {
  return `${JSON.stringify(sortKeys({ version: 1, summary, functions: rows }), null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function main() {
  const args = new Set(process.argv.slice(2));
  const root = DEFAULT_ROOT;
  const { rows, policy } = buildMatrix(root);
  const summary = summarize(rows);
  const md = renderMarkdown(rows, summary);
  const json = renderJson(rows, summary);
  const mdPath = path.join(root, "docs", "security", "function-matrix.md");
  const jsonPath = path.join(root, "docs", "security", "function-matrix.json");
  const basePath = path.join(root, "docs", "security", "function-baseline.json");

  if (args.has("--fix-config")) {
    const cfgPath = path.join(root, "supabase", "config.toml");
    const next = fixConfigText(readText(cfgPath), new Set(listFunctions(root)), rows.filter((r) => r.configDrift).map((r) => r.name));
    fs.writeFileSync(cfgPath, next);
    console.log("supabase/config.toml rewritten: duplicates/stale removed, header-declared --no-verify-jwt functions added. Review with git diff.");
    return;
  }
  if (args.has("--emit-config")) {
    // Append-ready TOML for functions documented as --no-verify-jwt but absent from config.toml (fixes `config-drift`).
    const blocks = rows.filter((r) => r.configDrift).map((r) => `[functions.${r.name}]\nverify_jwt = false\n`);
    process.stdout.write(blocks.length ? `\n# --- verify_jwt = false declared in each function header (generated by scripts/security/function-matrix.mjs --emit-config) ---\n${blocks.join("")}` : "");
    return;
  }
  if (args.has("--update-baseline")) {
    const next = makeBaseline(rows, loadBaseline(root));
    fs.mkdirSync(path.dirname(basePath), { recursive: true });
    fs.writeFileSync(basePath, `${JSON.stringify(sortKeys(next), null, 2)}\n`);
    console.log(`baseline written: ${Object.keys(next.functions).length} functions`);
  }
  if (args.has("--write") || args.has("--update-baseline")) {
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    fs.writeFileSync(mdPath, md);
    fs.writeFileSync(jsonPath, json);
    console.log(`wrote ${posix(path.relative(root, mdPath))} and ${posix(path.relative(root, jsonPath))} (${rows.length} functions)`);
    return;
  }
  if (args.has("--check")) {
    const errors = gate(rows, policy, loadBaseline(root), root);
    const stale = ["md", "json"].filter((k) => {
      const p = k === "md" ? mdPath : jsonPath;
      return !fs.existsSync(p) || readText(p) !== (k === "md" ? md : json);
    });
    if (stale.length) errors.push(`docs/security/function-matrix.${stale.join(" / .")} is stale — run: node scripts/security/function-matrix.mjs --write`);
    if (errors.length) {
      console.error(`Function security gate FAILED (${errors.length}):`);
      for (const e of errors) console.error(`  - ${e}`);
      process.exit(1);
    }
    console.log(`Function security gate passed (${rows.length} functions, ${Object.keys(loadBaseline(root).functions).length} legacy baselined).`);
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
