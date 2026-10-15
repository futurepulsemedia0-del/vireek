/**
 * Call Scripts — client library.
 *
 * One script per scenario (emergency, price & quote, reschedule ...), an
 * immutable numbered version history, an optional A/B challenger version
 * with a traffic split, a typed test-call simulator, and conversion
 * comparison computed from REAL calls.
 *
 *   Tables:   supabase/migrations/20271010000000_call_scripts.sql
 *   Live:     supabase/functions/vapi-webhook (assistant-request) via
 *             supabase/functions/_shared/call-scripts/runtime.ts
 *   Simulate: supabase/functions/call-script-simulate
 *   Rules:    supabase/functions/_shared/call-scripts/logic.ts (shared)
 *
 * Tenant scoping: every table is protected by RLS with
 * get_account_owner_id() + can_edit_call_scripts(), and inserts take
 * user_id from a DB default — so team members always act on the ACCOUNT
 * OWNER's data and this file never has to pass an owner id.
 */

import { supabase } from '@/lib/supabase';
import {
  LIMITS,
  sanitizeScriptText,
  summarizeScript,
  type Arm,
  type AssignmentFacts,
  type CallRowFacts,
  type ScenarioKey,
  type ScriptSummary,
} from '../../supabase/functions/_shared/call-scripts/logic';

export * from '../../supabase/functions/_shared/call-scripts/logic';

// ============================================================
// TYPES
// ============================================================

export interface CallScript {
  id: string;
  user_id: string;
  scenario: string;
  active_version_id: string | null;
  challenger_version_id: string | null;
  challenger_traffic_pct: number;
  experiment_started_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CallScriptVersion {
  id: string;
  script_id: string;
  version_number: number;
  opening_line: string;
  body: string;
  change_note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SimulatorTurn {
  role: 'caller' | 'assistant';
  content: string;
}

export interface ScriptPerformance {
  /** Counts for the running A/B test only (since experiment_started_at). */
  experiment: ScriptSummary;
  /** Counts for every version, all time. */
  allTime: ScriptSummary;
  /** True when more than MAX_ASSIGNMENTS exposures exist and older ones were left out. */
  truncated: boolean;
}

const MAX_ASSIGNMENTS = 5000;
const CALL_CHUNK = 150;

// ============================================================
// SCRIPTS + VERSIONS
// ============================================================

export async function fetchScripts(): Promise<CallScript[]> {
  const { data, error } = await supabase.from('call_scripts').select('*').order('scenario', { ascending: true });
  if (error) throw error;
  return (data as CallScript[]) ?? [];
}

export async function fetchVersions(scriptId: string): Promise<CallScriptVersion[]> {
  const { data, error } = await supabase
    .from('call_script_versions')
    .select('*')
    .eq('script_id', scriptId)
    .order('version_number', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data as CallScriptVersion[]) ?? [];
}

/** Returns the scenario's script row, creating it on first use (race-safe). */
export async function ensureScript(scenario: ScenarioKey): Promise<CallScript> {
  const existing = await supabase.from('call_scripts').select('*').eq('scenario', scenario).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data as CallScript;

  const created = await supabase.from('call_scripts').insert({ scenario }).select('*').single();
  if (created.error) {
    // Another tab/teammate created it between our read and insert.
    if ((created.error as { code?: string }).code === '23505') {
      const again = await supabase.from('call_scripts').select('*').eq('scenario', scenario).single();
      if (again.error) throw again.error;
      return again.data as CallScript;
    }
    throw created.error;
  }
  return created.data as CallScript;
}

export async function saveVersion(input: {
  scriptId: string;
  opening_line: string;
  body: string;
  change_note: string;
}): Promise<CallScriptVersion> {
  const note = sanitizeScriptText(input.change_note, LIMITS.noteMax);
  const { data, error } = await supabase
    .from('call_script_versions')
    .insert({
      script_id: input.scriptId,
      opening_line: sanitizeScriptText(input.opening_line, LIMITS.openingMax),
      body: sanitizeScriptText(input.body, LIMITS.bodyMax),
      change_note: note || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as CallScriptVersion;
}

async function updateScript(scriptId: string, patch: Partial<CallScript>): Promise<CallScript> {
  const { data, error } = await supabase.from('call_scripts').update(patch).eq('id', scriptId).select('*').single();
  if (error) throw error;
  return data as CallScript;
}

/** Make a version live. If it was the challenger, the A/B test ends. */
export function publishVersion(script: CallScript, versionId: string): Promise<CallScript> {
  const wasChallenger = script.challenger_version_id === versionId;
  return updateScript(script.id, {
    active_version_id: versionId,
    ...(wasChallenger ? { challenger_version_id: null, challenger_traffic_pct: 0 } : {}),
  });
}

/** Take the scenario's script off the air (assistant falls back to its base prompt). */
export function unpublishScript(scriptId: string): Promise<CallScript> {
  return updateScript(scriptId, { active_version_id: null, challenger_version_id: null, challenger_traffic_pct: 0 });
}

export function startExperiment(scriptId: string, challengerVersionId: string, pct: number): Promise<CallScript> {
  return updateScript(scriptId, {
    challenger_version_id: challengerVersionId,
    challenger_traffic_pct: Math.max(1, Math.min(LIMITS.challengerPctMax, Math.round(pct))),
  });
}

export function setTrafficSplit(scriptId: string, pct: number): Promise<CallScript> {
  return updateScript(scriptId, {
    challenger_traffic_pct: Math.max(0, Math.min(LIMITS.challengerPctMax, Math.round(pct))),
  });
}

export function stopExperiment(scriptId: string): Promise<CallScript> {
  return updateScript(scriptId, { challenger_version_id: null, challenger_traffic_pct: 0 });
}

/** The challenger becomes the live version and the test ends. */
export function promoteChallenger(script: CallScript): Promise<CallScript> {
  if (!script.challenger_version_id) return Promise.reject(new Error('There is no challenger to promote.'));
  return updateScript(script.id, {
    active_version_id: script.challenger_version_id,
    challenger_version_id: null,
    challenger_traffic_pct: 0,
  });
}

// ============================================================
// PERFORMANCE (real calls)
// ============================================================

export async function fetchPerformance(script: CallScript): Promise<ScriptPerformance> {
  const { data, error } = await supabase
    .from('call_script_assignments')
    .select('call_external_id, version_id, arm, after_hours, assigned_at')
    .eq('script_id', script.id)
    .order('assigned_at', { ascending: false })
    .limit(MAX_ASSIGNMENTS);
  if (error) throw error;

  const rows = (data as (AssignmentFacts & { assigned_at: string; arm: Arm })[]) ?? [];
  const ids = Array.from(new Set(rows.map((r) => r.call_external_id)));

  const calls: CallRowFacts[] = [];
  for (let i = 0; i < ids.length; i += CALL_CHUNK) {
    const chunk = ids.slice(i, i + CALL_CHUNK);
    // Vapi's call id lives in calls.vapi_call_id (calls.external_id is only used by imported/seed rows).
    const res = await supabase
      .from('calls')
      .select('vapi_call_id, is_emergency, intent, status, is_voicemail, booking_outcome')
      .in('vapi_call_id', chunk);
    if (res.error) throw res.error;
    for (const row of (res.data as (Omit<CallRowFacts, 'external_id'> & { vapi_call_id: string | null })[]) ?? []) {
      const { vapi_call_id, ...rest } = row;
      calls.push({ ...rest, external_id: vapi_call_id });
    }
  }

  const scenario = script.scenario as ScenarioKey;
  const startedAt = script.experiment_started_at ? Date.parse(script.experiment_started_at) : null;
  const inExperiment =
    startedAt === null ? [] : rows.filter((r) => Date.parse(r.assigned_at) >= startedAt);

  return {
    experiment: summarizeScript(scenario, inExperiment, calls),
    allTime: summarizeScript(scenario, rows, calls),
    truncated: rows.length >= MAX_ASSIGNMENTS,
  };
}

// ============================================================
// SIMULATOR
// ============================================================

export class SimulatorError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SimulatorError';
    this.status = status;
  }
}

/** supabase.functions.invoke hides the JSON body of non-2xx replies in error.context. */
async function readFunctionError(error: unknown): Promise<SimulatorError> {
  const ctx = (error as { context?: unknown })?.context;
  if (ctx instanceof Response) {
    try {
      const body = (await ctx.clone().json()) as { error?: string };
      if (body?.error) return new SimulatorError(body.error, ctx.status);
    } catch {
      /* body was not JSON */
    }
    return new SimulatorError('The simulator could not answer right now. Please try again.', ctx.status);
  }
  return new SimulatorError('Could not reach the simulator. Check your connection and try again.');
}

export async function simulateTurn(input: {
  scenario: ScenarioKey;
  opening_line: string;
  body: string;
  turns: SimulatorTurn[];
}): Promise<{ reply: string; latencyMs: number }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const { data, error } = await supabase.functions.invoke('call-script-simulate', {
    body: input,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (error) throw await readFunctionError(error);
  const payload = data as { reply?: string; latency_ms?: number; error?: string } | null;
  if (!payload?.reply) throw new SimulatorError(payload?.error ?? 'The simulator returned an empty reply.');
  return { reply: payload.reply, latencyMs: payload.latency_ms ?? 0 };
}

// ============================================================
// STARTER TEMPLATES (shown only when a scenario has no versions yet)
// ============================================================

export const STARTER_TEMPLATES: Record<ScenarioKey, { opening_line: string; body: string }> = {
  emergency: {
    opening_line: 'Thanks for calling — I can hear this is urgent, so let\'s get you help right away.',
    body:
      'Stay calm and steady. First confirm there is no immediate danger: if the caller mentions gas, smoke, sparking, or flooding near electrics, tell them to leave the area and call emergency services before anything else.\nThen collect, one question at a time: the address, the best callback number, and what is happening.\nExplain that you are alerting the on-call technician now. Do not quote prices or promise an arrival time you cannot confirm.',
  },
  after_hours: {
    opening_line: 'Thanks for calling — our office is closed right now, but I can still help.',
    body:
      'Say plainly that the office is closed, then find out whether this is an emergency. If it is, follow the emergency approach.\nIf it can wait, offer to book the next available appointment or take a message for a callback first thing next business day. Mention any after-hours fee only if the business facts include one.',
  },
  new_inquiry: {
    opening_line: 'Thanks for calling — I\'d be glad to help. What\'s going on?',
    body:
      'Learn what service they need and what they are seeing, one question at a time. Confirm the address is inside the service area.\nOffer to book a visit and propose the next available time. If they hesitate, acknowledge it and explain the visit is how the technician gives an accurate answer.\nCollect name, address, and best phone number before ending the call.',
  },
  price_quote: {
    opening_line: 'Happy to help with pricing — let me ask a couple of quick questions first.',
    body:
      'Never invent a price. Only share figures that appear in the business facts or price book. Otherwise explain that exact pricing depends on the job and offer a visit or estimate.\nAsk what the job is and the age or type of equipment so the estimate is accurate, then move toward booking the estimate or visit.',
  },
  reschedule_cancel: {
    opening_line: 'No problem — I can help with that appointment.',
    body:
      'Confirm who they are and which appointment they mean. For a reschedule, offer two or three nearby times. For a cancellation, ask the reason politely and offer a reschedule before cancelling.\nRepeat the final outcome back to them so it is clear.',
  },
  existing_customer: {
    opening_line: 'Welcome back — good to hear from you. How can I help?',
    body:
      'Greet them as a returning customer and confirm what they are following up on (past visit, warranty, invoice). Use only facts you have been given about their history.\nIf you cannot answer, promise a specific callback and capture the best number and time window.',
  },
  complaint: {
    opening_line: 'I\'m sorry to hear that — please tell me what happened.',
    body:
      'Let them finish without interrupting. Acknowledge the problem in one sentence, without blaming anyone and without promising refunds or outcomes.\nCollect the job details, then tell them a manager will personally follow up and confirm the best callback number and time.',
  },
};
