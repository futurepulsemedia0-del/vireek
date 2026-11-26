// supabase/functions/invoice-outcome-statement/index.ts
//   POST {action:"sweep", period?:"YYYY-MM"}  X-Cron-Secret = INVOICE_OUTCOME_CRON_SECRET
//        For each account where the feature is active, builds ONE draft statement per (account, period). Idempotent:
//        UNIQUE (user_id, period); a non-draft statement is never touched; a draft is rebuilt deterministically.
//   POST {action:"pdf", statementId}          Authorization: user JWT (tenant-scoped through RLS)
//        Returns {filename, base64} for a statement the caller owns (or staff).
// Never sends anything to customers. Drafts need staff approval (see docs/outcome-pricing/methodology.md).
// Secrets: INVOICE_OUTCOME_CRON_SECRET. Not live-verified.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { jsPDF } from 'npm:jspdf@2.5.2';
import {
  ATTRIBUTION_DEFAULTS, OUTCOME_RULE_VERSION, attributeAll, billableDecisions, compareToBaseline, computeFee, pickTerms,
  type AttributionRules, type FeeTerms, type HumanConfirmation, type InvoiceFacts, type LoggedAction,
} from '../_shared/results-plan/invoiceAttribution.ts';
import { buildSnapshot, isPeriod, isSnapshot, snapshotHash, snapshotIntegrity, statementIdempotencyKey } from '../_shared/results-plan/outcomeStatement.ts';
import { buildOutcomeStatementPdf, outcomeStatementFilename } from '../_shared/results-plan/outcomeStatementPdf.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey, X-Cron-Secret',
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const toBase64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

type Admin = SupabaseClient;

interface SettingsRow {
  user_id: string; enrolled_at: string | null; suspended_reason: string | null;
  confirmation_mode: AttributionRules['confirmationMode']; at_risk_days: number; attribution_window_days: number;
}
interface TermsRow {
  version: number; effective_from: string; effective_to: string | null; model: FeeTerms['model']; currency: string; base_fee_cents: number; pct_bps: number;
  per_invoice_cents: number; outcome_floor_cents: number; outcome_cap_cents: number | null; monthly_max_total_cents: number | null; pilot_free_until: string | null; no_fee_first_days: number;
}
interface Facts { skipped: number; invoices: Array<InvoiceFacts & { label: string }>; actions: LoggedAction[]; confirmations: HumanConfirmation[]; alreadyCounted: Record<string, number> }

const previousPeriod = (now: Date): string => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
};
const periodBounds = (period: string): { from: string; to: string } => {
  const [y, m] = period.split('-').map(Number);
  return { from: new Date(Date.UTC(y, m - 1, 1)).toISOString(), to: new Date(Date.UTC(y, m, 1)).toISOString() };
};

async function generate(admin: Admin, st: SettingsRow, period: string): Promise<'created' | 'rebuilt' | 'frozen' | 'inactive' | 'no_terms' | 'empty'> {
  const userId = st.user_id;
  const { data: active } = await admin.rpc('invoice_outcome_is_active', { p_user: userId });
  if (active !== true || !st.enrolled_at) return 'inactive';

  const { from, to } = periodBounds(period);
  const { data: existing } = await admin.from('invoice_outcome_statements').select('id,state').eq('user_id', userId).eq('period', period).maybeSingle();
  if (existing && existing.state !== 'draft') return 'frozen';

  const { data: termRows, error: tErr } = await admin.from('invoice_outcome_fee_terms').select('*').eq('user_id', userId).in('status', ['approved', 'retired']);
  if (tErr) throw new Error(`terms:${tErr.message}`);
  const toTerms = (r: TermsRow): FeeTerms => ({
    version: r.version, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, model: r.model, baseFeeCents: Number(r.base_fee_cents), pctBps: r.pct_bps,
    perInvoiceCents: Number(r.per_invoice_cents), outcomeFloorCents: Number(r.outcome_floor_cents),
    outcomeCapCents: r.outcome_cap_cents === null ? null : Number(r.outcome_cap_cents),
    monthlyMaxTotalCents: r.monthly_max_total_cents === null ? null : Number(r.monthly_max_total_cents), pilotFreeUntil: r.pilot_free_until, noFeeFirstDays: r.no_fee_first_days,
  });
  const versions = ((termRows ?? []) as TermsRow[]).map(toTerms);
  const lastInstant = new Date(Date.parse(to) - 1).toISOString();
  const terms = pickTerms(versions, lastInstant);
  if (!terms) return 'no_terms';
  const currency = ((termRows ?? []) as TermsRow[]).find((r) => r.version === terms.version)?.currency ?? 'USD';

  const { data: factsRaw, error: fErr } = await admin.rpc('invoice_outcome_facts', { p_user: userId, p_from: from, p_to: to });
  if (fErr) throw new Error(`facts:${fErr.message}`);
  const facts = factsRaw as Facts;
  const rules: AttributionRules = {
    atRiskDays: st.at_risk_days ?? ATTRIBUTION_DEFAULTS.atRiskDays,
    attributionWindowDays: st.attribution_window_days ?? ATTRIBUTION_DEFAULTS.attributionWindowDays,
    confirmationMode: st.confirmation_mode ?? ATTRIBUTION_DEFAULTS.confirmationMode,
  };
  const decisions = attributeAll(facts.invoices, facts.actions, facts.confirmations, rules, facts.alreadyCounted);

  // A fresh draft has no disputes; contested lines only exist after approval (the billable view handles those).
  const billable = billableDecisions(decisions, new Set<string>());
  const fee = computeFee(terms, {
    enabled: true, suspendedReason: st.suspended_reason, enrolledAt: st.enrolled_at, periodStart: from, periodEnd: to, billable,
    firstPass: null, // Task C first-pass baseline is not wired: the first_pass_per_invoice model fails closed (baseline_missing).
  });
  const baseline = compareToBaseline(null, { dsoDays: { value: null, n: 0 }, over30ArCents: { value: null, n: 0 }, firstPass: { accepted: 0, total: 0 } });
  const labels: Record<string, string> = {};
  for (const i of facts.invoices) labels[i.id] = i.label;

  const snapshot = buildSnapshot({
    userId, period, currency, generatedAt: new Date().toISOString(), ruleVersion: OUTCOME_RULE_VERSION, termsVersion: terms.version, model: terms.model,
    decisions, invoiceLabels: labels, contestedInvoiceIds: new Set<string>(), fee, baseline,
  });
  const problems = snapshotIntegrity(snapshot);
  if (problems.length > 0) throw new Error(`integrity:${problems.join(',')}`);
  if (decisions.length === 0 && fee.totalCents === 0) return 'empty';
  const hash = await snapshotHash(snapshot);

  let statementId: string;
  const row = {
    user_id: userId, period, state: 'draft', idempotency_key: statementIdempotencyKey(userId, period), currency, terms_version: terms.version,
    snapshot, content_hash: hash, base_fee_cents: snapshot.baseFeeCents, outcome_fee_cents: snapshot.outcomeFeeCents, total_cents: snapshot.totalCents,
  };
  if (existing) {
    statementId = existing.id as string;
    await admin.from('invoice_outcome_events').delete().eq('statement_id', statementId);
    await admin.from('invoice_outcome_statement_lines').delete().eq('statement_id', statementId);
    const { error } = await admin.from('invoice_outcome_statements').update({ ...row, generated_at: snapshot.generatedAt }).eq('id', statementId).eq('state', 'draft');
    if (error) throw new Error(`update:${error.message}`);
  } else {
    const { data, error } = await admin.from('invoice_outcome_statements').insert(row).select('id').single();
    if (error) {
      if (error.code === '23505') return 'frozen'; // a concurrent run won the unique race
      throw new Error(`insert:${error.message}`);
    }
    statementId = data.id as string;
  }

  if (decisions.length > 0) {
    const { error: eErr } = await admin.from('invoice_outcome_events').insert(decisions.map((d) => ({
      user_id: userId, statement_id: statementId, invoice_id: d.invoiceId, rule_version: d.ruleVersion, qualifies: d.qualifies,
      recovered_cents: d.recoveredCents, reasons: d.reasons, decision: d,
    })));
    if (eErr) throw new Error(`events:${eErr.message}`);
  }
  if (snapshot.lines.length > 0) {
    const { error: lErr } = await admin.from('invoice_outcome_statement_lines').insert(snapshot.lines.map((l) => ({
      statement_id: statementId, user_id: userId, invoice_id: l.invoiceId, recovered_cents: l.recoveredCents, fee_cents: l.feeCents, held: l.held, evidence: l.evidence,
    })));
    if (lErr) throw new Error(`lines:${lErr.message}`);
  }
  return existing ? 'rebuilt' : 'created';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !serviceKey || !anonKey) return json({ error: 'server_not_configured' }, 500);

  let body: { action?: string; period?: string; statementId?: string } = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  if (body.action === 'sweep') {
    const secret = Deno.env.get('INVOICE_OUTCOME_CRON_SECRET') ?? '';
    const given = req.headers.get('x-cron-secret') ?? '';
    if (secret === '' || !safeEqual(secret, given)) return json({ error: 'unauthorized' }, 401);
    const period = body.period ?? previousPeriod(new Date());
    if (!isPeriod(period)) return json({ error: 'invalid_period' }, 400);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const { data: accounts, error } = await admin.from('invoice_outcome_settings').select('*').eq('enabled', true).eq('kill_switch', false).not('enrolled_at', 'is', null).limit(500);
    if (error) return json({ error: 'settings_read_failed' }, 500);
    const summary: Record<string, number> = {};
    let failed = 0;
    for (const st of (accounts ?? []) as SettingsRow[]) {
      try { const r = await generate(admin, st, period); summary[r] = (summary[r] ?? 0) + 1; }
      catch (e) { failed++; console.error('outcome_statement_failed', st.user_id, e instanceof Error ? e.message : 'unknown'); }
    }
    return json({ period, summary, failed });
  }

  if (body.action === 'pdf') {
    const auth = req.headers.get('authorization') ?? '';
    if (!auth.toLowerCase().startsWith('bearer ') || typeof body.statementId !== 'string') return json({ error: 'unauthorized' }, 401);
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: 'unauthorized' }, 401);
    // RLS decides visibility: another tenant's id returns no row, indistinguishable from a missing one.
    const { data: st } = await userClient.from('invoice_outcome_statements').select('id,period,snapshot,content_hash').eq('id', body.statementId).maybeSingle();
    if (!st || !isSnapshot(st.snapshot)) return json({ error: 'not_found' }, 404);
    if ((await snapshotHash(st.snapshot)) !== st.content_hash) return json({ error: 'snapshot_hash_mismatch' }, 409);
    const baseUrl = Deno.env.get('PUBLIC_APP_URL') ?? 'https://app.vireek.com';
    const bytes = buildOutcomeStatementPdf(jsPDF as never, st.snapshot, { statementId: st.id as string, companyName: 'Your business', baseUrl });
    return json({ filename: outcomeStatementFilename(st.period as string), base64: toBase64(bytes) });
  }

  return json({ error: 'unknown_action' }, 400);
});
