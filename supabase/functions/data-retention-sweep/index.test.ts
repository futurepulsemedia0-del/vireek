// @vitest-environment node
// Smoke test for data-retention-sweep: the module must load under the Deno-style harness, and it must never import
// browser/React code. NOTE: Vitest aliases '@' to /src, so a bad '@/...' import would load fine here. The static
// guard below is what actually catches it; `deno check` is the authoritative type check.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, options, type Handler } from '../_shared/testing/edgeHarness.ts';

const sb = vi.hoisted(() => ({ create: ((): unknown => { throw new Error('createClient not wired'); }) as (...a: unknown[]) => unknown }));
vi.mock('npm:@supabase/supabase-js@2.57.4', () => ({ createClient: (...a: unknown[]) => sb.create(...a) }));

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const importSpecifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);

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

  it('has import statements to inspect (guards the regex itself)', () => {
    expect(importSpecifiers.length).toBeGreaterThanOrEqual(3);
  });

  it('imports nothing from the React/browser app (no @/ alias, no src/, no .tsx)', () => {
    const bad = importSpecifiers.filter(
      (s) => s.startsWith('@/') || /(^|\/)src\//.test(s) || /\.tsx?x$/.test(s) && s.endsWith('.tsx') || /components\//.test(s),
    );
    expect(bad).toEqual([]);
  });

  it('only uses relative, npm:, jsr: or node: specifiers', () => {
    const odd = importSpecifiers.filter((s) => !/^(\.{1,2}\/|npm:|jsr:|node:|https:\/\/)/.test(s));
    expect(odd).toEqual([]);
  });
});
