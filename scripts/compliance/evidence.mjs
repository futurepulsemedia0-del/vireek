#!/usr/bin/env node
// scripts/compliance/evidence.mjs
//
//   node scripts/compliance/evidence.mjs collect --out evidence-out [--only repo|github] [--window-days 30]
//   node scripts/compliance/evidence.mjs sync                               registry  -> compliance_controls
//   node scripts/compliance/evidence.mjs push --dir evidence-out            envelopes -> compliance_evidence
//   node scripts/compliance/evidence.mjs collect-remote [--modules a,b]     run Supabase-side collectors
//   node scripts/compliance/evidence.mjs manual --collector manual.training \
//        --attested-by "Full Name" --document-ref "where the document lives" [--document-file ./x.pdf] [--note "..."]
//
// Environment:
//   COMPLIANCE_INGEST_URL     full URL of the compliance-evidence edge function
//   COMPLIANCE_INGEST_TOKEN   shared secret (also set as a Supabase secret)
//   COMPLIANCE_GITHUB_TOKEN   fine-grained read-only token (collect only)
//   GITHUB_REPOSITORY         owner/repo (set automatically in GitHub Actions)
//   GITHUB_RUN_ID, GITHUB_SERVER_URL   (set automatically in GitHub Actions; used as run_ref)

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COLLECTORS, makeEnvelope, sha256Hex, stableStringify } from './lib.mjs';
import { REPO_ROOT, loadRegistry, validateRegistry } from './validate-controls.mjs';
import { collectRepo } from './collect-repo.mjs';
import { collectGithub, createGithubClient } from './collect-github.mjs';

export const MAX_BATCH = 20;

export function runRefFromEnv(env = process.env) {
  if (env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY) return `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  return 'local';
}

/** POST JSON with bounded retries on network errors, 429 and 5xx. 4xx is final. */
export async function postJson(url, token, body, { fetchImpl = globalThis.fetch, retries = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 300) };
      }
      if (res.ok) return json;
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}: ${json?.error ?? text.slice(0, 200)}`), { final: true });
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (e?.final) throw e;
      lastErr = e;
    }
    if (attempt < retries) await sleep(500 * 2 ** attempt);
  }
  throw lastErr ?? new Error('request failed');
}

export function buildManualEnvelope({ collector, attestedBy, documentRef, documentFile, note, runRef = 'manual', now = new Date(), readFile = readFileSync }) {
  if (!collector?.startsWith('manual.') || COLLECTORS[collector]?.runsIn !== 'manual') throw new Error(`"${collector}" is not a manual collector`);
  if (!attestedBy || attestedBy.trim().length < 3) throw new Error('--attested-by (full name of the person attesting) is required');
  if (!documentRef || documentRef.trim().length < 3) throw new Error('--document-ref (where the document is stored) is required');
  const documentSha256 = documentFile ? sha256Hex(readFile(documentFile)) : null;
  return makeEnvelope({
    collector,
    result: 'collected',
    outcome: 'info',
    summary: { attestedBy: attestedBy.trim(), documentRef: documentRef.trim(), hasDocumentHash: Boolean(documentSha256), note: note ? String(note).slice(0, 500) : null },
    data: { documentSha256, documentFileName: documentFile ? basename(documentFile) : null },
    runRef,
    collectedAt: now,
  });
}

export async function runCollect({ out, only, windowDays = 30, env = process.env, now = new Date(), root = REPO_ROOT, fetchImpl }) {
  const runRef = runRefFromEnv(env);
  const envelopes = [];
  if (!only || only === 'repo') envelopes.push(...collectRepo({ root, now, runRef }));
  if (!only || only === 'github') {
    const client = createGithubClient({ token: env.COMPLIANCE_GITHUB_TOKEN, fetchImpl });
    envelopes.push(...(await collectGithub({ client, repo: env.GITHUB_REPOSITORY, branch: env.COMPLIANCE_BRANCH || 'main', now, windowDays, runRef })));
  }
  mkdirSync(out, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const files = [];
  for (const e of envelopes) {
    const file = `${stamp}-${e.collector}.json`;
    const bytes = stableStringify(e);
    writeFileSync(join(out, file), bytes);
    files.push({ file, collector: e.collector, result: e.result, outcome: e.outcome, sha256: sha256Hex(bytes) });
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generatedAt: now.toISOString(), runRef, files }, null, 2));
  return { envelopes, files };
}

export async function runSync({ url, token, fetchImpl, root = REPO_ROOT }) {
  const reg = loadRegistry(root);
  const { errors } = validateRegistry(reg, { exists: (p) => existsSync(join(root, p)) });
  if (errors.length) throw new Error(`registry invalid: ${errors[0]} (+${errors.length - 1} more)`);
  return postJson(url, token, { action: 'sync_controls', registry: reg }, { fetchImpl });
}

export async function runPush({ dir, url, token, fetchImpl }) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'manifest.json').sort();
  const records = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const results = [];
  for (let i = 0; i < records.length; i += MAX_BATCH) {
    const res = await postJson(url, token, { action: 'ingest', records: records.slice(i, i + MAX_BATCH) }, { fetchImpl });
    results.push(...(res.results ?? []));
  }
  return results;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function need(env, name) {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [cmd] = argv;
  const args = parseArgs(argv.slice(1));
  switch (cmd) {
    case 'collect': {
      const { envelopes } = await runCollect({ out: resolve(args.out || 'evidence-out'), only: args.only, windowDays: Number(args['window-days'] || 30), env });
      for (const e of envelopes) console.log(`${e.result.padEnd(9)} ${e.outcome.padEnd(5)} ${e.collector}`);
      return 0;
    }
    case 'sync': {
      const res = await runSync({ url: need(env, 'COMPLIANCE_INGEST_URL'), token: need(env, 'COMPLIANCE_INGEST_TOKEN') });
      console.log(`✔ synced ${res.controls ?? '?'} controls, ${res.claimLinks ?? '?'} claim links${res.orphaned?.length ? `; orphaned in DB (not in registry): ${res.orphaned.join(', ')}` : ''}`);
      return 0;
    }
    case 'push': {
      const results = await runPush({ dir: resolve(args.dir || 'evidence-out'), url: need(env, 'COMPLIANCE_INGEST_URL'), token: need(env, 'COMPLIANCE_INGEST_TOKEN') });
      let bad = 0;
      for (const r of results) {
        if (r.status === 'rejected') bad++;
        console.log(`${String(r.status).padEnd(9)} ${r.collector}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      return bad ? 1 : 0;
    }
    case 'collect-remote': {
      const modules = typeof args.modules === 'string' ? args.modules.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const res = await postJson(need(env, 'COMPLIANCE_INGEST_URL'), need(env, 'COMPLIANCE_INGEST_TOKEN'), { action: 'collect', modules, run_ref: runRefFromEnv(env) });
      let bad = 0;
      for (const r of res.results ?? []) {
        if (r.status === 'rejected') bad++;
        console.log(`${String(r.status).padEnd(9)} ${r.collector}${r.reason ? ` — ${r.reason}` : ''}`);
      }
      return bad ? 1 : 0;
    }
    case 'manual': {
      const e = buildManualEnvelope({
        collector: args.collector,
        attestedBy: args['attested-by'],
        documentRef: args['document-ref'],
        documentFile: typeof args['document-file'] === 'string' ? args['document-file'] : undefined,
        note: typeof args.note === 'string' ? args.note : undefined,
        runRef: `manual:${env.USER ?? 'unknown'}`,
      });
      const res = await postJson(need(env, 'COMPLIANCE_INGEST_URL'), need(env, 'COMPLIANCE_INGEST_TOKEN'), { action: 'ingest', records: [e] });
      console.log(JSON.stringify(res.results ?? res));
      return (res.results ?? []).some((r) => r.status === 'rejected') ? 1 : 0;
    }
    default:
      console.error('usage: evidence.mjs <collect|sync|push|collect-remote|manual> [options]  (see header of this file)');
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    },
  );
}
