#!/usr/bin/env node
// scripts/safety/hazard-content-check.mjs
//
// CI gate for safety-critical (hazard) content governance. See docs/safety/hazard-content-governance.md.
//
//   node --experimental-strip-types --no-warnings scripts/safety/hazard-content-check.mjs            default gate
//   ... --strict                       release gate: ALSO fail when any floor / guardrail / instructional item lacks a current review
//   ... --print-hashes                 print contentHash for every registered item (to put into a review record)
//   ... --json                         machine-readable report
//   --today=YYYY-MM-DD                 override "today" (tests)
//
// Default gate FAILS when
//   * a registered file or its start / end marker is missing (the inventory has rotted),
//   * a review on record is expired, malformed, or stale (text or version changed after the review),
//   * a file that looks like an AI prompt / content file mentions a hazard domain and is neither registered nor acknowledged
//     in NOT_HAZARD_GUIDANCE (the inventory cannot silently grow),
//   * an acknowledged file no longer exists or no longer mentions a hazard (stale acknowledgement).
// Missing reviews are reported as BACKLOG in the default gate (the runtime gate already withholds instructional content) and fail only with --strict.
// This tool inventories and enforces process. It does NOT judge whether any guidance is correct. [COUNSEL]

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = process.env.VIREEK_ROOT ? resolve(process.env.VIREEK_ROOT) : resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const TEST_FILE = /(\.test\.|\.spec\.|\.live\.|\.redteam\.|\/__tests__\/|\/golden\/)/;
const PROMPT_MARKER = /(?:PROMPT|INSTRUCTIONS|SYSTEM)[A-Z_]*\s*=|systemPrompt|You are (?:a|an|the) |Safety first/;
const HAZARD_WORD = /carbon monoxide|\bgas (?:leak|smell|line|valve)|smell(?:s)? (?:of )?gas|refrigerant|electrical fire|sparking|pilot light|\bbreakers?\b|live wir|\bgas\b/i;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

export function extractRegion(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) return { ok: false, why: `start marker not found: ${JSON.stringify(start)}` };
  if (end === undefined) return { ok: true, text: text.slice(i) };
  const j = text.indexOf(end, i + start.length);
  if (j < 0) return { ok: false, why: `end marker not found after start: ${JSON.stringify(end)}` };
  return { ok: true, text: text.slice(i, j + end.length) };
}

export async function runCheck({ root = ROOT, strict = false, today = new Date() } = {}) {
  const gov = await import(pathToFileURL(join(root, 'supabase/functions/_shared/safety-governance/hazardGovernance.ts')).href);
  const reg = await import(pathToFileURL(join(root, 'supabase/functions/_shared/safety-governance/hazardRegistry.ts')).href);
  const errors = [];
  const backlog = [];
  const items = [];

  const ids = new Set();
  for (const it of reg.HAZARD_INVENTORY) {
    if (ids.has(it.id)) errors.push(`duplicate inventory id ${it.id}`);
    ids.add(it.id);
    const abs = join(root, it.file);
    if (!existsSync(abs)) { errors.push(`${it.id}: file not found: ${it.file}`); continue; }
    const region = extractRegion(readFileSync(abs, 'utf8'), it.start, it.end);
    if (!region.ok) { errors.push(`${it.id}: ${region.why} in ${it.file}`); continue; }
    const hash = gov.contentHash(region.text);
    const domainsFound = gov.detectHazardDomains(region.text);
    const review = reg.HAZARD_REVIEWS[it.id] ?? null;
    // Version of a code-resident item is the version in its review record; an unreviewed item has no version yet.
    const verdict = gov.evaluateReview(review, { version: review?.version ?? 1, hash }, today);
    const row = { id: it.id, tier: it.tier, kind: it.kind, file: it.file, hash, status: verdict.status, reasons: verdict.reasons, domainsFound };
    items.push(row);
    if (it.owner.startsWith('[OWNER')) row.ownerPending = true;
    if (it.tier !== 'none' && domainsFound.length === 0 && it.kind !== 'detector') errors.push(`${it.id}: registered as hazard content but no hazard domain found in the region (marker drift?)`);
    for (const d of domainsFound) if (!it.domains.includes(d)) errors.push(`${it.id}: region touches "${d}" which is not declared in the inventory (declare it)`);
    if (verdict.status === 'expired' || verdict.status === 'invalid' || verdict.status === 'stale') errors.push(`${it.id}: review ${verdict.status}: ${verdict.reasons.join('; ')}`);
    else if (verdict.status === 'unreviewed') backlog.push(`${it.id} (${it.tier})`);
  }
  for (const id of Object.keys(reg.HAZARD_REVIEWS)) if (!ids.has(id)) errors.push(`review on record for unknown inventory id ${id}`);

  // Discovery: prompt-like files that mention a hazard word must be registered or acknowledged.
  const registeredFiles = new Set(reg.HAZARD_INVENTORY.map((i) => i.file));
  const ack = reg.NOT_HAZARD_GUIDANCE;
  const discovered = [];
  for (const abs of walk(join(root, 'supabase/functions'))) {
    const rel = relative(root, abs).split(sep).join('/');
    if (TEST_FILE.test(rel) || rel.includes('/safety-governance/')) continue;
    const text = readFileSync(abs, 'utf8');
    if (!PROMPT_MARKER.test(text) || !HAZARD_WORD.test(text)) continue;
    discovered.push(rel);
    if (!registeredFiles.has(rel) && !(rel in ack)) errors.push(`unregistered hazard-bearing prompt/content file: ${rel} (add it to HAZARD_INVENTORY or NOT_HAZARD_GUIDANCE with a reason)`);
  }
  for (const [file, reason] of Object.entries(ack)) {
    if (!reason || reason.trim().length < 8) errors.push(`acknowledgement without a reason: ${file}`);
    if (registeredFiles.has(file)) errors.push(`file is both registered and acknowledged: ${file}`);
    if (!existsSync(join(root, file))) errors.push(`stale acknowledgement, file not found: ${file}`);
    else if (!HAZARD_WORD.test(readFileSync(join(root, file), 'utf8'))) errors.push(`stale acknowledgement, no hazard word any more: ${file}`);
  }

  if (strict) for (const b of backlog) errors.push(`release gate: no current review for ${b}`);
  return { ok: errors.length === 0, errors, backlog, items, discovered, strict };
}

async function main() {
  const argv = process.argv.slice(2);
  const todayArg = argv.find((a) => a.startsWith('--today='));
  const today = todayArg ? new Date(`${todayArg.slice(8)}T00:00:00Z`) : new Date();
  const r = await runCheck({ strict: argv.includes('--strict'), today });
  if (argv.includes('--print-hashes')) { for (const i of r.items) console.log(`${i.id}\t${i.hash}`); return; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); }
  const byStatus = {};
  for (const i of r.items) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
  console.log(`hazard content: ${r.items.length} inventory items, ${r.discovered.length} discovered files; statuses ${JSON.stringify(byStatus)}`);
  if (r.backlog.length) console.log(`review backlog (${r.backlog.length}): ${r.backlog.join(', ')}`);
  if (!r.ok) { for (const e of r.errors) console.error(`::error::hazard-content: ${e}`); process.exit(1); }
  console.log(`OK${r.strict ? ' (strict)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
