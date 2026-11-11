import { describe, expect, it } from 'vitest';
import { createMemorySink, createMemoryStore } from './memory.ts';
import { rollbackRun, runImport } from './engine.ts';
import { deterministicUuid } from './hash.ts';
import { CUSTOMERS_CSV, JOBS_CSV, clone, createKit, ticking } from './testFixtures.ts';

const A = 'tenant-a';
const B = 'tenant-b';
const count = (k: ReturnType<typeof createKit>, tenant: string, entity: string) =>
  [...k.target.records.keys()].filter((x) => x.startsWith(`${tenant}|${entity}|`)).length;
async function codeOf(p: Promise<unknown>): Promise<string> { try { await p; return 'none'; } catch (e) { return (e as { code?: string }).code ?? 'other'; } }

describe('dry run', () => {
  it('has NO side effects and produces a report with control totals', async () => {
    const k = createKit();
    const out = await runImport({ ...k.common(A), mode: 'dry_run' });
    expect(out.status).toBe('dry_run');
    expect(out.runId).toBeNull();
    expect(k.backend.runs.size + k.backend.items.size + k.backend.effects.size + k.target.records.size).toBe(0);
    expect(out.report.totals.created).toBe(7);
    expect(out.report.entities.jobs.sums.invoice_amount).toBe(1650);
    expect(out.report.canCommit).toBe(true);
    expect(out.report.blockers).toEqual([]);
  });
  it('reports conflicts with existing records, bad references and unmapped enums before anything is written', async () => {
    const k = createKit();
    await createMemorySink(k.target, A).create('customers', 'pre-existing', 'x', { name: 'Old Ann', email: 'ann@example.com' });
    const csv = CUSTOMERS_CSV.replace('c3,Cy Dee,,cy@example.com,Residential', 'c3,Cy Dee,,cy@example.com,Weird');
    const out = await runImport({ ...k.common(A, k.adapter({ customers: csv, jobs: JOBS_CSV })), mode: 'dry_run' });
    const codes = Object.values(out.report.entities.customers.issueCounts);
    expect(out.report.entities.customers.issueCounts.MATCH_KEY_CONFLICT).toBe(1);
    expect(out.report.entities.customers.issueCounts.ENUM_UNMAPPED).toBe(1);
    expect(codes.length).toBeGreaterThan(0);
    expect(out.report.entities.customers.errors).toBe(2);
    expect(out.report.samples.every((s) => typeof s.position === 'number')).toBe(true);
  });
  it('returns canCommit=false with MAPPING_INVALID instead of throwing', async () => {
    const k = createKit();
    const c = k.common(A); (c.mapping.entities.customers.fields as any).email.from = 'Nope';
    const out = await runImport({ ...c, mode: 'dry_run' });
    expect(out.report.canCommit).toBe(false);
    expect(out.report.blockers).toEqual(['MAPPING_INVALID']);
  });
  it('marks the report incomplete when the deadline hits', async () => {
    const k = createKit();
    const c = k.common(A); const out = await runImport({ ...c, adapter: ticking(c.adapter, k.clock), mode: 'dry_run', deadlineMs: k.clock.t + 1 });
    expect(out.complete).toBe(false);
    expect(out.report.canCommit).toBe(false);
    expect(out.report.blockers).toContain('REPORT_INCOMPLETE');
  });
});

describe('commit', () => {
  it('creates customers then jobs, resolves references and records the ledger', async () => {
    const k = createKit();
    const out = await runImport({ ...k.common(A), mode: 'commit' });
    expect(out.status).toBe('completed');
    expect(count(k, A, 'customers')).toBe(4);
    expect(count(k, A, 'jobs')).toBe(3);
    const j1 = [...k.target.records.entries()].find(([, r]) => r.key === 'j1')!;
    expect(j1[1].values.customer_id).toBe(deterministicUuid(A, 'acme-2027', 'customers', 'c1'));
    expect(k.backend.effects.size).toBe(7);
    expect(k.backend.items.size).toBe(7);
    expect(k.backend.runs.get(out.runId!)!.status).toBe('completed');
  });
  it('is idempotent: re-running the same file changes nothing', async () => {
    const k = createKit();
    await runImport({ ...k.common(A), mode: 'commit' });
    const creates = k.target.creates;
    const again = await runImport({ ...k.common(A), mode: 'commit' });
    expect(again.report.totals.unchanged).toBe(7);
    expect(again.report.totals.created).toBe(0);
    expect(k.target.creates).toBe(creates);
    expect(k.backend.runs.size).toBe(2);
  });
  it('turns a changed source row into exactly one update (overwrite) or keeps data (fill_blanks)', async () => {
    const k = createKit();
    await runImport({ ...k.common(A), mode: 'commit' });
    const changed = CUSTOMERS_CSV.replace('Bob Ray,555-222-3333', 'Robert Ray,555-222-3333');
    const c1 = k.common(A, k.adapter({ customers: changed, jobs: JOBS_CSV }));
    const keep = await runImport({ ...c1, mode: 'commit' });
    expect(keep.report.totals.updated).toBe(0); // fill_blanks never overwrites a filled column
    const c2 = k.common(A, k.adapter({ customers: changed, jobs: JOBS_CSV })); c2.mapping.options!.dedupe = 'overwrite';
    const up = await runImport({ ...c2, mode: 'commit' });
    expect(up.report.totals.updated).toBe(1);
    expect(count(k, A, 'customers')).toBe(4);
    const bob = [...k.target.records.values()].find((r) => r.key === 'c2')!;
    expect(bob.values.name).toBe('Robert Ray');
  });
  it('skips duplicate keys in the file (first row wins) and never writes rows with errors', async () => {
    const k = createKit();
    const csv = CUSTOMERS_CSV + 'c1,Dup Ann,,dup@example.com,Residential\n,No Key,,nokey@example.com,Residential\n';
    const out = await runImport({ ...k.common(A, k.adapter({ customers: csv })), mapping: { ...clone(k.common(A).mapping), entities: { customers: k.common(A).mapping.entities.customers } }, mode: 'commit' });
    expect(out.report.entities.customers.skipped).toBe(1);
    expect(out.report.entities.customers.errors).toBe(1);
    expect(count(k, A, 'customers')).toBe(4);
    expect([...k.target.records.values()].find((r) => r.key === 'c1')!.values.name).toBe('Ann Lee');
    expect(k.backend.errors.length).toBe(1);
    expect(JSON.stringify(k.backend.errors)).toBe(JSON.stringify(k.backend.errors).replace('nokey@example.com', ''));
  });
  it('rejects a job whose customer was not imported (REF_NOT_FOUND) without failing the rest', async () => {
    const k = createKit();
    const bad = JOBS_CSV + 'j9,ghost,Nobody,10,Done,2027-03-01 09:00\n';
    const out = await runImport({ ...k.common(A, k.adapter({ customers: CUSTOMERS_CSV, jobs: bad })), mode: 'commit' });
    expect(out.status).toBe('completed_with_errors');
    expect(out.report.entities.jobs.issueCounts.REF_NOT_FOUND).toBe(1);
    expect(count(k, A, 'jobs')).toBe(3);
  });
  it('trips the circuit breaker on a mostly-broken file and leaves applied rows rollback-able', async () => {
    const k = createKit();
    let csv = 'ID,Name,Phone,Email,Type\n';
    for (let i = 0; i < 80; i++) csv += `x${i},${i < 20 ? 'Ok ' + i : ''},,,Residential\n`;
    const c = k.common(A, k.adapter({ customers: csv })); c.batchSize = 25; c.mapping.entities = { customers: c.mapping.entities.customers };
    const out = await runImport({ ...c, mode: 'commit' });
    expect(out.status).toBe('failed');
    expect(out.failure).toBe('ERROR_RATIO_EXCEEDED');
    const rb = await rollbackRun({ tenantId: A, scopeKey: 'acme-2027', runId: out.runId!, defs: c.defs, sink: c.sink, store: c.store, now: k.now });
    expect(rb.status).toBe('rolled_back');
    expect(count(k, A, 'customers')).toBe(0);
  });
});

describe('resume and crash safety', () => {
  it('pauses at the deadline and a later call resumes to completion with no duplicates', async () => {
    const k = createKit();
    const c = k.common(A);
    const first = await runImport({ ...c, adapter: ticking(c.adapter, k.clock), mode: 'commit', deadlineMs: k.clock.t + 1 });
    expect(first.status).toBe('paused');
    expect(first.complete).toBe(false);
    expect(count(k, A, 'customers')).toBe(2);
    let last = first; let guard = 0;
    while (last.status === 'paused' && guard++ < 20) {
      const c2 = k.common(A);
      last = await runImport({ ...c2, adapter: ticking(c2.adapter, k.clock), mode: 'commit', deadlineMs: k.clock.t + 1 });
    }
    expect(last.status).toBe('completed');
    expect(last.runId).toBe(first.runId);
    expect(count(k, A, 'customers')).toBe(4);
    expect(count(k, A, 'jobs')).toBe(3);
    expect(k.backend.runs.size).toBe(1);
    expect(last.report.totals.created).toBe(7);
  });
  it('refuses to resume when the source or mapping changed', async () => {
    const k = createKit();
    const c = k.common(A);
    const first = await runImport({ ...c, adapter: ticking(c.adapter, k.clock), mode: 'commit', deadlineMs: k.clock.t + 1 });
    const changed = k.common(A, k.adapter({ customers: CUSTOMERS_CSV + 'c5,New,,,Residential\n', jobs: JOBS_CSV }));
    expect(await codeOf(runImport({ ...changed, mode: 'commit', resumeRunId: first.runId! }))).toBe('SOURCE_CHANGED');
    const m = k.common(A); m.mapping.options = { ...m.mapping.options, dedupe: 'overwrite' };
    expect(await codeOf(runImport({ ...m, mode: 'commit', resumeRunId: first.runId! }))).toBe('MAPPING_CHANGED');
  });
  it('supersedes an open run when started again with a different file (ledger keeps idempotency)', async () => {
    const k = createKit();
    const c = k.common(A);
    const first = await runImport({ ...c, adapter: ticking(c.adapter, k.clock), mode: 'commit', deadlineMs: k.clock.t + 1 });
    const done = await runImport({ ...k.common(A, k.adapter({ customers: CUSTOMERS_CSV + 'c5,New,,,Residential\n', jobs: JOBS_CSV })), mode: 'commit' });
    expect(k.backend.runs.get(first.runId!)!.failure).toBe('SUPERSEDED');
    expect(done.status).toBe('completed');
    expect(count(k, A, 'customers')).toBe(5);
  });
  it('survives a crash between applying a batch and saving it: no duplicates, exact rollback', async () => {
    const k = createKit();
    let boom = true;
    const crashing = k.common(A, undefined, { beforeSaveBatch: () => { if (boom) { boom = false; throw new Error('process died'); } } });
    const first = await runImport({ ...crashing, mode: 'commit' });
    expect(first.status).toBe('paused');
    expect(first.failure).toBe('INTERNAL_ERROR');
    expect(count(k, A, 'customers')).toBe(2); // applied, ledger not saved
    const second = await runImport({ ...k.common(A), mode: 'commit', resumeRunId: first.runId! });
    expect(second.status).toBe('completed');
    expect(count(k, A, 'customers')).toBe(4);
    expect(k.target.creates).toBe(7);
    const rb = await rollbackRun({ ...k.common(A), runId: second.runId! });
    expect(rb.summary.deleted).toBe(7);
    expect(k.target.records.size).toBe(0);
  });
  it('retries transient sink failures and pauses (not errors) when the outage persists', async () => {
    const k = createKit();
    k.target.transientFailures = 2;
    const ok = await runImport({ ...k.common(A), mode: 'commit' });
    expect(ok.status).toBe('completed');
    const k2 = createKit();
    k2.target.transientFailures = 1000;
    const down = await runImport({ ...k2.common(A), mode: 'commit' });
    expect(down.status).toBe('paused');
    expect(down.failure).toBe('SINK_UNAVAILABLE');
    expect(k2.backend.errors.length).toBe(0);
    k2.target.transientFailures = 0;
    const back = await runImport({ ...k2.common(A), mode: 'commit', resumeRunId: down.runId! });
    expect(back.status).toBe('completed');
    expect(count(k2, A, 'customers')).toBe(4);
  });
  it('refuses a second worker while the lease is live and a stale lease can be taken over', async () => {
    const k = createKit();
    const c = k.common(A);
    const first = await runImport({ ...c, adapter: ticking(c.adapter, k.clock), mode: 'commit', deadlineMs: k.clock.t + 1, workerId: 'w1' });
    expect(first.status).toBe('paused');
    const store = c.store;
    expect(await store.acquireLease(first.runId!, 'w1', 120_000, k.clock.t)).toBe(true);
    expect(await codeOf(runImport({ ...k.common(A), mode: 'commit', workerId: 'w2' }))).toBe('RUN_BUSY');
    k.clock.t += 200_000;
    const taken = await runImport({ ...k.common(A), mode: 'commit', workerId: 'w2' });
    expect(taken.status).toBe('completed');
  });
});

describe('rollback', () => {
  it('deletes created rows children-first, restores updated rows and invalidates the ledger', async () => {
    const k = createKit();
    const c0 = k.common(A);
    await runImport({ ...c0, mode: 'commit' });
    const changed = CUSTOMERS_CSV.replace('Bob Ray,555-222-3333', 'Robert Ray,555-222-3333');
    const c1 = k.common(A, k.adapter({ customers: changed, jobs: JOBS_CSV })); c1.mapping.options!.dedupe = 'overwrite';
    const run2 = await runImport({ ...c1, mode: 'commit' });
    expect(run2.report.totals.updated).toBe(1);
    const r2 = await rollbackRun({ ...k.common(A), runId: run2.runId! });
    expect(r2.summary.restored).toBe(1);
    expect([...k.target.records.values()].find((r) => r.key === 'c2')!.values.name).toBe('Bob Ray');
    const run1 = [...k.backend.runs.values()].find((r) => r.status === 'completed')!;
    const r1 = await rollbackRun({ ...k.common(A), runId: run1.id });
    expect(r1.status).toBe('rolled_back');
    expect(r1.summary.deleted).toBe(7);
    expect(k.target.records.size).toBe(0);
    const again = await runImport({ ...k.common(A), mode: 'commit' });
    expect(again.report.totals.created).toBe(7); // ledger was invalidated, so nothing is wrongly "unchanged"
  });
  it('never deletes a record a human edited afterwards, and reports blocked deletions; a retry finishes', async () => {
    const k = createKit();
    const run = await runImport({ ...k.common(A), mode: 'commit' });
    const ann = [...k.target.records.values()].find((r) => r.key === 'c1')!;
    ann.values.name = 'Ann Lee-Smith';
    const cyId = deterministicUuid(A, 'acme-2027', 'customers', 'c3');
    k.target.blockedIds.add(cyId);
    const rb = await rollbackRun({ ...k.common(A), runId: run.runId! });
    expect(rb.status).toBe('rolled_back_partial');
    expect(rb.summary.keptModified).toBe(1);
    expect(rb.summary.blocked).toBe(1);
    expect(count(k, A, 'customers')).toBe(2);
    k.target.blockedIds.clear();
    const retry = await rollbackRun({ ...k.common(A), runId: run.runId! });
    expect(retry.summary.deleted).toBe(1);
    expect(retry.summary.keptModified).toBe(1);
    expect(count(k, A, 'customers')).toBe(1);
  });
  it('requires newest-first order and cannot be applied twice', async () => {
    const k = createKit();
    const r1 = await runImport({ ...k.common(A), mode: 'commit' });
    const r2 = await runImport({ ...k.common(A), mode: 'commit' });
    expect(await codeOf(rollbackRun({ ...k.common(A), runId: r1.runId! }))).toBe('NEWER_RUN_EXISTS');
    await rollbackRun({ ...k.common(A), runId: r2.runId! });
    await rollbackRun({ ...k.common(A), runId: r1.runId! });
    expect(await codeOf(rollbackRun({ ...k.common(A), runId: r1.runId! }))).toBe('NOT_ROLLBACKABLE');
  });
});

describe('tenant isolation', () => {
  it('keeps two tenants importing the same file into the same scope fully separate', async () => {
    const k = createKit();
    const a = await runImport({ ...k.common(A), mode: 'commit' });
    const b = await runImport({ ...k.common(B), mode: 'commit' });
    expect(a.status).toBe('completed'); expect(b.status).toBe('completed');
    expect(count(k, A, 'customers')).toBe(4); expect(count(k, B, 'customers')).toBe(4);
    expect(deterministicUuid(A, 's', 'customers', 'c1') === deterministicUuid(B, 's', 'customers', 'c1')).toBe(false);
    expect(await codeOf(runImport({ ...k.common(B), mode: 'commit', resumeRunId: a.runId! }))).toBe('RUN_NOT_FOUND');
    expect(await codeOf(rollbackRun({ ...k.common(B), runId: a.runId! }))).toBe('RUN_NOT_FOUND');
    expect(await createMemoryStore(k.backend, B).getRun(a.runId!)).toBeNull();
    const rb = await rollbackRun({ ...k.common(B), runId: b.runId! });
    expect(rb.summary.deleted).toBe(7);
    expect(count(k, A, 'customers')).toBe(4); // A untouched by B's rollback
  });
  it('a sink bound to tenant B cannot see or modify tenant A rows', async () => {
    const k = createKit();
    await runImport({ ...k.common(A), mode: 'commit' });
    const sinkB = createMemorySink(k.target, B);
    const id = deterministicUuid(A, 'acme-2027', 'customers', 'c1');
    expect(await sinkB.get('customers', id, ['name'])).toBeNull();
    expect(await sinkB.findByKey('customers', 'c1')).toBeNull();
    expect(await sinkB.remove('customers', id)).toBe('missing');
    expect((await sinkB.update('customers', id, { name: 'x' })).ok).toBe(false);
  });
});
