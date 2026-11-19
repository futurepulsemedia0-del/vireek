#!/usr/bin/env node
// scripts/supply-chain/pin-actions.mjs
//
// Pins third-party GitHub Actions to full commit SHAs in one workflow file.
//   --check  (default) exit 1 if any `uses:` is not a 40-hex SHA (offline, no network)
//   --write  resolve each `owner/repo@<tag>` or `@<TAG>` to its commit SHA via `git ls-remote`
//            and rewrite the line as `owner/repo@<sha> # <tag>`  (needs network + git)
// Usage: node scripts/supply-chain/pin-actions.mjs [--check|--write] [workflow.yml]
//
// Placeholders look like `actions/checkout@PIN-ME # v4.2.2`: the comment holds the tag to resolve.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const DEFAULT = '.github/workflows/sbom-provenance.yml';
const SHA = /^[0-9a-f]{40}$/;
const USES = /^(\s*(?:-\s+)?uses:\s*)([^\s@#]+)@([^\s#]+)(\s*#\s*(\S+))?\s*$/;

export function scan(text) {
  return text.split('\n').flatMap((line, i) => {
    const m = USES.exec(line);
    if (!m || m[2].startsWith('./') || m[2].startsWith('docker://')) return [];
    return [{ line: i, prefix: m[1], action: m[2], ref: m[3], tag: m[5] ?? (SHA.test(m[3]) ? null : m[3]) }];
  });
}

function resolveSha(action, tag) {
  const [owner, repo] = action.split('/');
  const url = `https://github.com/${owner}/${repo}.git`;
  const out = execFileSync('git', ['ls-remote', url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: 'utf8' });
  const rows = out.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/));
  const peeled = rows.find(([, r]) => r.endsWith('^{}')) ?? rows[0]; // annotated tags: use the commit
  if (!peeled || !SHA.test(peeled[0])) throw new Error(`cannot resolve ${action}@${tag}`);
  return peeled[0];
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const file = args.find((a) => !a.startsWith('--')) ?? DEFAULT;
  const text = readFileSync(file, 'utf8');
  const entries = scan(text);
  const bad = entries.filter((e) => !SHA.test(e.ref));
  if (!write) {
    for (const e of bad) console.error(`${file}:${e.line + 1}: ${e.action}@${e.ref} is not pinned to a commit SHA`);
    console.log(`pin-actions: ${entries.length - bad.length}/${entries.length} pinned`);
    process.exit(bad.length ? 1 : 0);
  }
  const lines = text.split('\n');
  for (const e of bad) {
    if (!e.tag || e.tag === 'PIN-ME') throw new Error(`line ${e.line + 1}: put the tag in a trailing "# vX.Y.Z" comment`);
    lines[e.line] = `${e.prefix}${e.action}@${resolveSha(e.action, e.tag)} # ${e.tag}`;
  }
  writeFileSync(file, lines.join('\n'));
  console.log(`pin-actions: pinned ${bad.length} action(s) in ${file}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) main();
