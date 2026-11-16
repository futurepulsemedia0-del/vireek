// @vitest-environment node
// Repo-wide guard: Deno edge functions must never import browser/React modules (the '@/' alias, .tsx files,
// src/components|hooks|pages|contexts, react*). Vitest resolves '@/' to /src, so only a static scan catches this.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(process.cwd(), 'supabase', 'functions');
const SPEC = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p);
    return [p];
  });

const isForbidden = (s: string) =>
  s.startsWith('@/') ||
  /\.tsx$/.test(s) ||
  /(^|\/)src\/(components|hooks|pages|contexts)\//.test(s) ||
  /^(react|react-dom|react-router-dom|lucide-react)(\/|$)/.test(s);

describe('edge functions import hygiene', () => {
  it('detector flags the known-bad import', () => {
    const found = [...'import { SealedText } from "@/components/trust-pack/SealedContent";'.matchAll(SPEC)].map((m) => m[1]);
    expect(found.map(isForbidden)).toEqual([true]);
  });

  it('no non-test edge-function source imports browser/React code', () => {
    const files = walk(ROOT).filter(
      (f) => /\.(ts|tsx|mts)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f) && !f.split('\\').join('/').includes('/_shared/testing/'),
    );
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(SPEC)) {
        if (isForbidden(m[1])) violations.push(`${relative(process.cwd(), f)} -> ${m[1]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
