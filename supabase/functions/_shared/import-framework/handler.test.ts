import { describe, expect, it } from 'vitest';
import { handleFrameworkRequest } from './handler.ts';
import type { HandlerDeps } from './handler.ts';
import { IMPORT_ENTITIES } from './entities.ts';
import { createMemorySink, createMemoryStore } from './memory.ts';
import { CUSTOMERS_CSV, JOBS_CSV, MAPPING, clone, createKit } from './testFixtures.ts';

function deps(over: Partial<HandlerDeps> = {}) {
  const k = createKit();
  const d: HandlerDeps = { tenantId: 'tenant-a', actorId: 'u1', moduleEnabled: true, canImport: true, store: createMemoryStore(k.backend, 'tenant-a'), makeSink: () => createMemorySink(k.target, 'tenant-a'), defs: IMPORT_ENTITIES, now: k.now, ...over };
  return { k, d };
}
const body = (extra: Record<string, unknown> = {}) => ({ action: 'dry_run', scope_key: 'acme-2027', mapping: clone(MAPPING), files: { customers: CUSTOMERS_CSV, jobs: JOBS_CSV }, ...extra });

describe('import-framework handler', () => {
  it('is a no-op wall when the module is OFF (before anything else is evaluated)', async () => {
    const { k, d } = deps({ moduleEnabled: false });
    const r = await handleFrameworkRequest(d, body({ action: 'start' }));
    expect(r.status).toBe(403); expect(r.body.error).toBe('module_disabled');
    expect(k.backend.runs.size + k.target.records.size).toBe(0);
  });
  it('requires the import permission', async () => {
    const { d } = deps({ canImport: false });
    expect((await handleFrameworkRequest(d, body())).status).toBe(403);
  });
  it('validates input shape', async () => {
    const { d } = deps();
    expect((await handleFrameworkRequest(d, null)).status).toBe(400);
    expect((await handleFrameworkRequest(d, body({ scope_key: 'Bad Scope!' }))).status).toBe(400);
    expect((await handleFrameworkRequest(d, body({ action: 'nuke' }))).status).toBe(400);
    expect((await handleFrameworkRequest(d, body({ files: {} }))).status).toBe(400);
    expect((await handleFrameworkRequest(d, body({ source: 'servicetitan' }))).status).toBe(400);
    expect((await handleFrameworkRequest(d, body({ files: { customers: 'A,A\n1,2' } }))).status).toBe(422);
  });
  it('dry_run returns the report; an invalid mapping is a report, not a crash', async () => {
    const { d } = deps();
    const ok = await handleFrameworkRequest(d, body());
    expect(ok.status).toBe(200);
    expect((ok.body.report as { canCommit: boolean }).canCommit).toBe(true);
    const bad = body(); (bad.mapping as any).entities.customers.fields.email.from = 'Nope';
    expect(((await handleFrameworkRequest(d, bad)).body.report as { canCommit: boolean }).canCommit).toBe(false);
  });
  it('treats a missing or non-object mapping as invalid (no crash)', async () => {
    const { d } = deps();
    const r = await handleFrameworkRequest(d, body({ action: 'start', mapping: undefined }));
    expect(r.status).toBe(422);
    const dry = await handleFrameworkRequest(d, body({ mapping: 'x' }));
    expect((dry.body.report as { canCommit: boolean }).canCommit).toBe(false);
  });
  it('start refuses an invalid mapping with 422 and details', async () => {
    const { d } = deps();
    const bad = body({ action: 'start' }); (bad.mapping as any).entities.customers.fields.email.from = 'Nope';
    const r = await handleFrameworkRequest(d, bad);
    expect(r.status).toBe(422); expect(r.body.error).toBe('mapping_invalid');
  });
  it('start -> status -> rollback end to end', async () => {
    const { k, d } = deps();
    const s = await handleFrameworkRequest(d, body({ action: 'start' }));
    expect(s.status).toBe(200); expect(s.body.status).toBe('completed');
    const st = await handleFrameworkRequest(d, { action: 'status', scope_key: 'acme-2027' });
    expect((st.body.runs as unknown[]).length).toBe(1);
    const rb = await handleFrameworkRequest(d, { action: 'rollback', scope_key: 'acme-2027', run_id: s.body.run_id });
    expect(rb.body.status).toBe('rolled_back');
    expect(k.target.records.size).toBe(0);
    expect((await handleFrameworkRequest(d, { action: 'rollback', scope_key: 'acme-2027', run_id: s.body.run_id })).status).toBe(409);
    expect((await handleFrameworkRequest(d, { action: 'rollback', scope_key: 'acme-2027', run_id: 'nope' })).status).toBe(404);
  });
  it('pauses on a tiny budget and finishes when called again with the same files', async () => {
    const { k, d } = deps({ budgetMs: 0 });
    const first = await handleFrameworkRequest(d, body({ action: 'start' }));
    expect(first.body.status).toBe('paused');
    const second = await handleFrameworkRequest({ ...d, budgetMs: 40_000 }, body({ action: 'start', resume_run_id: first.body.run_id }));
    expect(second.body.status).toBe('completed');
    expect(k.backend.runs.size).toBe(1);
  });
});
