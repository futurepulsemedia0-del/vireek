#!/usr/bin/env node
// scripts/design/radius-codemod.mjs
//
// Phase 2 migration tool. Rewrites Tailwind radius classes in place by element role,
// using the same classifier + mapping rule (`targetFor`) as the audit and the guard.
//
//   node scripts/design/radius-codemod.mjs --step legacy-md [--apply]
//       `rounded-md` (12px today) -> `rounded-legacy-md` (12px): pixel-identical, must ship
//       in the SAME commit that changes `md` to 6px in tailwind.config.js.
//   node scripts/design/radius-codemod.mjs --step roles --include src/components/ui,src/pages/Home [--apply]
//       role mapping (control / inset / chip / surface / overlay / full). Run it per batch.
//   node scripts/design/radius-codemod.mjs --step finish [--apply]
//       after the compat release: any remaining `rounded-legacy-md` (role unknown) -> `rounded-xl` (same 12px);
//       single-corner tails (rounded-bl-legacy-md on chat bubbles) -> `rounded-bl-sm` so the tail stays tighter than the bubble.
//
// Default is a DRY RUN that prints a per-file summary. Nothing is written without --apply.
// Idempotent: a second run changes nothing. Tokens it cannot place exactly are skipped and listed.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scanProject, targetFor } from './lib/radius-classify.mjs';

/** Pure: build the edit list for one file's records. */
export function planEdits(records, step, allow = {}) {
  const edits = [];
  for (const r of records) {
    const sideTxt = r.side ? `-${r.side}` : '';
    let next = null;
    if (step === 'legacy-md') {
      if (r.size === 'md') next = `rounded${sideTxt}-legacy-md`;
    } else if (step === 'roles') {
      const t = targetFor(r, allow); // legacy-md is treated like its old rendering (12px) and placed by role
      if (t) next = `rounded${sideTxt}-${t}`;
    } else if (step === 'finish') {
      if (r.size === 'legacy-md') {
        // single-corner tails (chat bubbles) must stay tighter than the bubble: 12px would now be rounder than it.
        const corner = ['tl', 'tr', 'bl', 'br', 'ss', 'se', 'es', 'ee'].includes(r.side);
        next = `rounded${sideTxt}-${corner ? 'sm' : targetFor({ ...r, size: 'xl' }, allow) ?? 'xl'}`;
      }
    }
    if (next && next !== r.token) edits.push({ pos: r.pos, end: r.end, from: r.token, to: next, line: r.line, role: r.role });
  }
  return edits;
}

/** Pure: apply edits (non-overlapping) back-to-front; verifies each span still holds the expected token. */
export function applyEdits(text, edits) {
  const skipped = [];
  let out = text;
  for (const e of [...edits].sort((a, b) => b.pos - a.pos)) {
    if (out.slice(e.pos, e.end) !== e.from) { skipped.push(e); continue; }
    out = out.slice(0, e.pos) + e.to + out.slice(e.end);
  }
  return { text: out, skipped };
}

function main() {
  const args = process.argv.slice(2);
  const get = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const step = get('--step');
  if (!['legacy-md', 'roles', 'finish'].includes(step)) {
    console.error('usage: radius-codemod.mjs --step legacy-md|roles|finish [--include dir1,dir2] [--apply]');
    process.exit(2);
  }
  const apply = args.includes('--apply');
  const include = (get('--include') ?? '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  const root = resolve(new URL('../..', import.meta.url).pathname);
  let allow = {};
  try { allow = JSON.parse(readFileSync(new URL('./radius-allowlist.json', import.meta.url), 'utf8')); } catch { /* none */ }

  const byFile = new Map();
  for (const r of scanProject(root)) {
    if (include.length && !include.some((p) => r.file === p || r.file.startsWith(p.endsWith('/') ? p : `${p}/`) || r.file.startsWith(p))) continue;
    (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)).push(r);
  }
  let files = 0, edits = 0, skipped = 0;
  const transitions = {};
  for (const [file, recs] of byFile) {
    const plan = planEdits(recs, step, allow);
    if (!plan.length) continue;
    const abs = resolve(root, file);
    const { text, skipped: sk } = applyEdits(readFileSync(abs, 'utf8'), plan);
    files++; edits += plan.length - sk.length; skipped += sk.length;
    for (const e of plan) { const k = `${e.role}: ${e.from} -> ${e.to}`; transitions[k] = (transitions[k] || 0) + 1; }
    for (const e of sk) console.warn(`SKIPPED (source changed under the span) ${file}:${e.line} ${e.from}`);
    if (apply) writeFileSync(abs, text);
  }
  console.log(Object.entries(transitions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${String(v).padStart(5)}  ${k}`).join('\n'));
  console.log(`\n${apply ? 'APPLIED' : 'DRY RUN'}: ${edits} edits in ${files} files, ${skipped} skipped.${apply ? '' : ' Re-run with --apply to write.'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
