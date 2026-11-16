import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REGISTER_PATH, stripComments, ignoreReason, resolveTask, scanSource, siteKey, systemOf, parseRoutes,
  parseRegister, renderRegister, checkRegister, run,
} from './inventory.mjs';

const GW = 'supabase/functions/demo/index.ts';

describe('stripComments / ignoreReason', () => {
  it('drops comments but keeps URLs in strings', () => {
    const out = stripComments('// api.openai.com\nconst u = "https://api.groq.com/x"; /* api.anthropic.com */');
    expect(out).not.toContain('api.openai.com');
    expect(out).not.toContain('api.anthropic.com');
    expect(out).toContain('https://api.groq.com/x');
  });
  it('requires a reason for the ignore marker', () => {
    expect(ignoreReason('// ai-inventory: ignore catalogue only')).toBe('catalogue only');
    expect(ignoreReason('// ai-inventory: ignore')).toBeNull();
    expect(ignoreReason('const a = 1')).toBeNull();
  });
});

describe('scanSource', () => {
  it('detects askVireekAi with a literal task', () => {
    const r = scanSource(GW, 'const r = await askVireekAi({\n  task: "intent_classify",\n  messages: [],\n});');
    expect(r.sites).toHaveLength(1);
    expect(siteKey(r.sites[0])).toBe(`gateway:${GW}#intent_classify`);
  });
  it('resolves task through a const, for askVireekAi and routeChat', () => {
    const a = scanSource(GW, 'const TASK = "dm_x" as const;\nawait askVireekAi({ task: TASK, messages: [] });');
    expect(a.sites[0].task).toBe('dm_x');
    const b = scanSource(GW, 'const TASK = "inbound_auto_reply" as const;\nawait routeChat(TASK as never, { system });');
    expect(b.sites[0].task).toBe('inbound_auto_reply');
    expect(resolveTask('await askVireekAi({ task: someVar })', 6, 'askVireekAi')).toBeNull();
  });
  it('marks unresolved tasks as (dynamic) rather than dropping the site', () => {
    const r = scanSource(GW, 'await routeChat(task, request, []);');
    expect(r.sites[0].task).toBe('(dynamic)');
  });
  it('skips gateway definitions, imports and comments', () => {
    const def = scanSource('supabase/functions/_shared/ai-core/index.ts', 'export async function askVireekAi(req) {}');
    expect(def.sites).toHaveLength(0);
    const imp = scanSource(GW, 'import { askVireekAi } from "../_shared/ai-core/index.ts";\n// askVireekAi({ task: "x" })');
    expect(imp.sites).toHaveLength(0);
  });
  it('detects direct provider hosts and env keys, once per provider per file', () => {
    const r = scanSource(GW, 'fetch("https://generativelanguage.googleapis.com/v1/x"); Deno.env.get("GEMINI_API_KEY");');
    expect(r.sites.map(siteKey)).toEqual([`direct-provider:${GW}#gemini`]);
  });
  it('ignores a provider mentioned only in a comment', () => {
    expect(scanSource(GW, '// we used to call api.openai.com here').sites).toHaveLength(0);
  });
  it('detects Cloudflare Workers AI REST path', () => {
    const r = scanSource(GW, 'const url = `https://api.cloudflare.com/client/v4/accounts/${id}/ai/run/${model}`;');
    expect(r.sites[0].provider).toBe('cloudflare');
  });
  it('treats files under the providers dir as adapters', () => {
    const r = scanSource('supabase/functions/_shared/ai-core/providers/groq.ts', 'fetch("https://api.groq.com/openai/v1/chat/completions")');
    expect(r.sites[0].kind).toBe('provider-adapter');
  });
  it('detects browser speech in front-end code only', () => {
    expect(scanSource('src/lib/x.ts', 'new webkitSpeechRecognition()').sites[0].kind).toBe('browser-speech');
    expect(scanSource('supabase/functions/x/index.ts', 'const speechSynthesis = 1').sites).toHaveLength(0);
  });
  it('honours the reviewed ignore marker', () => {
    const r = scanSource(GW, '// ai-inventory: ignore host catalogue, no calls\nconst h = "api.openai.com";');
    expect(r.sites).toHaveLength(0);
    expect(r.ignored).toBe('host catalogue, no calls');
  });
});

describe('systemOf', () => {
  it('groups files into stable system ids', () => {
    expect(systemOf('supabase/functions/foo/index.ts')).toBe('fn:foo');
    expect(systemOf('supabase/functions/_shared/ai-core/reviewReply.ts')).toBe('shared:ai-core');
    expect(systemOf('supabase/functions/_shared/ai-core/providers/groq.ts')).toBe('shared:ai-core/providers');
    expect(systemOf('supabase/functions/_shared/voice/tts.ts')).toBe('shared:voice');
    expect(systemOf('supabase/functions/_shared/costs.ts')).toBe('shared:costs');
    expect(systemOf('src/lib/siteSafety.ts')).toBe('web:src/lib/siteSafety.ts');
    expect(systemOf('scripts/knowledge-build.mjs')).toBe('tool:scripts/knowledge-build.mjs');
  });
});

describe('parseRoutes', () => {
  it('resolves chains, filters and task routes', () => {
    const src = `
const DEFAULT_CHAIN: RouteEntry[] = [
  { provider: "gemini", priority: 10, model: "m" },
  { provider: "groq", priority: 20, model: "m" },
  { provider: "cloudflare", priority: 40, model: "m" },
];
const JSON_CHAIN: RouteEntry[] = DEFAULT_CHAIN.filter((e) => e.provider !== "cloudflare");
export const TASK_ROUTES: Record<TaskType, RouteEntry[]> = {
  ask_vireek: JSON_CHAIN,
  demo_chat: DEFAULT_CHAIN,
};`;
    const r = parseRoutes(src);
    expect(r.routes.get('ask_vireek')).toEqual(['gemini', 'groq']);
    expect(r.routes.get('demo_chat')).toEqual(['gemini', 'groq', 'cloudflare']);
    expect(r.defaultChain).toEqual(['gemini', 'groq', 'cloudflare']);
  });
  it('marks entries it cannot resolve as null instead of defaulting them', () => {
    const src = `
const DEFAULT_CHAIN: RouteEntry[] = [ { provider: "gemini", priority: 10, model: "m" } ];
export const TASK_ROUTES: Record<TaskType, RouteEntry[]> = {
  custom_task: [{ provider: "anthropic", priority: 1, model: "m" }],
  ok_task: DEFAULT_CHAIN,
};`;
    const r = parseRoutes(src);
    expect(r.routes.get('custom_task')).toBeNull();
    expect(r.routes.get('ok_task')).toEqual(['gemini']);
  });
});

function fakeSystem(id, key, extra = {}) {
  return {
    id, kinds: ['gateway'], tasks: ['t'], files: ['f'], purpose: 'auto purpose [VERIFY]', data: 'auto data [VERIFY]',
    provider: 'P [VERIFY]', risk: '[COUNSEL]', owner: '[OWNER: fill]', review: '[REVIEW DATE: fill]',
    sites: [{ kind: 'gateway', file: 'supabase/functions/a/index.ts', task: key }], ...extra,
  };
}
const META = { fileCount: 1, siteCount: 1, ignored: [] };

describe('register render / parse', () => {
  it('round-trips and preserves human-edited cells, but refreshes auto cells', () => {
    const first = renderRegister([fakeSystem('fn:a', 't1')], null, META);
    const edited = first
      .replace('[OWNER: fill]', 'Dana (platform)')
      .replace('[REVIEW DATE: fill]', '2026-11-01')
      .replace('auto purpose [VERIFY]', 'Hand-confirmed purpose');
    const regenerated = renderRegister([fakeSystem('fn:a', 't1', { purpose: 'new auto purpose [VERIFY]', data: 'new auto data [VERIFY]' })], parseRegister(edited), META);
    const row = parseRegister(regenerated).rows.get('fn:a');
    expect(row.owner).toBe('Dana (platform)');
    expect(row.review).toBe('2026-11-01');
    expect(row.purpose).toBe('Hand-confirmed purpose');
    expect(row.data).toBe('new auto data [VERIFY]');
    expect(row.risk).toBe('[COUNSEL]');
  });
  it('escapes pipes inside cells', () => {
    const md = renderRegister([fakeSystem('fn:a', 't1', { purpose: 'a | b [VERIFY]' })], null, META);
    expect(parseRegister(md).rows.get('fn:a').purpose).toBe('a | b [VERIFY]');
  });
});

describe('checkRegister', () => {
  const md = renderRegister([fakeSystem('fn:a', 't1')], null, META);
  const keys = (...k) => new Set(k);
  const A = 'gateway:supabase/functions/a/index.ts#t1';

  it('passes when every call site is registered', () => {
    expect(checkRegister({ scanKeys: keys(A), scanSystems: keys('fn:a'), registerText: md }).errors).toEqual([]);
  });
  it('FAILS on a new, unregistered call site', () => {
    const r = checkRegister({ scanKeys: keys(A, 'gateway:supabase/functions/b/index.ts#t2'), scanSystems: keys('fn:a', 'fn:b'), registerText: md });
    expect(r.errors.join('\n')).toContain('gateway:supabase/functions/b/index.ts#t2');
  });
  it('FAILS when the register is missing', () => {
    expect(checkRegister({ scanKeys: keys(A), scanSystems: keys('fn:a'), registerText: null }).errors).toHaveLength(1);
  });
  it('treats stale rows as a warning, and an error in strict mode', () => {
    const loose = checkRegister({ scanKeys: keys(), scanSystems: keys(), registerText: md });
    expect(loose.errors).toEqual([]);
    expect(loose.warnings.join('\n')).toContain('no longer exists');
    expect(checkRegister({ scanKeys: keys(), scanSystems: keys(), registerText: md, strict: true }).errors).toHaveLength(1);
  });
  it('flags overdue reviews (warning, error when strict) and bad date formats', () => {
    const old = md.replace('[REVIEW DATE: fill]', '2025-01-01');
    const base = { scanKeys: keys(A), scanSystems: keys('fn:a'), registerText: old, today: '2026-11-12' };
    expect(checkRegister(base).warnings.join('\n')).toContain('review overdue');
    expect(checkRegister({ ...base, strict: true, regenerated: old }).errors.join('\n')).toContain('review overdue');
    const bad = md.replace('[REVIEW DATE: fill]', 'last spring');
    expect(checkRegister({ ...base, registerText: bad }).warnings.join('\n')).toContain('not YYYY-MM-DD');
  });
  it('FAILS when an index row points at a system with no Systems row', () => {
    const broken = md.replace(/\| `fn:a`<br>[^\n]*\n/, '');
    expect(checkRegister({ scanKeys: keys(A), scanSystems: keys('fn:a'), registerText: broken }).errors.length).toBeGreaterThan(0);
  });
});

describe('run() end to end on a fixture repo', () => {
  const sink = () => { const l = { log: [], warn: [], error: [] }; return { l, out: { log: (m) => l.log.push(m), warn: (m) => l.warn.push(m), error: (m) => l.error.push(m) } }; };
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

  it('write -> check ok -> new AI call site breaks the gate -> write -> check ok', () => {
    const root = mkdtempSync(join(tmpdir(), 'vireek-ai-'));
    try {
      put(root, 'supabase/functions/a/index.ts', '// Answers dashboard questions.\nawait askVireekAi({ task: "dashboard_answer", messages: [] });\n');
      expect(run([], root, sink().out)).toBe(0);
      expect(readFileSync(join(root, REGISTER_PATH), 'utf8')).toContain('gateway:supabase/functions/a/index.ts#dashboard_answer');
      expect(run(['--check'], root, sink().out)).toBe(0);

      put(root, 'supabase/functions/b/index.ts', 'await fetch("https://api.anthropic.com/v1/messages");\n');
      const s = sink();
      expect(run(['--check'], root, s.out)).toBe(1);
      expect(s.l.error.join('\n')).toContain('direct-provider:supabase/functions/b/index.ts#anthropic');

      expect(run([], root, sink().out)).toBe(0);
      expect(run(['--check', '--strict'], root, sink().out)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not count test files or ignored directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'vireek-ai-'));
    try {
      put(root, 'supabase/functions/a/index.test.ts', 'await askVireekAi({ task: "x", messages: [] });');
      put(root, 'node_modules/pkg/index.js', 'fetch("https://api.openai.com/v1")');
      expect(run([], root, sink().out)).toBe(0);
      expect(run(['--check'], root, sink().out)).toBe(0);
      expect(readFileSync(join(root, REGISTER_PATH), 'utf8')).toContain('0 AI call sites');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
