#!/usr/bin/env node
// scripts/ai-governance/inventory.mjs
//
// AI system register: scans the repo for every AI / model call site and keeps
// docs/ai-governance/ai-system-register.md in step with the code.
//
//   node scripts/ai-governance/inventory.mjs            regenerate the register (human-filled cells are kept)
//   node scripts/ai-governance/inventory.mjs --check    CI gate: exit 1 when an AI call site is NOT in the register
//   node scripts/ai-governance/inventory.mjs --check --strict
//                                                       also fail on stale rows, an out-of-date register and overdue reviews
//   node scripts/ai-governance/inventory.mjs --json     print the raw scan (no file written)
//   --today=YYYY-MM-DD                                  override "today" (tests)
//
// What counts as an AI call site (static, evidence-based; see docs/ai-governance/ai-policy.md):
//   gateway          askVireekAi / askVireekAiStream / routeChat / routeChatStream outside the gateway itself
//   provider-adapter a provider adapter inside supabase/functions/_shared/ai-core/providers/
//   direct-provider  a provider host / API-key env var / SDK referenced outside the adapters
//   browser-speech   Web Speech API (SpeechRecognition / speechSynthesis) in front-end code
//
// A file can opt out with a reviewed marker (reason is mandatory):
//   // ai-inventory: ignore <reason>
//
// This tool is an inventory aid. It does NOT classify risk, assess legality or certify anything.
// Risk class stays "[COUNSEL]" until a human with the right authority fills it in.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Configuration (edit here when a new provider / pattern must be recognised)
// ---------------------------------------------------------------------------------------------

export const REGISTER_PATH = 'docs/ai-governance/ai-system-register.md';
export const REGISTRY_TS = 'supabase/functions/_shared/ai-core/registry.ts';
export const PROVIDERS_DIR = 'supabase/functions/_shared/ai-core/providers/';
export const GATEWAY_DEFINITION_FILES = [
  'supabase/functions/_shared/ai-core/index.ts', // defines askVireekAi / askVireekAiStream
  'supabase/functions/_shared/ai-core/router.ts', // defines routeChat / routeChatStream
];
export const REVIEW_MAX_DAYS = 183; // proposed cadence: at least every ~6 months (see ai-policy.md) [COUNSEL to confirm]

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_DIRS = new Set(['node_modules', 'dist', 'dist-home', 'build', 'coverage', '.git', 'android', 'ios', '.next', '.vercel']); // at any depth
const IGNORE_ROOT_DIRS = new Set(['public', 'docs', 'knowledge', 'content']); // repo root only, so src/**/docs etc. are still scanned
const TEST_FILE = /(\.test\.|\.spec\.|\.live\.|\.redteam\.|\.built\.test\.|\/__tests__\/|\/__mocks__\/|testkit\.|memoryPorts\.)/;
// Files that only CONTAIN provider names as data (detectors / catalogues). Never call a model.
export const SELF_EXCLUDED = [
  'scripts/ai-governance/',
  'scripts/check-direct-llm-calls.mjs',
  'scripts/compliance/gen-subprocessors-by-region.mjs',
  'scripts/data/function-headers.mjs', // header-comment text catalogue, not code that calls a provider
];

const PLACEHOLDER_OWNER = '[OWNER: fill]';
const PLACEHOLDER_RISK = '[COUNSEL]';
const PLACEHOLDER_REVIEW = '[REVIEW DATE: fill]';
const VERIFY = ' [VERIFY]';

/** Provider catalogue. `re` is matched against comment-stripped source. */
export const PROVIDERS = [
  { id: 'gemini', name: 'Google Gemini API', re: /generativelanguage\.googleapis\.com|\bGEMINI_API_KEYS?\b/ },
  { id: 'openai', name: 'OpenAI', re: /api\.openai\.com|\bOPENAI_API_KEYS?\b|from\s+['"](?:npm:)?openai['"]/ },
  { id: 'anthropic', name: 'Anthropic', re: /api\.anthropic\.com|\bANTHROPIC_API_KEYS?\b|@anthropic-ai\/sdk/ },
  { id: 'groq', name: 'Groq', re: /api\.groq\.com|\bGROQ_API_KEYS?\b/ },
  { id: 'cerebras', name: 'Cerebras', re: /api\.cerebras\.ai|\bCEREBRAS_API_KEYS?\b/ },
  { id: 'openrouter', name: 'OpenRouter', re: /openrouter\.ai|\bOPENROUTER_API_KEYS?\b/ },
  { id: 'cohere', name: 'Cohere', re: /api\.cohere\.(?:ai|com)|\bCOHERE_API_KEYS?\b/ },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', re: /api\.cloudflare\.com[^'"`\n]*\/ai\/run|\/ai\/run\/|\.AI\.run\(|\bCLOUDFLARE_AI_[A-Z_]+\b/ },
  { id: 'vapi', name: 'Vapi (voice agent platform)', re: /api\.vapi\.ai|\bVAPI_API_KEYS?\b|\bVAPI_PRIVATE_KEY\b/ },
  { id: 'elevenlabs', name: 'ElevenLabs (TTS / voice cloning)', re: /api\.elevenlabs\.io|\bELEVENLABS_API_KEYS?\b/ },
  { id: 'deepgram', name: 'Deepgram', re: /api\.deepgram\.com|\bDEEPGRAM_API_KEYS?\b/ },
  { id: 'assemblyai', name: 'AssemblyAI', re: /api\.assemblyai\.com|\bASSEMBLYAI_API_KEYS?\b/ },
  { id: 'mistral', name: 'Mistral AI', re: /api\.mistral\.ai|\bMISTRAL_API_KEYS?\b/ },
  { id: 'xai', name: 'xAI', re: /api\.x\.ai|\bXAI_API_KEYS?\b/ },
  { id: 'perplexity', name: 'Perplexity', re: /api\.perplexity\.ai|\bPERPLEXITY_API_KEYS?\b/ },
  { id: 'together', name: 'Together AI', re: /api\.together\.xyz|\bTOGETHER_API_KEYS?\b/ },
  { id: 'huggingface', name: 'Hugging Face Inference', re: /api-inference\.huggingface\.co|router\.huggingface\.co|\bHF_API_TOKEN\b/ },
  { id: 'replicate', name: 'Replicate', re: /api\.replicate\.com|\bREPLICATE_API_TOKEN\b/ },
];
const PROVIDER_NAME = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.name]));

const SPEECH_RE = /\b(?:webkitSpeechRecognition|SpeechRecognition|speechSynthesis)\b/;
const GATEWAY_CALL_RE = /\b(askVireekAiStream|askVireekAi|routeChatStream|routeChat)\s*\(/g;
const IGNORE_MARKER_RE = /ai-inventory:\s*ignore\s+(\S.*)/;

/** Heuristic keyword signals for the "Data it sees" column. Signals only, never facts. */
const SIGNALS = [
  ['audio / voice / transcripts', /\b(?:audio|recording|voice|speech|transcri\w*)\b/i],
  ['images / documents (vision, OCR)', /\b(?:inlineData|inline_data|image|photo|vision|nameplate|ocr|receipt)\b/i],
  ['customer / caller identifiers', /\b(?:customer|caller|homeowner|phone|email)s?\b/i],
  ['financial / pricing data', /\b(?:invoice|payment|bank|expense|ledger|price|pricing|estimate|quote)s?\b/i],
  ['staff / technician data', /\b(?:technician|employee|payroll|staff|crew)s?\b/i],
  ['free-text user input', /\b(?:messages|question|prompt|userInput|transcript)\b/i],
];

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

const toPosix = (p) => p.split(sep).join('/');

/** Remove comments so a provider hostname in a doc-comment is not an AI call site. Keeps `://` intact. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

/** Reviewed opt-out. Returns the reason, or null. A marker without a reason does not count. */
export function ignoreReason(src) {
  const m = IGNORE_MARKER_RE.exec(src);
  return m ? m[1].trim() : null;
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/** Resolve the TaskType used by a gateway call: literal, `task: CONST`, `task,` shorthand, or first arg of routeChat. */
export function resolveTask(code, matchIndex, callName) {
  const consts = new Map();
  for (const m of code.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*["'`]([a-z][a-z0-9_]*)["'`]/g)) consts.set(m[1], m[2]);
  const window = code.slice(matchIndex, matchIndex + 900);
  const open = window.indexOf('(');
  const args = window.slice(open + 1);
  const viaConst = (name) => consts.get(name) ?? null;

  if (callName.startsWith('routeChat')) {
    const first = /^\s*(?:["'`]([a-z][a-z0-9_]*)["'`]|([A-Za-z_$][\w$]*))/.exec(args);
    if (first) return first[1] ?? viaConst(first[2]);
    return null;
  }
  const lit = /\btask\s*:\s*["'`]([a-z][a-z0-9_]*)["'`]/.exec(args);
  if (lit) return lit[1];
  const ref = /\btask\s*:\s*([A-Za-z_$][\w$]*)\s*[,}\s]/.exec(args);
  if (ref) return viaConst(ref[1]);
  if (/(^|[{,\s])task\s*[,}]/.test(args.slice(0, 400))) return viaConst('task') ?? viaConst('TASK');
  return null;
}

/** Detect call sites in one file. Returns [{ kind, file, task?, provider?, line }]. */
export function scanSource(file, rawSrc) {
  if (ignoreReason(rawSrc)) return { sites: [], ignored: ignoreReason(rawSrc) };
  const code = stripComments(rawSrc);
  const sites = [];
  const isProviderAdapter = file.startsWith(PROVIDERS_DIR);
  const isGatewayDef = GATEWAY_DEFINITION_FILES.includes(file);

  // 1. gateway call sites (skip the function definitions themselves and the gateway's own entry files)
  if (!isGatewayDef && !isProviderAdapter) {
    for (const m of code.matchAll(GATEWAY_CALL_RE)) {
      const before = code.slice(Math.max(0, m.index - 24), m.index);
      if (/(function|import|export|type|interface)\s*\*?\s*$/.test(before)) continue; // definition / import, not a call
      const task = resolveTask(code, m.index, m[1]);
      sites.push({ kind: 'gateway', file, task: task ?? '(dynamic)', call: m[1], line: lineOf(code, m.index) });
    }
  }

  // 2. provider references
  for (const p of PROVIDERS) {
    const m = p.re.exec(code);
    if (!m) continue;
    sites.push({ kind: isProviderAdapter ? 'provider-adapter' : 'direct-provider', file, provider: p.id, line: lineOf(code, m.index) });
  }

  // 3. browser speech (front-end only)
  if (!file.startsWith('supabase/') && SPEECH_RE.test(code)) {
    const m = SPEECH_RE.exec(code);
    sites.push({ kind: 'browser-speech', file, provider: 'browser-speech', line: lineOf(code, m.index) });
  }
  return { sites, ignored: null };
}

/** Stable identity of a call site. Line numbers are NOT part of it (they churn). */
export function siteKey(s) {
  if (s.kind === 'gateway') return `gateway:${s.file}#${s.task}`;
  return `${s.kind}:${s.file}#${s.provider}`;
}

/** Group a file into a "system" row id. */
export function systemOf(file) {
  let m = /^supabase\/functions\/_shared\/ai-core\/providers\//.exec(file);
  if (m) return 'shared:ai-core/providers';
  m = /^supabase\/functions\/_shared\/ai-core\//.exec(file);
  if (m) return 'shared:ai-core';
  m = /^supabase\/functions\/_shared\/([^/]+)\//.exec(file);
  if (m) return `shared:${m[1]}`;
  m = /^supabase\/functions\/_shared\/([^/]+)$/.exec(file);
  if (m) return `shared:${m[1].replace(/\.[^.]+$/, '')}`;
  m = /^supabase\/functions\/([^/]+)\//.exec(file);
  if (m) return `fn:${m[1]}`;
  if (file.startsWith('scripts/')) return `tool:${file}`;
  if (file.startsWith('src/') || file.startsWith('vireek-a11y/')) return `web:${file}`;
  return `repo:${file}`;
}

// ---------------------------------------------------------------------------------------------
// ai-core routing table (task -> provider chain), parsed from registry.ts. Static; runtime overrides are noted.
// ---------------------------------------------------------------------------------------------

export function parseRoutes(registrySrc) {
  const code = stripComments(registrySrc);
  const chains = new Map();
  for (const m of code.matchAll(/const\s+(\w+)\s*:\s*RouteEntry\[\]\s*=\s*\[([\s\S]*?)\];/g)) {
    chains.set(m[1], [...m[2].matchAll(/provider\s*:\s*["'](\w+)["']/g)].map((x) => x[1]));
  }
  for (const m of code.matchAll(/const\s+(\w+)\s*:\s*RouteEntry\[\]\s*=\s*(\w+)\.filter\(\s*\(?\w+\)?\s*=>\s*\w+\.provider\s*!==\s*["'](\w+)["']\s*\)\s*;/g)) {
    if (chains.has(m[2])) chains.set(m[1], chains.get(m[2]).filter((p) => p !== m[3]));
  }
  // task -> chain. `null` = the task has a route entry we could not resolve statically (never silently defaulted).
  const routes = new Map();
  const block = /TASK_ROUTES\s*:[^=]*=\s*\{([\s\S]*?)\n\};/.exec(code);
  if (block) {
    for (const m of block[1].matchAll(/^ {2,3}(\w+)\s*:\s*(.*)$/gm)) {
      const ident = /^(\w+)\s*,?\s*$/.exec(m[2].trim());
      routes.set(m[1], ident && chains.has(ident[1]) ? chains.get(ident[1]) : null);
    }
  }
  return { routes, defaultChain: chains.get('DEFAULT_CHAIN') ?? [] };
}

// ---------------------------------------------------------------------------------------------
// Repo walk
// ---------------------------------------------------------------------------------------------

export function* walk(root, dir = root) {
  for (const name of readdirSync(dir)) {
    if (IGNORE_DIRS.has(name) || name.startsWith('.') || (dir === root && IGNORE_ROOT_DIRS.has(name))) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(root, p);
    else if (CODE_EXT.test(name)) yield toPosix(relative(root, p));
  }
}

export function scanRepo(root) {
  const sites = [];
  const ignored = [];
  const files = [];
  for (const file of walk(root)) {
    if (TEST_FILE.test('/' + file)) continue;
    if (SELF_EXCLUDED.some((p) => file === p || file.startsWith(p))) continue;
    const src = readFileSync(join(root, file), 'utf8');
    files.push(file);
    const r = scanSource(file, src);
    if (r.ignored) ignored.push({ file, reason: r.ignored });
    sites.push(...r.sites);
  }
  const registryPath = join(root, REGISTRY_TS);
  const routing = existsSync(registryPath) ? parseRoutes(readFileSync(registryPath, 'utf8')) : { routes: new Map(), defaultChain: [] };
  sites.sort((a, b) => siteKey(a).localeCompare(siteKey(b)));
  return { sites, ignored, routing, fileCount: files.length };
}

// ---------------------------------------------------------------------------------------------
// Register model
// ---------------------------------------------------------------------------------------------

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const SPLIT_ROW = (line) => {
  const out = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') { cur += '|'; i++; }
    else if (body[i] === '|') { out.push(cur.trim()); cur = ''; }
    else cur += body[i];
  }
  out.push(cur.trim());
  return out;
};

function firstComment(src) {
  const lines = src.split('\n').slice(0, 40);
  const picked = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('#!')) continue;
    const m = /^(?:\/\/+|\/\*+|\*)\s?(.*?)(?:\*\/)?$/.exec(t);
    if (!m) { if (picked.length) break; else continue; }
    const text = m[1].trim();
    if (!text || /^[=\-*#_~\s]{3,}$/.test(text)) continue; // banner / separator lines
    if (/^[\w./-]+\.(ts|tsx|mjs|js)$/.test(text) || /^(?:supabase|scripts|src)\/\S+$/.test(text)) continue; // path-only lines
    picked.push(text.replace(/^[=\-*#_~\s]+|[=\-*#_~\s]+$/g, ''));
    if (picked.join(' ').length > 120) break;
  }
  const joined = picked.join(' ').replace(/\s+/g, ' ');
  if (joined.length <= 160) return joined;
  const cut = joined.slice(0, 160);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 80)) + '...';
}

function signalsFor(srcs) {
  const found = SIGNALS.filter(([, re]) => srcs.some((s) => re.test(s))).map(([label]) => label);
  return found.length ? `Heuristic keyword signals: ${found.join('; ')}${VERIFY}` : `No keyword signals detected${VERIFY}`;
}

export function buildModel(root, scan) {
  const bySystem = new Map();
  for (const s of scan.sites) {
    const id = systemOf(s.file);
    if (!bySystem.has(id)) bySystem.set(id, []);
    bySystem.get(id).push(s);
  }
  const systems = [];
  for (const [id, sites] of [...bySystem].sort(([a], [b]) => a.localeCompare(b))) {
    const files = [...new Set(sites.map((s) => s.file))].sort();
    const srcs = files.map((f) => readFileSync(join(root, f), 'utf8'));
    const tasks = [...new Set(sites.filter((s) => s.kind === 'gateway').map((s) => s.task))].sort();
    const kinds = [...new Set(sites.map((s) => s.kind))].sort();
    const providers = [];
    const add = (name) => { if (!providers.includes(name)) providers.push(name); };
    const chains = [];
    for (const t of tasks) {
      // A task with no TASK_ROUTES entry falls back to DEFAULT_CHAIN at runtime (getRouteForTask); an unresolvable entry stays unresolved.
      const chain = t === '(dynamic)' ? [] : scan.routing.routes.has(t) ? scan.routing.routes.get(t) ?? [] : scan.routing.defaultChain;
      const label = chain.length ? `ai-core chain: ${chain.map((p) => PROVIDER_NAME[p] ?? p).join(' → ')}` : 'ai-core router (chain not resolved statically)';
      if (!chains.includes(label)) chains.push(label);
    }
    chains.forEach(add);
    for (const s of sites) {
      if (s.kind === 'gateway') continue;
      add(s.kind === 'browser-speech' ? 'Browser / OS speech engine (vendor depends on browser)' : PROVIDER_NAME[s.provider] ?? s.provider);
    }
    const purposeFile = files.find((f) => /\/index\.[tj]sx?$/.test(f)) ?? files[0];
    const header = firstComment(srcs[files.indexOf(purposeFile)]);
    const purpose = header || (tasks.length ? `Tasks: ${tasks.join(', ')}` : 'No header comment');
    systems.push({
      id,
      kinds,
      tasks,
      files,
      purpose: purpose + VERIFY,
      data: signalsFor(srcs),
      provider: providers.join('; ') + (tasks.length ? ' (static registry.ts; runtime overrides possible)' : '') + VERIFY,
      risk: PLACEHOLDER_RISK,
      owner: PLACEHOLDER_OWNER,
      review: PLACEHOLDER_REVIEW,
      sites,
    });
  }
  return systems;
}

/** Parse an existing register: systems table (human cells) + call-site index (keys). */
export function parseRegister(text) {
  const rows = new Map();
  const keys = new Map();
  let section = '';
  for (const line of text.split('\n')) {
    if (/^##\s+Systems\b/i.test(line)) section = 'systems';
    else if (/^##\s+Call-site index\b/i.test(line)) section = 'index';
    else if (/^##\s/.test(line)) section = '';
    if (!line.trim().startsWith('|')) continue;
    const cols = SPLIT_ROW(line);
    const m = /^`([^`]+)`/.exec(cols[0] ?? '');
    if (!m) continue;
    if (section === 'systems') {
      rows.set(m[1], { purpose: cols[1], data: cols[2], provider: cols[3], risk: cols[4], owner: cols[5], review: cols[6] });
    } else if (section === 'index') {
      keys.set(m[1], { system: (/^`([^`]+)`/.exec(cols[1] ?? '') ?? [])[1] ?? null });
    }
  }
  return { rows, keys };
}

const keepHuman = (existing, fresh, isAuto) => (existing !== undefined && existing !== '' && !isAuto(existing) ? existing : fresh);

export function renderRegister(systems, existing, meta) {
  const prev = existing?.rows ?? new Map();
  const lines = [];
  lines.push('# AI system register');
  lines.push('');
  lines.push('> Generated by `scripts/ai-governance/inventory.mjs`. **This register is an inventory aid, not a certification, audit or legal assessment.**');
  lines.push('> Re-run `node scripts/ai-governance/inventory.mjs` after adding or removing an AI call site, then fill the `[OWNER]`, `[COUNSEL]` and review-date cells.');
  lines.push('> Cells you edit by hand are preserved on regeneration. Auto-derived cells end with `[VERIFY]`; delete the marker once a human has confirmed the text and the script will keep your wording.');
  lines.push('> Policy: [`ai-policy.md`](./ai-policy.md). CI: `npm run ai-governance:check`.');
  lines.push('');
  lines.push(`Scan summary: ${meta.fileCount} source files scanned, ${meta.siteCount} AI call sites in ${systems.length} systems.`);
  lines.push('');
  lines.push('## Systems');
  lines.push('');
  lines.push('| System | Purpose | Data it sees | Provider | Risk class | Owner | Review date |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of systems) {
    const p = prev.get(s.id) ?? {};
    const isAutoText = (v) => v.endsWith('[VERIFY]');
    const row = [
      `\`${s.id}\`<br>${cell(s.kinds.join(', '))}`,
      cell(keepHuman(p.purpose, s.purpose, isAutoText)),
      cell(keepHuman(p.data, s.data, isAutoText)),
      cell(s.provider),
      cell(keepHuman(p.risk, s.risk, (v) => v === PLACEHOLDER_RISK)),
      cell(keepHuman(p.owner, s.owner, (v) => v === PLACEHOLDER_OWNER)),
      cell(keepHuman(p.review, s.review, (v) => v === PLACEHOLDER_REVIEW)),
    ];
    lines.push(`| ${row.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Call-site index');
  lines.push('');
  lines.push('One row per detected call site. Line numbers are deliberately omitted so the index only changes when a call site is added or removed. CI compares this index with the code.');
  lines.push('');
  lines.push('| Call site | System | Kind | Task / provider |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of systems) {
    for (const site of s.sites) {
      lines.push(`| \`${siteKey(site)}\` | \`${s.id}\` | ${site.kind} | ${cell(site.task ?? PROVIDER_NAME[site.provider] ?? site.provider)} |`);
    }
  }
  lines.push('');
  if (meta.ignored.length) {
    lines.push('## Reviewed exclusions (`// ai-inventory: ignore <reason>`)');
    lines.push('');
    lines.push('| File | Reason |');
    lines.push('| --- | --- |');
    for (const i of meta.ignored) lines.push(`| \`${i.file}\` | ${cell(i.reason)} |`);
    lines.push('');
  }
  lines.push('## Known limits of this scan');
  lines.push('');
  lines.push('- Static pattern matching only. An AI vendor, SDK or host not listed in `PROVIDERS` inside the script is **not** detected: add it there when adopting a new vendor.');
  lines.push('- Third-party SaaS features that embed AI without any code in this repo (e.g. a vendor dashboard setting) are out of scope and must be registered by hand in the policy review.');
  lines.push('- Provider chains come from `registry.ts` as written; runtime route overrides (`AI_ROUTE_OVERRIDES_JSON`) are not visible to a static scan.');
  lines.push('- `Data it sees` is a keyword heuristic, not a data-flow analysis. Risk class is intentionally left as `[COUNSEL]`.');
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------
// The CI check
// ---------------------------------------------------------------------------------------------

export function checkRegister({ scanKeys, scanSystems, registerText, strict = false, today, regenerated }) {
  const errors = [];
  const warnings = [];
  if (registerText == null) {
    errors.push(`${REGISTER_PATH} is missing. Run: node scripts/ai-governance/inventory.mjs`);
    return { errors, warnings };
  }
  const reg = parseRegister(registerText);
  const regKeys = new Set(reg.keys.keys());
  const missing = [...scanKeys].filter((k) => !regKeys.has(k)).sort();
  const stale = [...regKeys].filter((k) => !scanKeys.has(k)).sort();
  for (const k of missing) errors.push(`AI call site not in the register: ${k}`);
  for (const k of stale) (strict ? errors : warnings).push(`register lists a call site that no longer exists: ${k}`);

  for (const [k, v] of reg.keys) {
    if (v.system && !reg.rows.has(v.system)) errors.push(`call site ${k} points at system ${v.system}, which has no row in the Systems table`);
  }
  for (const id of scanSystems) if (!reg.rows.has(id)) errors.push(`system without a row in the Systems table: ${id}`);

  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  let placeholders = 0;
  for (const [id, r] of reg.rows) {
    if (r.owner === PLACEHOLDER_OWNER || r.review === PLACEHOLDER_REVIEW) placeholders++;
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.review ?? '')) {
      const days = Math.floor((now - new Date(`${r.review}T00:00:00Z`)) / 86_400_000);
      if (days > REVIEW_MAX_DAYS) (strict ? errors : warnings).push(`review overdue (${days} days, max ${REVIEW_MAX_DAYS}): ${id}`);
    } else if (r.review && r.review !== PLACEHOLDER_REVIEW) {
      warnings.push(`review date is not YYYY-MM-DD: ${id} -> "${r.review}"`);
    }
  }
  if (placeholders) warnings.push(`${placeholders} system row(s) still have an owner / review-date placeholder`);
  if (strict && regenerated != null && regenerated !== registerText) {
    errors.push(`${REGISTER_PATH} is out of date. Run: node scripts/ai-governance/inventory.mjs`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export function run(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), out = console) {
  const args = new Set(argv.filter((a) => !a.startsWith('--today=')));
  const today = (argv.find((a) => a.startsWith('--today=')) ?? '').slice('--today='.length) || undefined;
  const registerFile = join(root, REGISTER_PATH);
  const scan = scanRepo(root);
  const systems = buildModel(root, scan);
  const scanKeys = new Set(scan.sites.map(siteKey));

  if (args.has('--json')) {
    out.log(JSON.stringify({ fileCount: scan.fileCount, sites: scan.sites, ignored: scan.ignored }, null, 2));
    return 0;
  }

  const existingText = existsSync(registerFile) ? readFileSync(registerFile, 'utf8') : null;
  const existing = existingText ? parseRegister(existingText) : null;
  const regenerated = renderRegister(systems, existing, { fileCount: scan.fileCount, siteCount: scan.sites.length, ignored: scan.ignored });

  if (args.has('--check')) {
    const { errors, warnings } = checkRegister({
      scanKeys, scanSystems: new Set(systems.map((s) => s.id)), registerText: existingText, strict: args.has('--strict'), today, regenerated,
    });
    for (const w of warnings) out.warn(`warn: ${w}`);
    if (errors.length) {
      out.error('AI register check FAILED:');
      for (const e of errors) out.error(`  - ${e}`);
      out.error('Fix: run `node scripts/ai-governance/inventory.mjs`, review the new rows, fill owner / review date, set risk class with counsel, commit the register.');
      return 1;
    }
    out.log(`ok: ${scanKeys.size} AI call sites in ${systems.length} systems are all in ${REGISTER_PATH}.`);
    return 0;
  }

  mkdirSync(dirname(registerFile), { recursive: true });
  writeFileSync(registerFile, regenerated);
  out.log(`wrote ${REGISTER_PATH}: ${scan.sites.length} call sites, ${systems.length} systems.`);
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) process.exit(run(process.argv.slice(2)));
