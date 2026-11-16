// @vitest-environment node
// Smoke test for data-retention-sweep. Vitest aliases '@' to /src, so a bad '@/...' import would still load here;
// the static guard is what catches it. `deno check` remains the authoritative type check.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const specifiers = [...source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);

describe('data-retention-sweep smoke', () => {
  let handler: Handler;

  beforeEach(async () => {
    handler = await loadHandler(() => import('./index.ts'), {
      SUPABASE_URL: 'http://db.test',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
    });
  });

  it('loads and registers a Deno.serve handler', () => {
    expect(typeof handler).toBe('function');
  });

  it('answers CORS preflight without touching the database', async () => {
    const res = await handler(options());
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('finds import specifiers (guards the regex itself)', () => {
    expect(specifiers.length).toBeGreaterThanOrEqual(3);
  });

  it('imports nothing from the React/browser app', () => {
    const bad = specifiers.filter((s) => s.startsWith('@/') || /\.tsx$/.test(s) || /(^|\/)src\/(components|hooks|pages|contexts)\//.test(s));
    expect(bad).toEqual([]);
  });

  it('only uses relative, npm:, jsr: or node: specifiers', () => {
    const odd = specifiers.filter((s) => !/^(\.{1,2}\/|npm:|jsr:|node:)/.test(s));
    expect(odd).toEqual([]);
  });
});
