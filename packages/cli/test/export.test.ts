// @vitest-environment node
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileSink, createStreamSink, inferFormat, runExport } from '../src/export.js';
import { ApiClient, type Page } from '../src/http.js';
import { BASE, KEY, jsonResponse } from './helpers.js';

function apiWith(rows: Record<string, unknown>[]) {
  const fetchImpl = (async (url: URL) => {
    const before = url.searchParams.get('before');
    const limit = Number(url.searchParams.get('limit'));
    const slice = rows.filter((r) => !before || String(r.created_at) < before).slice(0, limit);
    const page: Page = { data: slice, has_more: slice.length === limit, next_before: (slice.at(-1)?.created_at as string) ?? null };
    return jsonResponse(page);
  }) as unknown as typeof fetch;
  return new ApiClient({ baseUrl: BASE, apiKey: KEY, fetchImpl, sleep: async () => undefined });
}

const ROWS = [
  { id: 'a', created_at: '2026-10-03T00:00:00.000Z', caller_name: 'Ann, "AC" Co', caller_phone: '+15550001', tags: ['vip'], notes: '=cmd()' },
  { id: 'b', created_at: '2026-10-02T00:00:00.000Z', caller_name: null, caller_phone: '+15550002', tags: [], notes: 'line1\nline2' },
];

function memorySink() {
  let text = '';
  return { sink: createStreamSink({ write: (chunk: string) => ((text += chunk), true) }), text: () => text };
}

describe('runExport', () => {
  it('writes NDJSON one object per line', async () => {
    const { sink, text } = memorySink();
    const result = await runExport(apiWith(ROWS), 'calls', sink, { format: 'ndjson' });
    expect(result.rows).toBe(2);
    expect(text().trim().split('\n').map((l) => JSON.parse(l).id)).toEqual(['a', 'b']);
  });

  it('writes a valid JSON array, including when empty', async () => {
    const full = memorySink();
    await runExport(apiWith(ROWS), 'calls', full.sink, { format: 'json', pageSize: 1 });
    expect(JSON.parse(full.text())).toEqual(ROWS);
    const empty = memorySink();
    await runExport(apiWith([]), 'calls', empty.sink, { format: 'json' });
    expect(JSON.parse(empty.text())).toEqual([]);
  });

  it('writes RFC 4180 CSV with a header, guarded formulas and JSON-encoded nested values', async () => {
    const { sink, text } = memorySink();
    await runExport(apiWith(ROWS), 'calls', sink, { format: 'csv', pageSize: 1 });
    const lines = text().split('\r\n');
    expect(lines[0]).toBe('id,created_at,caller_name,caller_phone,tags,notes');
    expect(lines[1]).toBe(`a,2026-10-03T00:00:00.000Z,"Ann, ""AC"" Co",+15550001,"[""vip""]",'=cmd()`);
    expect(lines[2]).toBe('b,2026-10-02T00:00:00.000Z,,+15550002,[],"line1\nline2"');
  });

  it('can disable the formula guard and add a BOM', async () => {
    const { sink, text } = memorySink();
    await runExport(apiWith(ROWS), 'calls', sink, { format: 'csv', csvGuard: false, bom: true });
    expect(text().startsWith('\uFEFFid,')).toBe(true);
    expect(text()).toContain(',=cmd()');
  });

  it('reports columns that appear after the CSV header is fixed', async () => {
    const { sink } = memorySink();
    const rows = [{ id: 'a', created_at: '2026-10-03T00:00:00.000Z' }, { id: 'b', created_at: '2026-10-02T00:00:00.000Z', extra: 1 }];
    const result = await runExport(apiWith(rows), 'calls', sink, { format: 'csv', pageSize: 1 });
    expect(result.ignoredColumns).toEqual(['extra']);
  });

  it('applies since/until/max', async () => {
    const { sink, text } = memorySink();
    const result = await runExport(apiWith(ROWS), 'calls', sink, { format: 'ndjson', since: '2026-10-02T12:00:00.000Z' });
    expect(result.rows).toBe(1);
    expect(text()).toContain('"id":"a"');
  });
});

describe('inferFormat', () => {
  it('maps extensions and defaults to ndjson', () => {
    expect(inferFormat('out.csv')).toBe('csv');
    expect(inferFormat('OUT.JSON')).toBe('json');
    expect(inferFormat('out.jsonl')).toBe('ndjson');
    expect(inferFormat(undefined)).toBe('ndjson');
  });
});

describe('createFileSink', () => {
  it('publishes atomically: nothing at the final path until commit', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-exp-'));
    const target = path.join(dir, 'calls.csv');
    const sink = await createFileSink(target, false);
    await sink.write('a,b\r\n');
    await expect(access(target)).rejects.toThrow();
    await sink.commit();
    expect(await readFile(target, 'utf8')).toBe('a,b\r\n');
    await expect(access(`${target}.partial`)).rejects.toThrow();
  });

  it('removes the partial file on abort and never touches an existing target', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-exp-'));
    const target = path.join(dir, 'calls.csv');
    await writeFile(target, 'keep me');
    const sink = await createFileSink(target, true);
    await sink.write('new');
    await sink.abort();
    expect(await readFile(target, 'utf8')).toBe('keep me');
    await expect(access(`${target}.partial`)).rejects.toThrow();
  });

  it('refuses to overwrite without --force', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vireek-exp-'));
    const target = path.join(dir, 'calls.csv');
    await writeFile(target, 'x');
    await expect(createFileSink(target, false)).rejects.toThrow(/already exists/);
  });
});
