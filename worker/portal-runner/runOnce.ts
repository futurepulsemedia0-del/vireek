// worker/portal-runner/runOnce.ts
// One automation run for ONE submission. Invoked by the worker container's queue loop (not by the web app). DISABLED by default:
// it refuses to start unless the platform switch, account switch, per-portal switch and an active consent are all in place,
// and it re-checks the kill switch before every recipe step via ctx.isHalted().
//
// Needs (worker env only):  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PORTAL_CREDENTIALS_KEY | PROVIDER_CREDENTIALS_KEY
// The service-role key and the vault key exist ONLY in this container. Credentials are decrypted in memory for this run and dropped after.
// [COUNSEL] Authorisation to use the customer's portal credentials and the portal's ToS must be confirmed per customer BEFORE enabling.
// There is deliberately NO recipe for any real third-party site in this repository.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runRecipe, type BrowserDriver, type Recipe, type RunResult } from '../../supabase/functions/_shared/portal/recipe.ts';
import { evaluateGate } from '../../supabase/functions/_shared/portal/killSwitch.ts';
import { openPortalSecrets, portalKeys } from '../../supabase/functions/_shared/portal/portalVault.ts';
import { redactText, safeError } from '../../supabase/functions/_shared/portal/redact.ts';

type Row = Record<string, unknown>;
export interface RunInput { submissionId: string; recipe: Recipe; fields: Record<string, string>; dryRun: boolean; driver: BrowserDriver; allowInsecureLocalhost?: boolean }

async function gateNow(admin: SupabaseClient, userId: string, profileId: string) {
  const [{ data: g }, { data: a }, { data: p }, { data: c }] = await Promise.all([
    admin.from('portal_global_settings').select('automation_enabled, global_kill').eq('id', true).maybeSingle(),
    admin.from('portal_account_settings').select('*').eq('user_id', userId).maybeSingle(),
    admin.from('customer_portal_profiles').select('automation_kill').eq('id', profileId).maybeSingle(),
    admin.from('portal_consents').select('id').eq('profile_id', profileId).eq('consent_type', 'automation').is('revoked_at', null).limit(1),
  ]);
  const a2 = a as Row | null;
  return { gate: evaluateGate({ globalAutomationEnabled: Boolean((g as Row | null)?.automation_enabled), globalKill: Boolean((g as Row | null)?.global_kill), accountEnabled: Boolean(a2?.submission_enabled),
    accountChannelEnabled: Boolean(a2?.automation_channel_enabled), accountAutomationKill: Boolean(a2?.automation_kill), profileAutomationKill: Boolean((p as Row | null)?.automation_kill),
    channel: 'automation', consentActive: ((c as Row[] | null) ?? []).length > 0 }), requireApproval: a2?.require_approval !== false };
}

export async function runSubmission(admin: SupabaseClient, input: RunInput): Promise<RunResult> {
  const { data: sub } = await admin.from('portal_submissions').select('*').eq('id', input.submissionId).maybeSingle();
  const s = sub as Row | null;
  if (!s || s.channel !== 'automation') return { status: 'failed', step: -1, reason: 'not_an_automation_submission', evidence: [] };
  const userId = s.user_id as string, profileId = s.profile_id as string;
  const first = await gateNow(admin, userId, profileId);
  if (!first.gate.allowed) return { status: 'halted', step: -1, reason: first.gate.reason, evidence: [] };

  const { data: cred } = await admin.from('portal_credentials').select('ciphertext').eq('profile_id', profileId).maybeSingle();
  if (!cred) return { status: 'failed', step: -1, reason: 'no_credentials', evidence: [] };
  const keys = portalKeys((k) => process.env[k]);
  let secrets: Record<string, string> = {};
  try { secrets = await openPortalSecrets((cred as Row).ciphertext as string, keys, userId, profileId); } catch { return { status: 'failed', step: -1, reason: 'credential_decrypt_failed', evidence: [] }; }
  await admin.from('portal_credential_access_log').insert({ user_id: userId, profile_id: profileId, actor_id: null, action: 'read_for_run', purpose: input.dryRun ? 'dry_run' : 'live_run' });

  const { data: run } = await admin.from('portal_worker_runs').insert({ user_id: userId, submission_id: input.submissionId, profile_id: profileId, recipe_id: input.recipe.id, recipe_version: input.recipe.version, mode: input.dryRun ? 'dry_run' : 'live' }).select('id').single();
  const runId = (run as Row).id as string;
  const secretValues = Object.values(secrets);
  let result: RunResult;
  try {
    result = await runRecipe(input.recipe, input.driver, {
      fields: input.fields, secrets, dryRun: input.dryRun, requireApproval: first.requireApproval,
      approved: Boolean(s.approved_at), // set by a PERSON through portal_apply_transition(awaiting_human -> submitting)
      isHalted: async () => !(await gateNow(admin, userId, profileId)).gate.allowed,   // kill switch checked before EVERY step
      onEvent: (e) => { void admin.from('portal_submission_events').insert({ user_id: userId, submission_id: input.submissionId, event_type: `run_${e.type}`, actor_kind: 'worker', details: { step: e.step, detail: e.detail ? redactText(e.detail, secretValues) : undefined } }); },
    }, { allowInsecureLocalhost: input.allowInsecureLocalhost });
  } catch (e) { result = { status: 'failed', step: -1, reason: safeError(e, secretValues).slice(0, 100), evidence: [] }; }
  finally { for (const k of Object.keys(secrets)) secrets[k] = ''; secrets = {}; }

  await admin.from('portal_worker_runs').update({ status: result.status, reason: result.reason ?? null, failed_step: result.status === 'failed' || result.status === 'drift' ? result.step : null, ended_at: new Date().toISOString() }).eq('id', runId);
  for (const path of result.evidence) await admin.from('portal_evidence').insert({ user_id: userId, submission_id: input.submissionId, kind: 'screenshot', storage_path: path, redacted: true });

  if (!input.dryRun) {
    const to = result.status === 'succeeded' ? 'submitted' : result.status === 'paused_human' ? 'awaiting_human' : result.status === 'halted' ? null : 'failed';
    if (to) await admin.rpc('portal_apply_transition', { p_submission_id: input.submissionId, p_to: to, p_actor_kind: 'worker',
      p_details: { reference: result.reference, pause_reason: result.status === 'paused_human' ? result.reason : undefined, code: to === 'failed' ? (result.status === 'drift' ? 'drift_detected' : result.reason) : undefined },
      p_dedupe_key: `run:${runId}` });
    if (result.status === 'drift') await admin.from('portal_submission_events').insert({ user_id: userId, submission_id: input.submissionId, event_type: 'drift_alert', actor_kind: 'worker', details: { step: result.step } });
  }
  return result;
}

export const createWorkerClient = () => createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', { auth: { persistSession: false } });
