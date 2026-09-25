/**
 * Trade Playbooks — data access for install, outcome capture and the learning loop.
 *
 * Pure statistics live in outcomeLearning.ts; playbook content in
 * tradePlaybookCatalog.ts. This file is the only place that talks to Supabase.
 *
 * Effects flow through tables the product already reads:
 *  - price_book_items      -> live AI quoting (lookup_price) + margin guardrails
 *  - knowledge_articles    -> AI receptionist knowledge search
 *  - trade_playbook_tuning -> learned targets shown in the Trade Playbooks page
 *
 * Server counterpart: supabase/migrations/20261126000000_trade_playbooks_outcome_learning.sql
 */

import { supabase } from '@/lib/supabase';
import { recordNegativeEvent } from '@/lib/negativeKnowledgeApi';
import { technicianOutcome } from '@/lib/negativeKnowledge';
import {
  TRADE_PLAYBOOKS,
  type TradeJobType,
  type TradePlaybook,
} from '@/lib/tradePlaybookCatalog';
import {
  deriveSuggestions,
  type DraftSuggestion,
  type JobOutcome,
  type PriceRef,
  type Resolution,
  type SuggestionKind,
  type SuggestionStatus,
  type TuningRow,
} from '@/lib/outcomeLearning';

export { TRADE_PLAYBOOKS };

// ============================================================
// TYPES
// ============================================================

export interface TradeInstall {
  playbook_slug: string;
  catalog_version: number;
  price_items_added: number;
  articles_added: number;
  installed_at: string;
}

export interface LearningSuggestion extends DraftSuggestion {
  id: string;
  status: SuggestionStatus;
  created_at: string;
  decided_at: string | null;
}

export interface TradeState {
  installs: TradeInstall[];
  tuning: TuningRow[];
  suggestions: LearningSuggestion[];
  primaryIndustry: string | null;
}

export interface AwaitingJob {
  id: string;
  customer_name: string;
  service_type: string | null;
  completed_at: string | null;
  duration_minutes: number | null;
  invoice_amount: number | null;
  assigned_technician_id: string | null;
  is_rework: boolean;
}

export interface InstallResult {
  priceItemsAdded: number;
  articlesAdded: number;
}

export interface RecordOutcomeInput {
  job: AwaitingJob;
  playbook: TradePlaybook;
  jobType: TradeJobType;
  rootCauseKey: string | null;
  resolution: Resolution;
  checklistDone: string[];
  partsUsed: string[];
  notes: string;
  customerRating: number | null;
}

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  fixed_first_visit: 'Fixed on the first visit',
  fixed_followup: 'Fixed after a follow-up visit',
  parts_pending: 'Waiting on parts',
  quote_declined: 'Customer declined the quote',
  unresolved: 'Unresolved',
};

const MULTIPLIER_MIN = 0.25;
const MULTIPLIER_MAX = 5;

// ============================================================
// STATE
// ============================================================

export async function fetchTradeState(ownerId: string): Promise<TradeState> {
  const [installsRes, tuningRes, suggestionsRes, profileRes] = await Promise.all([
    supabase.from('trade_playbook_installs').select('playbook_slug, catalog_version, price_items_added, articles_added, installed_at').eq('user_id', ownerId),
    supabase.from('trade_playbook_tuning').select('playbook_slug, job_type_key, target_duration_minutes, critical_item_ids').eq('user_id', ownerId),
    supabase.from('playbook_learning_suggestions').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }).limit(100),
    supabase.from('business_profile').select('primary_industry').eq('user_id', ownerId).maybeSingle(),
  ]);
  if (installsRes.error) throw installsRes.error;
  if (tuningRes.error) throw tuningRes.error;
  if (suggestionsRes.error) throw suggestionsRes.error;

  return {
    installs: (installsRes.data as TradeInstall[]) ?? [],
    tuning: (tuningRes.data as TuningRow[]) ?? [],
    suggestions: (suggestionsRes.data as LearningSuggestion[]) ?? [],
    primaryIndustry: (profileRes.data as { primary_industry: string | null } | null)?.primary_industry ?? null,
  };
}

export async function fetchOutcomes(ownerId: string, limit = 1000): Promise<JobOutcome[]> {
  const { data, error } = await supabase
    .from('job_outcomes')
    .select('*')
    .eq('user_id', ownerId)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as JobOutcome[]) ?? [];
}

/** Recently completed jobs that have no outcome recorded yet. */
export async function fetchAwaitingJobs(ownerId: string, limit = 12): Promise<AwaitingJob[]> {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const { data: jobs, error } = await supabase
    .from('jobs')
    .select('id, customer_name, service_type, completed_at, duration_minutes, invoice_amount, assigned_technician_id, is_rework')
    .eq('user_id', ownerId)
    .eq('job_status', 'completed')
    .gte('completed_at', since)
    .order('completed_at', { ascending: false })
    .limit(40);
  if (error) throw error;
  const rows = (jobs as AwaitingJob[]) ?? [];
  if (rows.length === 0) return [];

  const { data: done, error: doneError } = await supabase
    .from('job_outcomes')
    .select('job_id')
    .in('job_id', rows.map((j) => j.id));
  if (doneError) throw doneError;
  const recorded = new Set(((done as { job_id: string }[]) ?? []).map((d) => d.job_id));
  return rows.filter((j) => !recorded.has(j.id)).slice(0, limit);
}

// ============================================================
// INSTALL — idempotent, never overwrites tenant-owned rows
// ============================================================

function buildTroubleshootingArticle(jt: TradeJobType) {
  const t = jt.troubleshooting;
  if (!t) return null;
  const top = t.causes.filter((c) => c.likelihood === 'common').slice(0, 3).map((c) => c.label.toLowerCase());
  return {
    title: `Triage guide: ${jt.label}`,
    summary: `${t.symptom}. Common causes include ${top.join(', ')}. A technician diagnoses on site; do not promise a diagnosis or a fixed outcome by phone.`,
    body: [
      `Symptom: ${t.symptom}`,
      `Safety: ${t.safety}`,
      ...t.causes.map((c) => `- ${c.label} (${c.likelihood}). Test: ${c.test} Fix: ${c.fix}${c.parts.length ? ` Parts: ${c.parts.join(', ')}.` : ''}`),
    ].join('\n'),
    category: 'Trade playbook',
    keywords: [jt.label.toLowerCase(), ...jt.price.keywords],
  };
}

export async function installTradePlaybook(playbook: TradePlaybook, ownerId: string, actorId: string, priceMultiplier: number): Promise<InstallResult> {
  const mult = Math.min(MULTIPLIER_MAX, Math.max(MULTIPLIER_MIN, Number.isFinite(priceMultiplier) ? priceMultiplier : 1));
  const scale = (cents: number) => Math.round((cents * mult) / 100) * 100;

  // 1) Price Book — add only services the tenant does not already have.
  const { data: existingPrices, error: priceReadError } = await supabase.from('price_book_items').select('service_name').eq('user_id', ownerId).limit(2000);
  if (priceReadError) throw priceReadError;
  const havePrice = new Set(((existingPrices as { service_name: string }[]) ?? []).map((p) => p.service_name.trim().toLowerCase()));

  const priceRows = playbook.jobTypes
    .filter((jt) => !havePrice.has(jt.price.serviceName.toLowerCase()))
    .map((jt) => ({
      user_id: ownerId,
      service_name: jt.price.serviceName,
      category: jt.price.category,
      pricing_model: jt.price.pricingModel,
      price_cents: scale(jt.price.priceCents),
      price_max_cents: jt.price.priceMaxCents === undefined ? null : scale(jt.price.priceMaxCents),
      keywords: jt.price.keywords,
      description: jt.price.description,
      estimated_cost_cents: scale(jt.price.estimatedCostCents),
      active: true,
    }));
  if (priceRows.length > 0) {
    const { error } = await supabase.from('price_book_items').insert(priceRows);
    if (error) throw error;
  }

  // 2) Knowledge base — triage guides + dispatch urgency rules, deduped by title.
  const { data: existingArticles, error: articleReadError } = await supabase.from('knowledge_articles').select('title').eq('user_id', ownerId).eq('source', 'playbook').limit(2000);
  if (articleReadError) throw articleReadError;
  const haveTitle = new Set(((existingArticles as { title: string }[]) ?? []).map((a) => a.title.trim().toLowerCase()));

  const drafts = [
    ...playbook.jobTypes.map(buildTroubleshootingArticle).filter((a): a is NonNullable<typeof a> => a !== null),
    {
      title: `Dispatch urgency rules: ${playbook.name}`,
      summary: `Urgency rules for ${playbook.name.toLowerCase()} calls. Follow them before booking.`,
      body: playbook.dispatchNotes.map((n) => `- ${n}`).join('\n'),
      category: 'Trade playbook',
      keywords: [playbook.name.toLowerCase(), 'emergency', 'urgent', 'priority'],
    },
  ].filter((a) => !haveTitle.has(a.title.toLowerCase()));

  if (drafts.length > 0) {
    const { error } = await supabase.from('knowledge_articles').insert(
      drafts.map((a) => ({ ...a, user_id: ownerId, created_by: actorId, audience: 'ai' as const, status: 'published' as const, source: 'playbook' as const })),
    );
    if (error) throw error;
  }

  // 3) Record the install (re-install refreshes the row).
  const { data: prior } = await supabase.from('trade_playbook_installs').select('price_items_added, articles_added').eq('user_id', ownerId).eq('playbook_slug', playbook.slug).maybeSingle();
  const p = (prior as { price_items_added: number; articles_added: number } | null) ?? { price_items_added: 0, articles_added: 0 };
  const { error: installError } = await supabase.from('trade_playbook_installs').upsert(
    {
      user_id: ownerId,
      playbook_slug: playbook.slug,
      catalog_version: playbook.catalogVersion,
      price_items_added: p.price_items_added + priceRows.length,
      articles_added: p.articles_added + drafts.length,
      installed_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,playbook_slug' },
  );
  if (installError) throw installError;

  return { priceItemsAdded: priceRows.length, articlesAdded: drafts.length };
}

// ============================================================
// OUTCOME CAPTURE
// ============================================================

export async function recordJobOutcome(ownerId: string, input: RecordOutcomeInput): Promise<void> {
  const { job } = input;

  // Snapshot money from job costing when cost entries exist; otherwise fall back to the invoice.
  const { data: prof } = await supabase
    .from('job_profitability')
    .select('revenue_cents, total_cost_cents, cost_entry_count')
    .eq('job_id', job.id)
    .maybeSingle();
  const p = prof as { revenue_cents: number | null; total_cost_cents: number | null; cost_entry_count: number | null } | null;
  const invoiceCents = job.invoice_amount && job.invoice_amount > 0 ? Math.round(job.invoice_amount * 100) : null;
  const revenue = p?.revenue_cents && p.revenue_cents > 0 ? p.revenue_cents : invoiceCents;
  const cost = p && (p.cost_entry_count ?? 0) > 0 && p.total_cost_cents !== null ? p.total_cost_cents : null;

  const { error } = await supabase.from('job_outcomes').insert({
    user_id: ownerId,
    job_id: job.id,
    playbook_slug: input.playbook.slug,
    job_type_key: input.jobType.key,
    root_cause_key: input.rootCauseKey,
    resolution: input.resolution,
    checklist_done: input.checklistDone,
    checklist_total: input.jobType.checklist.length,
    parts_used: input.partsUsed,
    notes: input.notes.trim() === '' ? null : input.notes.trim(),
    revenue_cents: revenue,
    cost_cents: cost,
    duration_minutes: job.duration_minutes,
    is_rework: job.is_rework,
    technician_id: job.assigned_technician_id,
    customer_rating: input.customerRating,
  });
  if (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('An outcome is already recorded for this job.');
    throw error;
  }
  // Negative knowledge: a job that needed a follow-up is a failure signal for the technician.
  // Fire-and-forget: learning must never make outcome recording fail.
  if (job.assigned_technician_id) {
    void recordNegativeEvent(ownerId, {
      action_kind: 'technician',
      subject_key: job.assigned_technician_id,
      outcome: technicianOutcome(input.resolution),
      context: { job_type: input.jobType.key },
      recorded_at: new Date().toISOString(),
    }).catch(() => undefined);
  }
}

// ============================================================
// LEARNING LOOP
// ============================================================

/**
 * Recomputes suggestions from recorded outcomes and reconciles them with what
 * is stored: new keys are inserted, pending ones are refreshed, pending ones
 * whose condition no longer holds are removed, decided ones are never touched.
 */
export async function refreshSuggestions(ownerId: string): Promise<number> {
  const [outcomes, state, priceRes] = await Promise.all([
    fetchOutcomes(ownerId),
    fetchTradeState(ownerId),
    supabase.from('price_book_items').select('id, service_name, price_cents, price_max_cents').eq('user_id', ownerId).limit(2000),
  ]);
  if (priceRes.error) throw priceRes.error;
  const priceItems = (priceRes.data as PriceRef[]) ?? [];
  const decisions = state.suggestions.map((s) => ({ kind: s.kind as SuggestionKind, job_type_key: s.job_type_key, status: s.status, decided_at: s.decided_at }));

  const drafts: DraftSuggestion[] = TRADE_PLAYBOOKS.flatMap((playbook) =>
    outcomes.some((o) => o.playbook_slug === playbook.slug)
      ? deriveSuggestions({ playbook, outcomes, priceItems, tuning: state.tuning, decisions })
      : [],
  );

  const existing = new Map(state.suggestions.map((s) => [s.suggestion_key, s]));
  const draftKeys = new Set(drafts.map((d) => d.suggestion_key));

  const inserts = drafts.filter((d) => !existing.has(d.suggestion_key)).map((d) => ({ ...d, user_id: ownerId }));
  if (inserts.length > 0) {
    const { error } = await supabase.from('playbook_learning_suggestions').insert(inserts);
    if (error) throw error;
  }

  for (const d of drafts) {
    const prev = existing.get(d.suggestion_key);
    if (prev && prev.status === 'pending') {
      const { error } = await supabase
        .from('playbook_learning_suggestions')
        .update({ title: d.title, rationale: d.rationale, evidence: d.evidence, payload: d.payload })
        .eq('id', prev.id);
      if (error) throw error;
    }
  }

  const staleIds = state.suggestions.filter((s) => s.status === 'pending' && !draftKeys.has(s.suggestion_key)).map((s) => s.id);
  if (staleIds.length > 0) {
    const { error } = await supabase.from('playbook_learning_suggestions').delete().in('id', staleIds);
    if (error) throw error;
  }
  return inserts.length;
}

async function upsertTuning(ownerId: string, s: LearningSuggestion, patch: { target_duration_minutes?: number; addCriticalItem?: string }): Promise<void> {
  const { data: prior, error: readError } = await supabase
    .from('trade_playbook_tuning')
    .select('target_duration_minutes, critical_item_ids')
    .eq('user_id', ownerId)
    .eq('playbook_slug', s.playbook_slug)
    .eq('job_type_key', s.job_type_key)
    .maybeSingle();
  if (readError) throw readError;
  const p = (prior as { target_duration_minutes: number | null; critical_item_ids: string[] } | null) ?? { target_duration_minutes: null, critical_item_ids: [] };

  const { error } = await supabase.from('trade_playbook_tuning').upsert(
    {
      user_id: ownerId,
      playbook_slug: s.playbook_slug,
      job_type_key: s.job_type_key,
      target_duration_minutes: patch.target_duration_minutes ?? p.target_duration_minutes,
      critical_item_ids: patch.addCriticalItem ? Array.from(new Set([...p.critical_item_ids, patch.addCriticalItem])) : p.critical_item_ids,
    },
    { onConflict: 'user_id,playbook_slug,job_type_key' },
  );
  if (error) throw error;
}

export async function applySuggestion(s: LearningSuggestion, ownerId: string, actorId: string): Promise<void> {
  const payload = s.payload as Record<string, unknown>;

  switch (s.kind) {
    case 'price_adjust': {
      const { data, error } = await supabase
        .from('price_book_items')
        .update({ price_cents: payload.new_price_cents as number, price_max_cents: (payload.new_price_max_cents as number | null) ?? null })
        .eq('id', payload.price_book_item_id as string)
        .eq('user_id', ownerId)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('That Price Book entry no longer exists.');
      break;
    }
    case 'duration_adjust':
      await upsertTuning(ownerId, s, { target_duration_minutes: payload.target_duration_minutes as number });
      break;
    case 'checklist_critical':
      await upsertTuning(ownerId, s, { addCriticalItem: payload.item_id as string });
      break;
    case 'root_cause_article': {
      const { error } = await supabase.from('knowledge_articles').insert({
        user_id: ownerId,
        created_by: actorId,
        title: payload.title as string,
        summary: payload.summary as string,
        body: payload.body as string,
        category: payload.category as string,
        keywords: payload.keywords as string[],
        audience: 'ai',
        status: 'published',
        source: 'playbook',
      });
      if (error) throw error;
      break;
    }
  }

  const { error } = await supabase
    .from('playbook_learning_suggestions')
    .update({ status: 'accepted', decided_at: new Date().toISOString() })
    .eq('id', s.id);
  if (error) throw error;
}

export async function dismissSuggestion(id: string): Promise<void> {
  const { error } = await supabase
    .from('playbook_learning_suggestions')
    .update({ status: 'dismissed', decided_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
