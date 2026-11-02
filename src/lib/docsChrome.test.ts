import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  WEBHOOK_EVENTS,
  listOperations,
} from '../../supabase/functions/api-v1/contract';
import { QUICKSTARTS } from '../../supabase/functions/api-v1/quickstarts';
import { DOCS_PAGES, buildDocsIndex, editOnGithubUrl, pagerFor, searchDocs } from './docsIndex';
import { buildInsomniaExport } from './insomnia';
import { formatDuration, timeToFirstSuccess } from './quickstartMetrics';

describe('docs search index', () => {
  const index = buildDocsIndex();
  it('covers every operation, error code and webhook event, with unique ids', () => {
    const ids = index.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const op of listOperations()) expect(ids).toContain(`op-${op.id}`);
    for (const e of ERROR_CATALOG) expect(ids).toContain(`err-${e.code}`);
    for (const w of WEBHOOK_EVENTS) expect(ids).toContain(`wh-${w.event}`);
  });
  it('finds things by what developers type', () => {
    expect(searchDocs(index, '429')[0]?.title).toMatch(/rate_limited/);
    expect(searchDocs(index, 'allowlist').some((r) => r.id === 'g-keys')).toBe(true);
    expect(searchDocs(index, 'hmac')[0]?.section).toBe('Webhooks');
    expect(searchDocs(index, '/calls')[0]?.section).toBe('Endpoints');
    expect(searchDocs(index, 'rate_limited')[0]?.id).toBe('err-rate_limited');
    expect(searchDocs(index, '')).toEqual([]);
    expect(searchDocs(index, 'zzzzqqq')).toEqual([]);
    expect(searchDocs(index, 'e', 3).length).toBeLessThanOrEqual(3);
  });
  it('every internal href points at a page in the docs or the dashboard', () => {
    for (const e of index) expect(e.href).toMatch(/^\/(docs|developers\/|dashboard\/)/);
  });
});

describe('pager, links, versions', () => {
  it('orders pages and links neighbours', () => {
    expect(pagerFor('/docs')).toMatchObject({
      prev: null,
      next: { path: '/developers/quickstarts' },
    });
    expect(pagerFor('/developers/api-reference/')).toMatchObject({
      prev: { path: '/developers/quickstarts' },
      next: { path: '/sandbox' },
    });
    expect(pagerFor(DOCS_PAGES.at(-1)!.path).next).toBeNull();
    expect(pagerFor('/elsewhere')).toEqual({ prev: null, next: null });
  });
  it('edit-on-GitHub only renders for a valid GitHub repo URL', () => {
    expect(editOnGithubUrl('https://github.com/acme/vireek.git/', '/src/a.tsx')).toBe(
      'https://github.com/acme/vireek/edit/main/src/a.tsx',
    );
    expect(editOnGithubUrl(undefined, 'a')).toBeNull();
    expect(editOnGithubUrl('https://evil.example/acme/vireek', 'a')).toBeNull();
    expect(editOnGithubUrl('javascript:alert(1)', 'a')).toBeNull();
  });
});

describe('quickstarts, metrics, Insomnia', () => {
  it('quickstarts have steps, a filename and no hard-coded keys', () => {
    expect(QUICKSTARTS.length).toBeGreaterThanOrEqual(3);
    for (const q of QUICKSTARTS) {
      expect(q.steps.length).toBeGreaterThanOrEqual(3);
      expect(q.code).not.toMatch(/vrk_(live|test)_[A-Za-z0-9]/);
      expect(q.code).toContain('VIREEK_API_KEY');
      expect(q.code).toContain('OK:');
    }
  });
  it('measures time to first success: first 2xx at/after creation, best key wins, none = null', () => {
    const keys = [
      { id: 'a', created_at: '2026-10-01T10:00:00Z' },
      { id: 'b', created_at: '2026-10-01T10:00:00Z' },
    ];
    const logs = [
      { api_key_id: 'a', status: 401, created_at: '2026-10-01T10:00:05Z' },
      { api_key_id: 'a', status: 200, created_at: '2026-10-01T10:05:00Z' },
      { api_key_id: 'b', status: 200, created_at: '2026-10-01T10:02:10Z' },
      { api_key_id: 'b', status: 200, created_at: '2026-10-01T09:00:00Z' },
    ];
    expect(timeToFirstSuccess(keys, logs)).toEqual({ keyId: 'b', seconds: 130 });
    expect(timeToFirstSuccess(keys, [])).toBeNull();
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(130)).toBe('2m 10s');
    expect(formatDuration(3 * 3600 + 120)).toBe('3h 2m');
  });
  it('Insomnia export has one request per operation, parented to a resource folder', () => {
    const ex = buildInsomniaExport('https://h/api-v1') as {
      __export_format: number;
      resources: { _id: string; _type: string; parentId?: string; url?: string }[];
    };
    expect(ex.__export_format).toBe(4);
    const reqs = ex.resources.filter((r) => r._type === 'request');
    expect(reqs).toHaveLength(listOperations().length);
    const ids = new Set(ex.resources.map((r) => r._id));
    expect(ids.size).toBe(ex.resources.length);
    for (const r of reqs) {
      expect(ids.has(r.parentId!)).toBe(true);
      expect(r.url).toContain('{{ _.base_url }}');
    }
  });
});
