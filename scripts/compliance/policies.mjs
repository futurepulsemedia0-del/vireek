// scripts/compliance/policies.mjs
//
// Hashes the policy files in docs/compliance/policies/ so the database can bind a management approval to
// the EXACT text that was approved. If a policy file changes after approval, its hash no longer matches
// and the policy shows "content changed since approval" until it is re-approved.
//
// Pure helpers (no network). The CLI wrapper is `evidence.mjs sync-policies`.
// READINESS tooling: a hash proves which text was approved, nothing about whether it is followed.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './lib.mjs';

export const POLICIES_DIR = 'docs/compliance/policies';
export const SLUG_RE = /^[a-z][a-z0-9-]{2,60}$/;

/** LF endings, no trailing whitespace per line, exactly one final newline. Same text => same hash on every OS. */
export function normalizePolicyText(text) {
  return `${String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n+$/g, '')}\n`;
}

export const hashPolicyText = (text) => sha256Hex(normalizePolicyText(text));

export function policyTitle(text, fallback) {
  const m = /^#\s+(.+?)\s*$/m.exec(String(text));
  return (m ? m[1] : fallback).slice(0, 160);
}

/** @returns {{slug:string,title:string,source_path:string,sha256:string}[]} sorted by slug; README.md is not a policy. */
export function buildPolicyItems(root, { readdir = readdirSync, read = readFileSync, exists = existsSync } = {}) {
  const dir = join(root, POLICIES_DIR);
  if (!exists(dir)) throw new Error(`${POLICIES_DIR} not found`);
  const items = [];
  for (const name of readdir(dir).filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort()) {
    const slug = name.slice(0, -3);
    if (!SLUG_RE.test(slug)) throw new Error(`policy file name "${name}" is not a valid slug`);
    const text = read(join(dir, name), 'utf8');
    items.push({ slug, title: policyTitle(text, slug), source_path: `${POLICIES_DIR}/${name}`, sha256: hashPolicyText(text) });
  }
  if (items.length === 0) throw new Error('no policy files found');
  return items;
}
