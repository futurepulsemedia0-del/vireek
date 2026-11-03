// agent-readiness-cron — weekly re-scan of every opted-in account + regression alerts.
//   POST (header X-Cron-Secret = AGENT_READINESS_CRON_SECRET)
//
// Deploy: supabase functions deploy agent-readiness-cron --no-verify-jwt
// Schedule: once a day is enough (an account is only re-scanned when its last scan is >6 days old),
//           e.g. Supabase Dashboard -> Edge Functions -> Schedules, or pg_cron + pg_net.
// Fails CLOSED: with no secret configured nobody can trigger it.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { runAccountScan } from '../_shared/agent-readiness/runScan.ts';
import { diffScans, type ScanForDiff } from '../_shared/agent-readiness/monitoring.ts';
import { corsHeaders, json, productionDeps, safeEqual } from '../_shared/agent-readiness/edge.ts';

const PER_RUN = 40;
const BUDGET_MS = 100_000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const secret = Deno.env.get('AGENT_READINESS_CRON_SECRET') ?? '';
  const given = req.headers.get('X-Cron-Secret') ?? '';
  if (!secret || !given || !safeEqual(secret, given)) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } });
  const due = await admin.rpc('agent_readiness_due_accounts', { p_limit: PER_RUN });
  if (due.error) return json({ error: 'due_failed' }, 500);

  const started = Date.now();
  let scanned = 0;
  let alerts = 0;
  let failed = 0;
  for (const row of (due.data ?? []) as { user_id: string }[]) {
    if (Date.now() - started > BUDGET_MS) break;
    try {
      const { data: prevRow } = await admin.from('agent_readiness_scans').select('score, facts, site').eq('user_id', row.user_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const run = await runAccountScan(admin, row.user_id, 'weekly', productionDeps());
      if (!run.ok) { failed += 1; continue; }
      scanned += 1;
      const next: ScanForDiff = { score: run.payload.score, facts: run.payload.facts, site: run.payload.site };
      const drafts = diffScans((prevRow as ScanForDiff | null) ?? null, next);
      if (drafts.length) {
        const { error } = await admin.from('agent_readiness_alerts').upsert(
          drafts.map((d) => ({ user_id: row.user_id, scan_id: run.scanId, kind: d.kind, detail: d.detail })),
          { onConflict: 'scan_id,kind', ignoreDuplicates: true });
        if (!error) alerts += drafts.length;
      }
    } catch (e) {
      failed += 1;
      console.error(JSON.stringify({ event: 'agent_readiness_cron_account_failed', error: e instanceof Error ? e.message : String(e) }));
    }
  }
  return json({ ok: true, scanned, alerts, failed, remaining_hint: ((due.data as unknown[] | null)?.length ?? 0) - scanned - failed });
});
