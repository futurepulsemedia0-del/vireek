#!/usr/bin/env node
// Usage: node --experimental-strip-types --no-warnings scripts/llm-cost/benchmark.mjs [--json]
// Measures prompt-prefix sizes from the real source, then simulates the three cost features on fixtures.
import { readFileSync } from 'node:fs';
import { runAll } from './benchmark-lib.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const core = readFileSync('supabase/functions/_shared/ai-core/index.ts', 'utf8');

function tokens(chars) { return Math.ceil(chars / 4); }
const base = /const BASE_IDENTITY = `([\s\S]*?)`;\n/.exec(core)?.[1];
if (!base) throw new Error('BASE_IDENTITY not found in ai-core/index.ts; update benchmark.mjs');
const block = core.slice(core.indexOf('const TASK_INSTRUCTIONS'), core.indexOf('// Tasks where grounding'));
function taskLen(task) {
  const m = new RegExp(`\\n\\s+${task}: \`([\\s\\S]*?)\`,?\\n`).exec(block);
  if (!m) throw new Error(`TASK_INSTRUCTIONS.${task} not found; update benchmark.mjs`);
  return m[1].length;
}
const { getFullKnowledgeBrief } = await import('../../supabase/functions/_shared/ai-core/knowledge.ts');
const briefChars = getFullKnowledgeBrief().length;

const measured = {};
for (const sc of fixtures.scenarios) {
  if (sc.feature !== 'prompt_cache') continue;
  const chars = base.length + 2 + taskLen(sc.task) + (sc.includeStaticBrief ? 2 + briefChars : 0);
  measured[sc.id] = { prefixTokens: tokens(chars) };
}

const rows = await runAll(fixtures, measured);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ measuredPrefixTokens: measured, results: rows }, null, 2));
} else {
  console.log('LLM cost benchmark — FIXTURES, not production traffic (prefix sizes measured from source; token counts are chars/4 estimates)\n');
  for (const r of rows) {
    console.log(`${r.id}  [${r.feature}, ${r.provider}/${r.model}]`);
    console.log(`  before $${r.beforeUsd.toFixed(4)}  ->  after $${r.afterUsd.toFixed(4)}  (saved ${r.savedPct}%)`);
    const { id, feature, provider, model, beforeUsd, afterUsd, savedPct, ...rest } = r;
    console.log('  ' + JSON.stringify(rest));
  }
}
