// Guards docs/ai-governance/iso42001-gap.md against drift:
//  - every evidence path cited in sections 3-4 really exists,
//  - every path listed as "absent" in section 6 really is absent (so the doc is updated when it appears),
//  - the summary counts match the tables, statuses are from the allowed set,
//  - the document never claims certification or conformity.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOC = 'docs/ai-governance/iso42001-gap.md';
const text = readFileSync(join(ROOT, DOC), 'utf8');

const STATUSES = new Set(['Met', 'Partial', 'Missing']);

/** Split the document at "## N." headings. */
function sections(md) {
  const out = new Map();
  let key = 'preamble';
  for (const line of md.split('\n')) {
    const m = /^##\s+(\d+)\./.exec(line);
    if (m) key = m[1];
    out.set(key, (out.get(key) ?? '') + line + '\n');
  }
  return out;
}

const SECTIONS = sections(text);
const PATH_TOKEN = /`([A-Za-z0-9_.\-/]+\/[A-Za-z0-9_.\-]+)`/g;
const pathsIn = (s) => [...s.matchAll(PATH_TOKEN)].map((m) => m[1]);

/** Rows of the tables in sections 3 and 4: | id | area | status | evidence | gap | */
function rows() {
  const body = (SECTIONS.get('3') ?? '') + (SECTIONS.get('4') ?? '');
  return body
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*(-+|ID)\s*\|/.test(l) && !/^\|\s*-/.test(l))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((c) => c.length === 5);
}

describe('iso42001-gap.md', () => {
  it('has the expected sections', () => {
    for (const n of ['1', '2', '3', '4', '5', '6', '7']) expect(SECTIONS.has(n)).toBe(true);
  });

  it('every row has an allowed status, evidence-or-none and a non-empty gap', () => {
    const r = rows();
    expect(r.length).toBeGreaterThanOrEqual(30);
    for (const [id, , status, evidence, gap] of r) {
      expect(STATUSES.has(status), `${id}: status ${status}`).toBe(true);
      expect(evidence.length, `${id}: evidence`).toBeGreaterThan(0);
      expect(gap.length, `${id}: gap`).toBeGreaterThan(0);
      if (status !== 'Missing' && !/^same as/i.test(evidence)) {
        expect(pathsIn(evidence).length, `${id}: needs at least one path`).toBeGreaterThan(0);
      }
    }
  });

  it('summary counts match the tables', () => {
    const r = rows();
    const count = (s) => r.filter((x) => x[2] === s).length;
    const summary = SECTIONS.get('2') ?? '';
    const cell = (label) => Number(new RegExp(`\\|\\s*\\**${label}\\**\\s*\\|\\s*\\**(\\d+)\\**\\s*\\|`).exec(summary)?.[1]);
    expect(cell('Met')).toBe(count('Met'));
    expect(cell('Partial')).toBe(count('Partial'));
    expect(cell('Missing')).toBe(count('Missing'));
    expect(cell('Total rows')).toBe(r.length);
  });

  it('every cited evidence path exists in the repository', () => {
    const cited = new Set([...pathsIn(SECTIONS.get('3') ?? ''), ...pathsIn(SECTIONS.get('4') ?? ''), ...pathsIn(SECTIONS.get('2') ?? '')]);
    const missing = [...cited].filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it('paths listed as absent in section 6 are still absent', () => {
    const absent = pathsIn(SECTIONS.get('6') ?? '');
    expect(absent.length).toBeGreaterThan(0);
    const present = absent.filter((p) => existsSync(join(ROOT, p)));
    // If this fails, the file now exists: move it into the evidence tables and update the counts.
    expect(present).toEqual([]);
  });

  it('never claims certification or conformity', () => {
    const plain = text.replace(/\*/g, ''); // ignore bold markers
    expect(plain).toMatch(/not certified/i);
    expect(plain).not.toMatch(/\b(vireek|we)\s+(is|are)\s+(iso\s*\/?\s*iec\s*42001\s+)?(certified|compliant|conformant)\b/i);
    expect(plain).not.toMatch(/\bconforms? to ISO/i);
  });

  it('marks interpretation as [VERIFY] and legal points as [COUNSEL]', () => {
    expect(text).toContain('[VERIFY');
    expect(text).toContain('[COUNSEL]');
  });
});
