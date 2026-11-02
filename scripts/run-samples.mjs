#!/usr/bin/env node
/**
 * Executes every documented code sample for real.
 *
 *   node scripts/run-samples.mjs [--allow-missing]
 *
 * 1. API samples (cURL / JavaScript / Python / Go) for every operation run against a local
 *    mock server built from the contract (same router, same fixtures, same error bodies).
 * 2. Webhook signature-verification samples (JavaScript / Python / Go) verify a body signed
 *    exactly like supabase/functions/event-bus-dispatch (HMAC-SHA256, hex) and must reject
 *    a tampered body, a wrong secret and a missing header.
 * 3. Static guards tie the webhook docs to event-bus-dispatch and its migration.
 *
 * Needs Node >= 22.18 (native TypeScript), curl, python3 + `requests`, and Go.
 * `--allow-missing` turns a missing toolchain into a SKIP (local use). CI must not pass it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowMissing = process.argv.includes('--allow-missing');
const TEST_KEY = 'vrk_live_ci_sample_key';
const SIGNING_SECRET = 'whsec_ci_sample_secret';

const c = await import(pathToFileURL(resolve(ROOT, 'supabase/functions/api-v1/contract.ts')).href);

let failures = 0;
let skipped = 0;
let passed = 0;
const ok = (msg) => (passed++, console.log(`✔ ${msg}`));
const bad = (msg, detail = '') => {
  failures++;
  console.error(
    `✖ ${msg}${detail ? `\n    ${String(detail).trim().replaceAll('\n', '\n    ')}` : ''}`,
  );
  if (process.env.GITHUB_ACTIONS === 'true')
    console.log(`::error title=Code sample failed::${msg}`);
};

/* ---------------- mock API (contract-derived) ---------------- */

const seen = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const auth = req.headers.authorization ?? '';
  seen.push({ path: url.pathname, auth });
  const rid = '00000000-0000-4000-8000-000000000000';
  if (req.method !== 'GET')
    return send(405, c.errorBody('method_not_allowed', 'Method not allowed', rid));
  if (auth !== `Bearer ${TEST_KEY}`)
    return send(401, c.errorBody('invalid_api_key', 'Invalid or revoked API key', rid));
  const route = c.resolveRoute(url.pathname);
  if (route.kind !== 'ok')
    return send(404, c.errorBody('route_not_found', c.NOT_FOUND_MESSAGE, rid));
  const def = c.RESOURCES.find((r) => r.name === route.resource);
  const example = c.SCHEMA_EXAMPLES[def.schema];
  if (route.id !== null) return send(200, { data: example });
  return send(200, { data: [example], has_more: false, next_before: null });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api-v1`;

const work = mkdtempSync(join(tmpdir(), 'vireek-samples-'));

// Async on purpose: the mock server lives in this process, so the event loop must stay free.
function run(cmd, args, { cwd = work, env = {} } = {}) {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, VIREEK_API_KEY: TEST_KEY, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ missing: err.code === 'ENOENT', stdout, stderr: String(err), status: null });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      done({ missing: false, stdout, stderr, status });
    });
  });
}

function runner(id, dir, file) {
  switch (id) {
    case 'curl':
      return ['sh', [join(dir, file)]];
    case 'javascript':
      return [process.execPath, [join(dir, file)]];
    case 'python':
      return ['python3', ['-I', join(dir, file)]];
    case 'go':
      return ['go', ['run', join(dir, file)]];
    default:
      throw new Error(`unknown lang ${id}`);
  }
}
const EXT = { curl: 'sh', javascript: 'mjs', python: 'py', go: 'go' };

async function execute(label, cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.missing) {
    if (allowMissing) {
      skipped++;
      console.log(`↷ ${label} — ${cmd} not installed (skipped)`);
      return null;
    }
    bad(label, `${cmd} is not installed`);
    return null;
  }
  return r;
}

/* ---------------- 1. API samples ---------------- */

let idx = 0;
for (const op of c.listOperations()) {
  const def = c.RESOURCES.find((r) => r.name === op.resource);
  const exampleId = c.SCHEMA_EXAMPLES[def.schema].id;
  const url = op.hasId ? `${BASE}/${op.resource}/${exampleId}` : `${BASE}/${op.resource}?limit=25`;
  for (const sample of c.buildCodeSamples(url)) {
    const label = `${op.id} [${sample.label}]`;
    const dir = join(work, `s${idx++}`);
    mkdirSync(dir);
    const file = `sample.${EXT[sample.id]}`;
    writeFileSync(join(dir, file), sample.source + '\n');
    const [cmd, args] = runner(sample.id, dir, file);
    const r = await execute(label, cmd, args);
    if (!r) continue;
    if (r.status !== 0) {
      bad(label, r.stderr || r.stdout);
      continue;
    }
    try {
      const body = JSON.parse(r.stdout);
      const shapeOk = op.hasId
        ? body.data?.id === exampleId
        : Array.isArray(body.data) && typeof body.has_more === 'boolean' && 'next_before' in body;
      shapeOk ? ok(label) : bad(label, `unexpected response shape: ${r.stdout.slice(0, 200)}`);
    } catch {
      bad(label, `stdout is not JSON: ${r.stdout.slice(0, 200)}`);
    }
  }
}
const wrongAuth = seen.filter((s) => s.auth !== `Bearer ${TEST_KEY}`);
wrongAuth.length
  ? bad(
      'samples must send the key from VIREEK_API_KEY',
      `${wrongAuth.length} request(s) had a different Authorization header`,
    )
  : ok('every sample authenticated with the key from VIREEK_API_KEY');

/* ---------------- 2. Webhook verification samples ---------------- */

// Mirrors signPayload() in supabase/functions/event-bus-dispatch/index.ts (WebCrypto, HMAC-SHA256, hex).
async function sign(secret, payload) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const event = c.WEBHOOK_EVENTS[0];
const body = JSON.stringify(c.webhookSample(event));
const goodSig = await sign(SIGNING_SECRET, body);
const cases = [
  { name: 'valid signature', body, sig: goodSig, secret: SIGNING_SECRET, expect: true },
  {
    name: 'tampered body',
    body: body.replace('call.created', 'call.deleted'),
    sig: goodSig,
    secret: SIGNING_SECRET,
    expect: false,
  },
  { name: 'wrong secret', body, sig: goodSig, secret: 'whsec_other', expect: false },
  { name: 'missing header', body, sig: '', secret: SIGNING_SECRET, expect: false },
];

const harness = {
  javascript: (src) =>
    `${src}\nconst [raw, sig, secret] = process.argv.slice(2);\nconsole.log(String(verifyVireekSignature(raw, sig, secret)));\n`,
  python: (src) =>
    `${src}\n\nimport sys\n\nprint(verify_vireek_signature(sys.argv[1].encode(), sys.argv[2], sys.argv[3]))\n`,
};
const goMain =
  'package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc main() {\n\tfmt.Println(VerifyVireekSignature([]byte(os.Args[1]), os.Args[2], os.Args[3]))\n}\n';

for (const sample of c.WEBHOOK_VERIFY_SAMPLES) {
  const dir = join(work, `v-${sample.id}`);
  mkdirSync(dir);
  let files;
  if (sample.id === 'go') {
    writeFileSync(join(dir, 'verify.go'), sample.source + '\n');
    writeFileSync(join(dir, 'main.go'), goMain);
    files = ['go', ['run', join(dir, 'verify.go'), join(dir, 'main.go')]];
  } else {
    const file = `verify.${EXT[sample.id]}`;
    writeFileSync(join(dir, file), harness[sample.id](sample.source));
    files =
      sample.id === 'javascript'
        ? [process.execPath, [join(dir, file)]]
        : ['python3', ['-I', join(dir, file)]];
  }
  for (const t of cases) {
    const label = `webhook verify [${sample.label}] ${t.name}`;
    const r = await execute(label, files[0], [...files[1], t.body, t.sig, t.secret]);
    if (!r) continue;
    if (r.status !== 0) {
      bad(label, r.stderr || r.stdout);
      continue;
    }
    const got = r.stdout.trim().toLowerCase() === 'true';
    got === t.expect ? ok(label) : bad(label, `expected ${t.expect}, got ${got}`);
  }
}

/* ---------------- 2b. Quickstarts: run each guide's script end to end ---------------- */

const qs = await import(
  pathToFileURL(resolve(ROOT, 'supabase/functions/api-v1/quickstarts.ts')).href
);
for (const q of qs.QUICKSTARTS) {
  const label = `quickstart "${q.id}" [${q.language}]`;
  if (/vrk_(live|test)_[A-Za-z0-9]/.test(q.code)) {
    bad(label, 'contains a hard-coded API key');
    continue;
  }
  const dir = join(work, `q-${q.id}`);
  mkdirSync(dir);
  writeFileSync(join(dir, q.filename), q.code + '\n');
  const [cmd, args] =
    q.language === 'python'
      ? ['python3', ['-I', join(dir, q.filename)]]
      : [process.execPath, [join(dir, q.filename)]];
  const r = await execute(label, cmd, args, { cwd: dir, env: { VIREEK_BASE_URL: BASE } });
  if (!r) continue;
  if (r.status !== 0) bad(label, r.stderr || r.stdout);
  else if (!/^OK: /m.test(r.stdout))
    bad(label, `no "OK:" line in output: ${r.stdout.slice(0, 200)}`);
  else ok(label);
}

/* ---------------- 3. Static guards: docs ↔ webhook sender ---------------- */

const sender = readFileSync(
  resolve(ROOT, 'supabase/functions/event-bus-dispatch/index.ts'),
  'utf8',
);
const migration = readFileSync(
  resolve(ROOT, 'supabase/migrations/20260924000000_developer_platform_event_bus.sql'),
  'utf8',
);
const guard = (cond, msg) => (cond ? ok(msg) : bad(msg));
guard(
  sender.includes(`"${c.WEBHOOK_SIGNATURE_HEADER}"`),
  `sender sets ${c.WEBHOOK_SIGNATURE_HEADER}`,
);
guard(
  sender.includes(`"${c.WEBHOOK_DELIVERY_HEADER}"`),
  `sender sets ${c.WEBHOOK_DELIVERY_HEADER}`,
);
guard(/name:\s*"HMAC",\s*hash:\s*"SHA-256"/.test(sender), 'sender signs with HMAC-SHA256');
guard(
  new RegExp(`MAX_ATTEMPTS\\s*=\\s*${c.WEBHOOK_DELIVERY_POLICY.maxAttempts}\\b`).test(sender),
  `retry policy: MAX_ATTEMPTS = ${c.WEBHOOK_DELIVERY_POLICY.maxAttempts}`,
);
guard(
  new RegExp(`FETCH_TIMEOUT_MS\\s*=\\s*${c.WEBHOOK_DELIVERY_POLICY.timeoutSeconds}_?000\\b`).test(
    sender,
  ),
  `delivery timeout = ${c.WEBHOOK_DELIVERY_POLICY.timeoutSeconds}s`,
);
const allowed =
  /events <@ ARRAY\[([\s\S]*?)\]::text\[\]/
    .exec(migration)?.[1]
    .match(/'([a-z_.]+)'/g)
    ?.map((s) => s.slice(1, -1)) ?? [];
const cataloged = c.WEBHOOK_EVENTS.map((w) => w.event);
guard(
  allowed.length > 0 &&
    allowed.every((e) => cataloged.includes(e)) &&
    cataloged.every((e) => allowed.includes(e)),
  `webhook catalog lists exactly the events the database allows (${allowed.length})`,
);

server.close();
rmSync(work, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failures} failed, ${skipped} skipped`);
process.exit(failures ? 1 : 0);
