import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  looksLikeModelId, parseRegisteredIds, checkRegistryIntegrity, scanSource, scanYaml, isExempt, REGISTRY_PATH,
} from './modelRegistryScan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REG_TEXT = readFileSync(join(ROOT, REGISTRY_PATH), 'utf8');
const reg = parseRegisteredIds(REG_TEXT);

test('recognises model ids of every supported provider family', () => {
  for (const s of ['gemini-2.5-flash', 'gemini-3-pro', 'gpt-4o-mini', 'gpt-5', 'o3-mini', 'claude-sonnet-5', 'claude-haiku-4-5-20251001',
    'llama-3.3-70b', 'llama3-70b', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'openrouter/auto', 'command-r-plus', 'embed-english-v3.0',
    'eleven_flash_v2_5', 'text-embedding-3-small', 'mistral-large-latest', 'qwen3-32b']) assert.equal(looksLikeModelId(s), true, s);
});

test('ignores ordinary words and ids that merely contain a model-like substring', () => {
  for (const s of ['llamada', 'llamadas', 'command-center', 'whisper', 'gpt-live', 'gemini', 'claude', 'my-gemini-2.5-flash-x', 'embedding', 'o2', 'Hello llama-3 world'])
    assert.equal(looksLikeModelId(s), false, s);
});

test('registry parsing: finds registered ids and the real registry is consistent', () => {
  assert.ok(reg.has('gemini-2.5-flash') && reg.has('claude-sonnet-5') && reg.has('openrouter/auto'));
  assert.deepEqual(checkRegistryIntegrity(REG_TEXT), []);
});

test('integrity: a MODELS key without a registry entry (and vice versa) is reported', () => {
  const missing = REG_TEXT.replace(/\{ id: MODELS\.GROQ_LLAMA_70B,/, '{ id: MODELS.CEREBRAS_LLAMA_70B,');
  const probs = checkRegistryIntegrity(missing);
  assert.ok(probs.some((p) => p.includes('GROQ_LLAMA_70B has no entry')), probs.join('|'));
  assert.ok(probs.some((p) => p.includes('CEREBRAS_LLAMA_70B has 2 entries')), probs.join('|'));
  const unknown = REG_TEXT.replace('id: MODELS.GROQ_LLAMA_70B', 'id: MODELS.NOPE');
  assert.ok(checkRegistryIntegrity(unknown).some((p) => p.includes('unknown MODELS.NOPE')));
});

test('flags an unregistered literal with file and line, in all quote styles', () => {
  const src = 'const a = 1;\nconst m = Deno.env.get("X") || "gemini-9-ultra";\nconst b = \'gpt-9\';\nconst c = `claude-opus-9`;\n';
  const hits = scanSource(src, 'supabase/functions/x/index.ts', reg);
  assert.deepEqual(hits.map((h) => [h.line, h.model]), [[2, 'gemini-9-ultra'], [3, 'gpt-9'], [4, 'claude-opus-9']]);
});

test('registered ids pass; comments and the ignore marker are skipped', () => {
  const src = [
    'const ok = "gemini-2.5-flash";',
    '// default "gemini-9-ultra" in a comment',
    '/* "gpt-9" in a block comment */',
    'const x = "gpt-9"; // model-registry-ignore',
    'const url = "https://api.example.com/v1";',
  ].join('\n');
  assert.deepEqual(scanSource(src, 'a.ts', reg), []);
});

test('a model id inside a URL-like string is not mistaken for a comment', () => {
  const src = 'const u = "https://x.test/a"; const m = "gpt-9";';
  assert.equal(scanSource(src, 'a.ts', reg).length, 1);
});

test('yaml: *_MODEL env values are checked, other keys are not', () => {
  const y = ['env:', '  COHERE_EMBED_MODEL: embed-multilingual-v3.0', '  GEMINI_MODEL: gemini-9-ultra', '  NAME: gemini-9-ultra', '  OVB_CALLER_MODEL: "gpt-9"  # x'].join('\n');
  assert.deepEqual(scanYaml(y, 'w.yml', reg).map((h) => [h.line, h.model]), [[3, 'gemini-9-ultra'], [5, 'gpt-9']]);
});

test('exempt paths: registry, tests, locales; shipping code is not', () => {
  for (const p of ['supabase/functions/_shared/ai-models.ts', 'a/b.test.ts', 'src/locales/x.ts', 'scripts/check-model-registry.mjs']) assert.equal(isExempt(p), true, p);
  for (const p of ['supabase/functions/x/index.ts', 'src/lib/a.ts', 'scripts/eval-voice-log.mjs']) assert.equal(isExempt(p), false, p);
});

function runCli(files) {
  const dir = mkdtempSync(join(tmpdir(), 'mreg-'));
  try {
    mkdirSync(join(dir, 'supabase/functions/_shared'), { recursive: true });
    writeFileSync(join(dir, REGISTRY_PATH), REG_TEXT);
    for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
    return spawnSync(process.execPath, [join(ROOT, 'scripts/check-model-registry.mjs')], { cwd: dir, encoding: 'utf8' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('CLI: exits 0 on a clean tree', () => {
  const r = runCli({ 'supabase/functions/a/index.ts': 'const m = MODELS.GEMINI_FLASH;' });
  assert.equal(r.status, 0, r.stderr);
});

test('CLI: exits 1 and names file:line for an unregistered model in functions, src and workflows', () => {
  const r = runCli({
    'supabase/functions/a/index.ts': 'const m = "gemini-9-ultra";',
    'src/lib/b.ts': '\nexport const M = "gpt-9";',
    '.github/workflows/w.yml': 'env:\n  GEMINI_MODEL: gemini-8',
  });
  assert.equal(r.status, 1);
  for (const s of ['supabase/functions/a/index.ts:1', 'src/lib/b.ts:2', '.github/workflows/w.yml:2']) assert.ok(r.stderr.includes(s), r.stderr);
});

test('CLI: exits 1 when the registry itself is inconsistent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mreg-'));
  try {
    mkdirSync(join(dir, 'supabase/functions/_shared'), { recursive: true });
    writeFileSync(join(dir, REGISTRY_PATH), REG_TEXT.replace('id: MODELS.GROQ_LLAMA_70B', 'id: MODELS.CEREBRAS_LLAMA_70B'));
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-model-registry.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('GROQ_LLAMA_70B has no entry'), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


import { parseModelKeys, parseEntries, checkLifecycle, scanHardcodedRegistered } from './modelRegistryScan.mjs';

const idToKey = parseModelKeys(REG_TEXT);
const keyToId = new Map([...idToKey].map(([id, k]) => [k, id]));

test('hardcoded registered ids are flagged with their MODELS key; comments are not', () => {
  const src = 'const a = "gemini-2.5-flash";\n// "gemini-2.5-flash"\nconst b = MODELS.GEMINI_FLASH;';
  assert.deepEqual(scanHardcodedRegistered(src, 'a.ts', idToKey).map((h) => [h.line, h.key]), [[1, 'GEMINI_FLASH']]);
});

test('lifecycle: parseEntries reads the real registry and it is clean', () => {
  const entries = parseEntries(REG_TEXT);
  assert.equal(entries.length, keyToId.size);
  assert.deepEqual(checkLifecycle(entries, keyToId, reg), { errors: [], warnings: [] });
});

test('lifecycle: deprecated needs replacement + sunset; past sunset errors; near sunset warns', () => {
  const today = new Date('2030-01-10');
  const mk = (over) => [{ key: 'A', status: 'deprecated', sunsetDate: '2030-06-01', replacedByKey: 'GEMINI_FLASH', ...over }];
  assert.deepEqual(checkLifecycle(mk({}), keyToId, reg, today), { errors: [], warnings: [] });
  assert.equal(checkLifecycle(mk({ replacedByKey: undefined }), keyToId, reg, today).errors.length, 1);
  assert.equal(checkLifecycle(mk({ replacedByKey: 'NOPE' }), keyToId, reg, today).errors.length, 1);
  assert.equal(checkLifecycle(mk({ sunsetDate: undefined }), keyToId, reg, today).errors.length, 1);
  assert.equal(checkLifecycle(mk({ sunsetDate: '2030-13-45' }), keyToId, reg, today).errors.length, 1);
  assert.match(checkLifecycle(mk({ sunsetDate: '2030-01-01' }), keyToId, reg, today).errors[0], /has passed/);
  const near = checkLifecycle(mk({ sunsetDate: '2030-01-25' }), keyToId, reg, today);
  assert.deepEqual(near.errors, []);
  assert.match(near.warnings[0], /sunset in 15 day/);
  assert.deepEqual(checkLifecycle(mk({ status: 'retired', sunsetDate: '2020-01-01' }), keyToId, reg, today).errors, []);
});

function runCliWith(registry, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mreg-'));
  try {
    mkdirSync(join(dir, 'supabase/functions/_shared'), { recursive: true });
    writeFileSync(join(dir, REGISTRY_PATH), registry);
    return spawnSync(process.execPath, [join(ROOT, 'scripts/check-model-registry.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('CLI: a deprecated entry past its sunset fails; before it passes with a warning', () => {
  const dep = REG_TEXT.replace(/(id: MODELS\.GROQ_LLAMA_70B,[^\n]*status: )"active"/, '$1"deprecated", sunsetDate: "2030-02-01", replacedBy: MODELS.GEMINI_FLASH');
  assert.notEqual(dep, REG_TEXT);
  const late = runCliWith(dep, { MODEL_REGISTRY_TODAY: '2030-03-01' });
  assert.equal(late.status, 1);
  assert.ok(late.stderr.includes('has passed'), late.stderr);
  const soon = runCliWith(dep, { MODEL_REGISTRY_TODAY: '2030-01-20' });
  assert.equal(soon.status, 0, soon.stderr);
  assert.ok(soon.stderr.includes('warning: MODELS.GROQ_LLAMA_70B'), soon.stderr);
});

test('CLI: re-hardcoding a registered id in edge code or scripts fails with the key to use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mreg-'));
  try {
    mkdirSync(join(dir, 'supabase/functions/_shared'), { recursive: true });
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, REGISTRY_PATH), REG_TEXT);
    writeFileSync(join(dir, 'supabase/functions/_shared/x.ts'), 'export const m = "gemini-2.5-flash";');
    writeFileSync(join(dir, 'scripts/y.mjs'), "const m = 'embed-english-v3.0';");
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-model-registry.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes('x.ts:1') && r.stderr.includes('GEMINI_FLASH') && r.stderr.includes('y.mjs:1') && r.stderr.includes('COHERE_EMBED_EN'), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
