// supabase/functions/compliance-evidence/index.ts
//
// SOC 2 readiness evidence pipeline — server side. READINESS tooling only: nothing produced
// here is an attestation.
//
// Auth: `Authorization: Bearer <COMPLIANCE_INGEST_TOKEN>` (constant-time compare). verify_jwt=false
// in supabase/config.toml because the caller is a scheduled CI job, not a signed-in user.
//
// POST { action: 'sync_controls', registry }   upsert control definitions + claim links
// POST { action: 'ingest', records: [...] }    store CI / manual evidence (never supabase.* collectors)
// POST { action: 'collect', modules?: [...] }  run Supabase-side collectors, store results
//
// Setup (once):
//   supabase secrets set COMPLIANCE_INGEST_TOKEN="$(openssl rand -hex 32)"
//   supabase functions deploy compliance-evidence

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import {
  COLLECTORS,
  EDGE_COLLECTOR_IDS,
  ENVELOPE_SCHEMA,
  MAX_RECORDS_PER_REQUEST,
  evidencePath,
  sha256Hex,
  stableStringify,
  timingSafeEqual,
  validateEnvelope,
  validateRegistryPayload,
  scrub,
  type Envelope,
  type EvidenceOutcome,
  type Json,
} from '../_shared/compliance/evidenceCore.ts';

const BUCKET = 'compliance-evidence';
const MAX_BODY_BYTES = 14_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

type Admin = SupabaseClient;
type RecordResult = { collector: string; status: 'inserted' | 'duplicate' | 'rejected'; reason?: string };

// ------------------------------------------------------------------ envelope helpers

function envelope(collector: string, result: Envelope['result'], outcome: EvidenceOutcome, summary: Record<string, Json>, data: Record<string, Json>, runRef: string | null, now: Date): Envelope {
  return {
    schema: ENVELOPE_SCHEMA,
    collector,
    collected_at: now.toISOString(),
    result,
    outcome: result === 'collected' ? outcome : 'fail',
    run_ref: runRef,
    summary: scrub(summary),
    data: scrub(data),
  };
}

const hoursSince = (iso: string | null | undefined, now: Date): number | null => (iso ? Math.round(((now.getTime() - Date.parse(iso)) / 3_600_000) * 10) / 10 : null);

// ------------------------------------------------------------------ edge collectors

type Collector = (admin: Admin, now: Date, runRef: string | null) => Promise<Envelope>;

async function rpc<T>(admin: Admin, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

const EDGE: Record<string, Collector> = {
  'supabase.rls_coverage': async (admin, now, ref) => {
    const d = await rpc<Record<string, Json>>(admin, 'compliance_rls_coverage');
    const without = (d.tables_without_rls as string[]) ?? [];
    return envelope(
      'supabase.rls_coverage',
      'collected',
      without.length === 0 ? 'pass' : 'fail',
      {
        tablesTotal: d.tables_total,
        tablesWithRls: d.tables_with_rls,
        tablesWithoutRls: without.length,
        rlsEnabledWithoutPolicies: ((d.rls_enabled_without_policies as Json[]) ?? []).length,
        permissiveSelectUsingTrue: ((d.permissive_select_using_true as Json[]) ?? []).length,
        anonExecutableSecurityDefiner: ((d.anon_executable_security_definer_functions as Json[]) ?? []).length,
      },
      d,
      ref,
      now,
    );
  },

  'supabase.access_review': async (admin, now, ref) => {
    const d = await rpc<{ staff_profiles: { id: string; email: string; role: string; status: string; created_at: string }[] } & Record<string, Json>>(admin, 'compliance_access_summary');
    const staff = (d.staff_profiles ?? []).slice(0, 100);
    const rows: Json[] = [];
    let withoutMfa = 0;
    for (const p of staff) {
      const { data, error } = await admin.auth.admin.getUserById(p.id);
      const factors = data?.user?.factors ?? [];
      const verified = factors.filter((f) => f.status === 'verified').length;
      if (error || !data?.user || verified === 0) withoutMfa++;
      rows.push({
        id: p.id,
        email: p.email,
        role: p.role,
        status: p.status,
        lastSignInAt: data?.user?.last_sign_in_at ?? null,
        mfaVerifiedFactors: verified,
        authLookupFailed: Boolean(error || !data?.user),
      });
    }
    const scim = (d.scim ?? {}) as Record<string, Json>;
    return envelope(
      'supabase.access_review',
      'collected',
      staff.length === 0 ? 'info' : withoutMfa === 0 ? 'pass' : 'fail',
      { staffCount: staff.length, staffWithoutVerifiedMfa: withoutMfa, scimActive: scim.active ?? null, scimActiveUnused90d: scim.active_unused_90d ?? null, customRoles: d.custom_roles ?? null },
      { staff: rows, profilesByRole: d.profiles_by_role ?? [], teamMembersByRole: d.team_members_by_role ?? [], ssoDomainsByStatus: d.sso_domains_by_status ?? [], scim },
      ref,
      now,
    );
  },

  'supabase.backups': async (admin, now, ref) => {
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const { data, error } = await admin.from('platform_backup_runs').select('id,started_at,completed_at,status,size_bytes,checksum_sha256,error_message').gte('started_at', since).order('started_at', { ascending: false }).limit(500);
    if (error) throw new Error(`platform_backup_runs: ${error.message}`);
    const runs = data ?? [];
    const completed = runs.filter((r) => r.status === 'completed');
    const last = completed[0]?.completed_at ?? null;
    const age = hoursSince(last, now);
    return envelope(
      'supabase.backups',
      'collected',
      age !== null && age <= 36 ? 'pass' : 'fail',
      { runsIn90d: runs.length, completed: completed.length, failed: runs.filter((r) => r.status === 'failed').length, lastCompletedAt: last, hoursSinceLastCompleted: age, completedWithChecksum: completed.filter((r) => r.checksum_sha256).length, thresholdHours: 36 },
      { runs: runs.map((r) => ({ id: r.id, startedAt: r.started_at, completedAt: r.completed_at, status: r.status, sizeBytes: r.size_bytes, hasChecksum: Boolean(r.checksum_sha256), error: r.error_message ? String(r.error_message).slice(0, 200) : null })) },
      ref,
      now,
    );
  },

  'supabase.restore_drills': async (admin, now, ref) => {
    const since = new Date(now.getTime() - 180 * 86_400_000).toISOString();
    const { data, error } = await admin.from('platform_restore_drills').select('id,backup_run_id,started_at,completed_at,status,rto_seconds,row_count_mismatches').gte('started_at', since).order('started_at', { ascending: false }).limit(200);
    if (error) throw new Error(`platform_restore_drills: ${error.message}`);
    const drills = data ?? [];
    const passed = drills.filter((r) => r.status === 'passed');
    const lastPassed = passed[0]?.completed_at ?? null;
    const age = hoursSince(lastPassed, now);
    return envelope(
      'supabase.restore_drills',
      'collected',
      age !== null && age <= 8 * 24 ? 'pass' : 'fail',
      { drillsIn180d: drills.length, passed: passed.length, failed: drills.filter((r) => r.status === 'failed').length, lastPassedAt: lastPassed, daysSinceLastPassed: age === null ? null : Math.round((age / 24) * 10) / 10, lastRtoSeconds: passed[0]?.rto_seconds ?? null, thresholdDays: 8, rtoRpoTargetsDefined: false },
      { drills: drills.map((r) => ({ id: r.id, backupRunId: r.backup_run_id, startedAt: r.started_at, completedAt: r.completed_at, status: r.status, rtoSeconds: r.rto_seconds, mismatchTables: Object.keys((r.row_count_mismatches as Record<string, unknown>) ?? {}).length })) },
      ref,
      now,
    );
  },

  'supabase.audit_summary': async (admin, now, ref) => {
    const d = await rpc<Record<string, Json>>(admin, 'compliance_audit_summary', { p_days: 30 });
    const n = Number(d.entries_in_window ?? 0);
    return envelope('supabase.audit_summary', 'collected', n > 0 ? 'pass' : 'fail', { windowDays: d.window_days, entriesInWindow: n, accountsWithEntries: d.accounts_with_entries }, { byAction: d.by_action ?? [] }, ref, now);
  },

  'supabase.slo': async (admin, now, ref) => {
    const d = await rpc<{ slos?: Json[]; targets?: { active?: boolean }[]; recent_runs?: { status: string; started_at: string }[]; latency?: Json[] }>(admin, 'staff_reliability_overview', { p_days: 30 });
    const runs = d.recent_runs ?? [];
    const age = hoursSince(runs[0]?.started_at, now);
    const passedRuns = runs.filter((r) => r.status === 'passed').length;
    return envelope(
      'supabase.slo',
      'collected',
      age !== null && age <= 24 ? 'pass' : 'fail',
      { sloDefinitions: (d.slos ?? []).length, probeTargets: (d.targets ?? []).length, activeTargets: (d.targets ?? []).filter((t) => t.active).length, recentRuns: runs.length, recentRunsPassed: passedRuns, lastProbeAt: runs[0]?.started_at ?? null, hoursSinceLastProbe: age, thresholdHours: 24 },
      { slos: d.slos ?? [], latency: d.latency ?? [], recentRuns: runs as unknown as Json[] },
      ref,
      now,
    );
  },

  'supabase.incidents': async (admin, now, ref) => {
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const [st, sla] = await Promise.all([
      admin.from('status_incidents').select('id,title,impact,status,component_id,source,started_at,resolved_at').gte('started_at', since).order('started_at', { ascending: false }).limit(500),
      admin.from('sla_incidents').select('id,kind,scope,started_at,ended_at,confirmed').gte('started_at', since).order('started_at', { ascending: false }).limit(500),
    ]);
    if (st.error) throw new Error(`status_incidents: ${st.error.message}`);
    if (sla.error) throw new Error(`sla_incidents: ${sla.error.message}`);
    const inc = st.data ?? [];
    const resolved = inc.filter((i) => i.resolved_at);
    const mins = resolved.map((i) => (Date.parse(i.resolved_at as string) - Date.parse(i.started_at)) / 60_000);
    const mttr = mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
    return envelope(
      'supabase.incidents',
      'collected',
      'info',
      { windowDays: 90, statusIncidents: inc.length, resolved: resolved.length, openNow: inc.length - resolved.length, meanMinutesToResolve: mttr, slaIncidents: (sla.data ?? []).length },
      { statusIncidents: inc as unknown as Json[], slaIncidents: (sla.data ?? []) as unknown as Json[] },
      ref,
      now,
    );
  },

  'supabase.retention': async (admin, now, ref) => {
    const d = await rpc<{ policies?: Record<string, Json>; deletion_requests_overdue?: number } & Record<string, Json>>(admin, 'compliance_retention_summary');
    const overdue = Number(d.deletion_requests_overdue ?? 0);
    return envelope('supabase.retention', 'collected', overdue === 0 ? 'pass' : 'fail', { policies: d.policies ?? {}, deletionRequestsOverdue: overdue }, { deletionRequestsByStatus: d.deletion_requests_by_status ?? [] }, ref, now);
  },
};

// ------------------------------------------------------------------ persistence

async function store(admin: Admin, env: Envelope): Promise<RecordResult> {
  const canonical = stableStringify(env);
  const sha = await sha256Hex(canonical);
  const { data: controls, error: cErr } = await admin.from('compliance_controls').select('id').contains('collectors', [env.collector]);
  if (cErr) return { collector: env.collector, status: 'rejected', reason: `lookup failed: ${cErr.message}` };
  if (!controls || controls.length === 0) return { collector: env.collector, status: 'rejected', reason: 'no control uses this collector — run sync first' };

  const path = evidencePath(env.collector, env.collected_at, sha);
  const up = await admin.storage.from(BUCKET).upload(path, new Blob([canonical], { type: 'application/json' }), { contentType: 'application/json', upsert: false });
  if (up.error && !/already exists|duplicate/i.test(up.error.message)) return { collector: env.collector, status: 'rejected', reason: `storage: ${up.error.message}` };

  const source = COLLECTORS[env.collector] === 'edge' ? 'edge' : COLLECTORS[env.collector] === 'manual' ? 'manual' : 'ci';
  const rows = controls.map((c) => ({
    control_id: c.id as string,
    collector: env.collector,
    collected_at: env.collected_at,
    result: env.result,
    outcome: env.outcome,
    summary: env.summary,
    sha256: sha,
    storage_path: path,
    run_ref: env.run_ref,
    source,
  }));
  const ins = await admin.from('compliance_evidence').upsert(rows, { onConflict: 'control_id,collector,sha256', ignoreDuplicates: true }).select('id');
  if (ins.error) return { collector: env.collector, status: 'rejected', reason: `insert: ${ins.error.message}` };
  return { collector: env.collector, status: (ins.data ?? []).length > 0 ? 'inserted' : 'duplicate' };
}

async function syncControls(admin: Admin, input: unknown): Promise<Response> {
  const v = validateRegistryPayload(input);
  if (!v.ok) return json({ error: 'invalid registry', details: 'errors' in v ? v.errors.slice(0, 20) : [v.reason] }, 400);
  const reg = v.value;
  const rows = reg.controls.map((c) => ({
    id: c.id,
    criteria: c.criteria,
    category: c.category,
    title: c.title,
    status: c.status,
    owner_role: c.ownerRole,
    owner: c.owner,
    frequency_days: c.frequencyDays,
    collectors: c.collectors,
    implementation: c.implementation,
    gap: c.gap,
    registry_version: reg.registryVersion,
    synced_at: new Date().toISOString(),
  }));
  const up = await admin.from('compliance_controls').upsert(rows, { onConflict: 'id' });
  if (up.error) return json({ error: `controls: ${up.error.message}` }, 500);

  const existing = await admin.from('compliance_claim_controls').select('claim_key,control_id');
  if (existing.error) return json({ error: `claim links: ${existing.error.message}` }, 500);
  const wanted = new Set(reg.claims.flatMap((c) => c.controlIds.map((id) => `${c.key}|${id}`)));
  for (const l of existing.data ?? []) {
    if (!wanted.has(`${l.claim_key}|${l.control_id}`)) {
      const del = await admin.from('compliance_claim_controls').delete().eq('claim_key', l.claim_key).eq('control_id', l.control_id);
      if (del.error) return json({ error: `claim link delete: ${del.error.message}` }, 500);
    }
  }
  const links = reg.claims.flatMap((c) => c.controlIds.map((id) => ({ claim_key: c.key, control_id: id })));
  if (links.length) {
    const li = await admin.from('compliance_claim_controls').upsert(links, { onConflict: 'claim_key,control_id', ignoreDuplicates: true });
    if (li.error) return json({ error: `claim links: ${li.error.message}` }, 500);
  }
  const all = await admin.from('compliance_controls').select('id');
  const known = new Set(reg.controls.map((c) => c.id));
  const orphaned = (all.data ?? []).map((r) => r.id as string).filter((id) => !known.has(id));
  return json({ ok: true, controls: rows.length, claimLinks: links.length, orphaned });
}

// ------------------------------------------------------------------ handler

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const expected = Deno.env.get('COMPLIANCE_INGEST_TOKEN') ?? '';
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (expected.length < 32 || !url || !key) return json({ error: 'not_configured' }, 503);

  const presented = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!(await timingSafeEqual(presented, expected))) return json({ error: 'unauthorized' }, 401);

  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date();

  try {
    switch (body.action) {
      case 'sync_controls':
        return await syncControls(admin, body.registry);

      case 'ingest': {
        const records = Array.isArray(body.records) ? body.records : null;
        if (!records || records.length === 0 || records.length > MAX_RECORDS_PER_REQUEST) return json({ error: `records must contain 1..${MAX_RECORDS_PER_REQUEST} items` }, 400);
        const results: RecordResult[] = [];
        for (const r of records) {
          const v = validateEnvelope(r, now, false);
          if (!v.ok) {
            const c = typeof (r as { collector?: unknown })?.collector === 'string' ? String((r as { collector: string }).collector) : 'unknown';
            results.push({ collector: c, status: 'rejected', reason: v.reason });
            continue;
          }
          results.push(await store(admin, v.value));
        }
        return json({ ok: true, results });
      }

      case 'collect': {
        const requested = Array.isArray(body.modules) ? body.modules.map(String) : [...EDGE_COLLECTOR_IDS];
        const runRef = typeof body.run_ref === 'string' ? body.run_ref.slice(0, 300) : null;
        const results: RecordResult[] = [];
        for (const id of requested) {
          const fn = EDGE[id];
          if (!fn) {
            results.push({ collector: id, status: 'rejected', reason: 'not a Supabase-side collector' });
            continue;
          }
          let env: Envelope;
          try {
            env = await fn(admin, now, runRef);
          } catch (e) {
            env = envelope(id, 'error', 'fail', { reason: (e instanceof Error ? e.message : String(e)).slice(0, 500) }, {}, runRef, now);
          }
          const v = validateEnvelope(env, now, true);
          results.push(v.ok ? await store(admin, v.value) : { collector: id, status: 'rejected', reason: v.reason });
        }
        return json({ ok: true, results });
      }

      default:
        return json({ error: 'unknown_action' }, 400);
    }
  } catch (e) {
    console.error('[compliance-evidence]', e instanceof Error ? e.message : e);
    return json({ error: 'internal_error' }, 500);
  }
});
