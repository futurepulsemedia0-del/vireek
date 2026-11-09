// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FLAG_GATED_PUBLIC_PATHS, STATIC_PUBLIC_PATHS, classifyRoute, collectRoutes, ROOT } from './routes.mjs';
import { isEndorsementEnabled } from './platformFlag.mjs';
import { ENDORSEMENT_EXACT_PATHS, isEndorsementSurfacePath } from '../../src/lib/brand/endorsement.ts';

describe('endorsement routes', () => {
  it('/legal/company is a classified public route and exists in App.tsx', () => {
    expect(FLAG_GATED_PUBLIC_PATHS).toContain('/legal/company');
    expect(classifyRoute('/legal/company')).toBe('static');
    expect(readFileSync(`${ROOT}/src/App.tsx`, 'utf8')).toContain('path="/legal/company"');
  });
  it('flag parsing is strict and OFF by default', () => {
    expect(isEndorsementEnabled('/nonexistent', {})).toBe(false);
    expect(isEndorsementEnabled('/nonexistent', { VITE_PLATFORM_ENDORSEMENT_ENABLED: 'yes' })).toBe(false);
    expect(isEndorsementEnabled('/nonexistent', { VITE_PLATFORM_ENDORSEMENT_ENABLED: 'true' })).toBe(true);
  });
  it('flag OFF: sitemap/prerender route list does not contain /legal/company', async () => {
    const prev = process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED;
    delete process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED;
    try {
      const paths = (await collectRoutes()).map((r) => r.path);
      if (!isEndorsementEnabled(ROOT)) expect(paths).not.toContain('/legal/company');
    } finally {
      if (prev !== undefined) process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED = prev;
    }
  }, 30000);
  it('flag ON: /legal/company is emitted exactly once', async () => {
    const prev = process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED;
    process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED = 'true';
    try {
      const paths = (await collectRoutes()).map((r) => r.path);
      expect(paths.filter((p) => p === '/legal/company')).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED;
      else process.env.VITE_PLATFORM_ENDORSEMENT_ENABLED = prev;
    }
  }, 30000);
  it('the Footer allowlist covers every sitemap path (no drift from routes.mjs)', () => {
    for (const p of STATIC_PUBLIC_PATHS) expect(isEndorsementSurfacePath(p), p).toBe(true);
    for (const p of ENDORSEMENT_EXACT_PATHS) expect(p.startsWith('/')).toBe(true);
  });
});
