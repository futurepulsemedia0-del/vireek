#!/usr/bin/env node
// scripts/naming/screen.mjs - naming SCREEN (not clearance) for candidate brand names.
//
// Usage:
//   node scripts/naming/screen.mjs --input names.json [options]
//
// Options:
//   --input <file>            JSON or CSV list of candidate names, 4-8 letters (required)
//   --brands <file>           brand list for the lookalike check (default: config/known-brands.json)
//   --affixes <file>          prefix/suffix config (default: config/affixes.json)
//   --out-dir <dir>           output directory (default: scripts/naming/out, git-ignored)
//   --weights <k=v,...>       override weights: pronounceability, internationalFit, lookalike,
//                             domainSignal, manualCheck (normalised to 100)
//   --timeout-ms <n>          per-request timeout (default 8000)
//   --retries <n>             retries per request after the first attempt (default 2, max 5)
//   --min-interval-ms <n>     minimum spacing per RDAP host (default 1000, floor 500)
//   --help
//
// Network: only the public IANA RDAP bootstrap and the registry RDAP servers it lists. It runs
// only when you start it by hand; it is never imported by the app and is not part of the bundle.
// Output never states that a domain or name can be obtained: see lib/rdap.mjs RDAP_STATUS.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildChecklist } from './lib/checklist.mjs';
import { parseCandidates } from './lib/input.mjs';
import { analyzeLinguistic, normalizeAffixConfig } from './lib/linguistic.mjs';
import { findLookalikes, normalizeBrandList } from './lib/lookalike.mjs';
import { DEFAULT_TLDS, createRdapClient, lookupDomains } from './lib/rdap.mjs';
import { parseWeights, scoreName, toCsv, toMarkdown, writeOutputs } from './lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const intOpt = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return n;
};

/** Pure orchestration, exported so it can be tested with an injected RDAP client. */
export async function runScreen({ names, brands, affixes, weights, client, onProgress = () => {} }) {
  const results = [];
  for (const [i, name] of names.entries()) {
    onProgress(`[${i + 1}/${names.length}] ${name}`);
    const domains = await lookupDomains(client, name, DEFAULT_TLDS);
    results.push(
      scoreName(
        {
          name,
          linguistic: analyzeLinguistic(name, affixes),
          lookalike: findLookalikes(name, brands),
          domains,
          checklist: buildChecklist(name, domains),
        },
        weights,
      ),
    );
  }
  return results;
}

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      brands: { type: 'string' },
      affixes: { type: 'string' },
      'out-dir': { type: 'string' },
      weights: { type: 'string' },
      'timeout-ms': { type: 'string' },
      retries: { type: 'string' },
      'min-interval-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help || !values.input) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 24).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(values.help ? 0 : 2);
  }

  const ext = path.extname(values.input).toLowerCase();
  const { accepted, rejected, duplicates } = parseCandidates(
    readFileSync(values.input, 'utf8'),
    ext === '.json' ? 'json' : ext === '.csv' ? 'csv' : 'auto',
  );
  if (!accepted.length) throw new Error('No valid candidate names (4-8 letters, a-z) found in the input.');

  const brands = normalizeBrandList(readJson(values.brands ?? path.join(HERE, 'config/known-brands.json')));
  const affixes = normalizeAffixConfig(readJson(values.affixes ?? path.join(HERE, 'config/affixes.json')));
  const weights = parseWeights(values.weights);
  const client = createRdapClient({
    timeoutMs: intOpt(values['timeout-ms'] ?? 8000, 'timeout-ms', 1000, 60000),
    retries: intOpt(values.retries ?? 2, 'retries', 0, 5),
    minIntervalMs: intOpt(values['min-interval-ms'] ?? 1000, 'min-interval-ms', 500, 60000),
  });

  const names = accepted.map((a) => a.name);
  console.error(`Screening ${names.length} name(s) x ${DEFAULT_TLDS.length} TLDs (sequential, rate-limited)...`);
  const results = await runScreen({
    names,
    brands,
    affixes,
    weights,
    client,
    onProgress: (m) => console.error(m),
  });

  const rdapNotes = [];
  const errors = results.flatMap((r) => r.domains).filter((d) => d.status === 'lookup error');
  if (errors.length) {
    rdapNotes.push(`${errors.length} lookup error(s); first: ${errors[0].domain} - ${errors[0].detail}. Re-run later or check by hand.`);
  }
  for (const a of accepted.filter((x) => x.normalized)) rdapNotes.push(`"${a.original}" was normalised to "${a.name}" (accents folded).`);

  const generatedAt = new Date().toISOString();
  const { mdPath, csvPath } = writeOutputs({
    dir: path.resolve(values['out-dir'] ?? path.join(HERE, 'out')),
    stamp: generatedAt.replace(/[:.]/g, '-'),
    markdown: toMarkdown({ generatedAt, weights, results, rejected, duplicates, rdapNotes }),
    csv: toCsv(results),
  });
  console.error(`Wrote ${mdPath}\nWrote ${csvPath}\nReminder: this is a screen, not clearance. Manual checks are NOT DONE.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`naming-screen: ${err.message}`);
    process.exit(1);
  });
}
