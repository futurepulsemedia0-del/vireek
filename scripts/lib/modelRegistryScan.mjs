// Pure scanner for the AI model registry gate (supabase/functions/_shared/ai-models.ts).
// Used by scripts/check-model-registry.mjs and unit-tested in modelRegistryScan.test.mjs.
// Rule: every string literal that looks like an LLM / embedding / TTS model id must be registered.
// Escape hatch for a deliberate non-model false positive: put `model-registry-ignore` in a comment on the same line.

export const REGISTRY_PATH = 'supabase/functions/_shared/ai-models.ts';

// Whole-literal match only (anchored), so prose such as "llamada" or "command-center" never matches.
export const MODEL_LIKE = new RegExp(
  '^(?:' +
    [
      'gemini-[0-9][\\w.-]*',
      'gemini-embedding[\\w.-]*',
      'gpt-[0-9][\\w.-]*',
      'o[134](?:-mini|-preview|-pro)?',
      'chatgpt-[\\w.-]+',
      'text-embedding-[\\w.-]+',
      'dall-e-[0-9]',
      'tts-[0-9][\\w.-]*',
      'whisper-[\\w.-]+',
      'claude-[a-z0-9][\\w.-]*',
      'llama-?[0-9][\\w.-]*',
      'mixtral-[\\w.-]+',
      'mistral-[\\w.-]+',
      'deepseek-[\\w.-]+',
      'qwen[0-9][\\w.-]*',
      'grok-[\\w.-]+',
      'command-(?:r|a)[\\w.-]*',
      'embed-[a-z]+-v[0-9][\\w.-]*',
      'eleven_[a-z0-9_]+',
      'nova-[0-9][\\w.-]*',
      'imagen-[\\w.-]+',
      'veo-[\\w.-]+',
      '@cf/[\\w.\\-/]+',
      'openrouter/[\\w.-]+',
    ].join('|') +
    ')$',
  'i',
);

export const looksLikeModelId = (s) => MODEL_LIKE.test(s);

/** Blank out comments but keep line structure (line numbers stay valid). */
export const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Registered ids = the string values inside `export const MODELS = { ... } as const`. */
export function parseRegisteredIds(registryText) {
  const m = registryText.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!m) throw new Error(`MODELS block not found in ${REGISTRY_PATH}`);
  return new Set([...m[1].matchAll(/:\s*"([^"]+)"/g)].map((x) => x[1]));
}

/** Every MODELS key must have exactly one `id: MODELS.KEY` registry entry (owner/provider/etc. live there). */
export function checkRegistryIntegrity(registryText) {
  const block = registryText.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!block) return [`MODELS block not found in ${REGISTRY_PATH}`];
  const keys = [...block[1].matchAll(/^\s*([A-Z0-9_]+)\s*:/gm)].map((x) => x[1]);
  const used = [...registryText.matchAll(/\bid:\s*MODELS\.([A-Z0-9_]+)/g)].map((x) => x[1]);
  const problems = [];
  for (const k of keys) {
    const n = used.filter((u) => u === k).length;
    if (n === 0) problems.push(`MODELS.${k} has no entry in MODEL_REGISTRY`);
    if (n > 1) problems.push(`MODELS.${k} has ${n} entries in MODEL_REGISTRY`);
  }
  for (const u of new Set(used)) if (!keys.includes(u)) problems.push(`MODEL_REGISTRY references unknown MODELS.${u}`);
  return problems;
}

const LITERAL = /(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

/** @returns {{file:string,line:number,model:string}[]} unregistered model-like literals in a JS/TS source. */
export function scanSource(text, file, registered) {
  const raw = text.split('\n');
  const clean = stripComments(text).split('\n');
  const out = [];
  clean.forEach((ln, i) => {
    if (raw[i].includes('model-registry-ignore')) return;
    LITERAL.lastIndex = 0;
    let m;
    while ((m = LITERAL.exec(ln))) {
      const s = m[2];
      if (looksLikeModelId(s) && !registered.has(s)) out.push({ file, line: i + 1, model: s });
    }
  });
  return out;
}

/** GitHub workflow / YAML: `SOMETHING_MODEL: value` (quoted or not). */
export function scanYaml(text, file, registered) {
  const out = [];
  text.split('\n').forEach((ln, i) => {
    if (ln.includes('model-registry-ignore')) return;
    const m = ln.match(/^\s*[A-Z0-9_]*MODEL[A-Z0-9_]*\s*:\s*["']?([^\s"'#]+)["']?\s*(?:#.*)?$/);
    if (m && looksLikeModelId(m[1]) && !registered.has(m[1])) out.push({ file, line: i + 1, model: m[1] });
  });
  return out;
}

const SKIP_RE = [
  /(^|\/)node_modules\//,
  /(^|\/)(locales|i18n|__fixtures__)\//,
  /\.test\.[cm]?[jt]sx?$/,
  /^supabase\/functions\/_shared\/ai-models\.ts$/,
  /^scripts\/check-model-registry\.mjs$/,
  /^scripts\/lib\/modelRegistryScan(\.test)?\.mjs$/,
];
export const isExempt = (rel) => SKIP_RE.some((re) => re.test(rel));
export const isScannableSource = (rel) => /\.(ts|tsx|mjs|cjs|js)$/.test(rel) && !/\.d\.ts$/.test(rel);
export const isScannableYaml = (rel) => /\.ya?ml$/.test(rel);


/** id -> MODELS key, e.g. "gemini-2.5-flash" -> "GEMINI_FLASH". */
export function parseModelKeys(registryText) {
  const m = registryText.match(/export const MODELS\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!m) throw new Error(`MODELS block not found in ${REGISTRY_PATH}`);
  return new Map([...m[1].matchAll(/([A-Z0-9_]+)\s*:\s*"([^"]+)"/g)].map((x) => [x[2], x[1]]));
}

/**
 * Registered ids must not be re-hardcoded in shipping code: use MODELS.<KEY> (edge) or
 * registryModelId('<KEY>') from scripts/lib/modelRegistry.mjs (plain Node scripts).
 */
export function scanHardcodedRegistered(text, file, idToKey) {
  const raw = text.split('\n');
  const clean = stripComments(text).split('\n');
  const out = [];
  clean.forEach((ln, i) => {
    if (raw[i].includes('model-registry-ignore')) return;
    LITERAL.lastIndex = 0;
    let m;
    while ((m = LITERAL.exec(ln))) {
      if (idToKey.has(m[2])) out.push({ file, line: i + 1, model: m[2], key: idToKey.get(m[2]) });
    }
  });
  return out;
}

/** Parse MODEL_REGISTRY entries: key, status, sunsetDate, replacedBy (MODELS key or literal id). */
export function parseEntries(registryText) {
  const out = [];
  for (const m of registryText.matchAll(/\{\s*id:\s*MODELS\.([A-Z0-9_]+),([\s\S]*?)\},\n/g)) {
    const body = m[2];
    const rep = body.match(/replacedBy:\s*(?:MODELS\.([A-Z0-9_]+)|"([^"]+)")/);
    out.push({
      key: m[1],
      status: (body.match(/status:\s*"(\w+)"/) ?? [])[1],
      sunsetDate: (body.match(/sunsetDate:\s*"([^"]+)"/) ?? [])[1],
      replacedByKey: rep?.[1],
      replacedById: rep?.[2],
    });
  }
  return out;
}

const DAY = 86_400_000;
/**
 * Lifecycle gate. errors fail CI; warnings are printed.
 *  - deprecated/retired needs sunsetDate (YYYY-MM-DD) and a replacedBy that is registered and not itself retired
 *  - deprecated and past its sunset date -> error (retire it or fix the date)
 *  - deprecated and sunset within `warnDays` -> warning
 */
export function checkLifecycle(entries, keys, ids, today = new Date(), warnDays = 30) {
  const errors = [];
  const warnings = [];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  for (const e of entries) {
    if (e.status !== 'deprecated' && e.status !== 'retired') continue;
    const tag = `MODELS.${e.key} (${e.status})`;
    const okRep = (e.replacedByKey && keys.has(e.replacedByKey)) || (e.replacedById && ids.has(e.replacedById));
    if (!okRep) errors.push(`${tag}: replacedBy must reference a registered model`);
    else {
      const target = byKey.get(e.replacedByKey ?? [...byKey.keys()].find((k) => keys.get?.(k) === e.replacedById));
      if (target?.status === 'retired') errors.push(`${tag}: replacement is itself retired`);
    }
    if (!e.sunsetDate || !/^\d{4}-\d{2}-\d{2}$/.test(e.sunsetDate) || Number.isNaN(Date.parse(e.sunsetDate))) {
      errors.push(`${tag}: sunsetDate must be YYYY-MM-DD`);
      continue;
    }
    if (e.status === 'deprecated') {
      const days = Math.floor((Date.parse(e.sunsetDate) - today.getTime()) / DAY);
      if (days < 0) errors.push(`${tag}: sunset ${e.sunsetDate} has passed; finish the switch and mark it retired`);
      else if (days <= warnDays) warnings.push(`${tag}: sunset in ${days} day(s) (${e.sunsetDate}); complete docs/runbooks/model-change.md`);
    }
  }
  return { errors, warnings };
}
