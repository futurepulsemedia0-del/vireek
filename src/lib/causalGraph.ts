/**
 * Causal Business Graph — client library.
 *
 * Sits on top of the World Model (src/lib/worldModel.ts). Two kinds of
 * edges end up here:
 *  - "manual": the owner draws a cause -> effect connection themselves.
 *  - "rule": a small set of transparent, timestamp-based heuristics scan
 *    the current World Model for candidate causal links (e.g. an
 *    emergency call followed by a job for the same customer within a
 *    day). Candidates are NEVER written automatically — the owner
 *    reviews and confirms (or dismisses) each one, and only confirmed
 *    edges are persisted.
 *
 * Every rule's effect size and window is fixed and documented below —
 * no hidden scoring, same philosophy as regretConsole.ts.
 *
 * Server counterpart: supabase/migrations/20261204000000_business_causal_graph.sql
 */

import { supabase } from '@/lib/supabase';
import { EdgeRelation, NodeType, WorldModel, WorldNode } from '@/lib/worldModel';

// ============================================================
// TYPES
// ============================================================

export type CausalRelationship = 'contributes_to' | 'prevents' | 'correlates_with';
export type CausalConfidence = 'low' | 'medium' | 'high';

export interface CausalEdge {
  id: string;
  user_id: string;
  cause_type: NodeType;
  cause_id: string;
  cause_label: string;
  effect_type: NodeType;
  effect_id: string;
  effect_label: string;
  relationship: CausalRelationship;
  strength: number;
  confidence: CausalConfidence;
  detected_by: 'rule' | 'manual';
  rule_key: string | null;
  evidence: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CausalCandidate {
  cause: WorldNode;
  effect: WorldNode;
  relationship: CausalRelationship;
  strength: number;
  confidence: CausalConfidence;
  ruleKey: string;
  ruleLabel: string;
  evidence: Record<string, unknown>;
}

export const RELATIONSHIP_LABELS: Record<CausalRelationship, string> = {
  contributes_to: 'contributes to',
  prevents: 'prevents',
  correlates_with: 'correlates with',
};

// ============================================================
// CRUD
// ============================================================

export async function fetchCausalEdges(): Promise<CausalEdge[]> {
  const { data, error } = await supabase
    .from('business_causal_edges')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data as CausalEdge[]) ?? [];
}

export interface SaveCausalEdgeInput {
  cause: Pick<WorldNode, 'type' | 'id' | 'label'>;
  effect: Pick<WorldNode, 'type' | 'id' | 'label'>;
  relationship: CausalRelationship;
  strength: number;
  confidence: CausalConfidence;
  notes?: string;
  detectedBy?: 'rule' | 'manual';
  ruleKey?: string;
  evidence?: Record<string, unknown>;
}

export async function saveCausalEdge(input: SaveCausalEdgeInput): Promise<CausalEdge> {
  const { data, error } = await supabase
    .from('business_causal_edges')
    .insert({
      cause_type: input.cause.type,
      cause_id: input.cause.id,
      cause_label: input.cause.label,
      effect_type: input.effect.type,
      effect_id: input.effect.id,
      effect_label: input.effect.label,
      relationship: input.relationship,
      strength: input.strength,
      confidence: input.confidence,
      detected_by: input.detectedBy ?? 'manual',
      rule_key: input.ruleKey ?? null,
      evidence: input.evidence ?? {},
      notes: input.notes?.trim() || null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as CausalEdge;
}

export async function deleteCausalEdge(id: string): Promise<void> {
  const { error } = await supabase.from('business_causal_edges').delete().eq('id', id);
  if (error) throw error;
}

export function confirmCandidate(candidate: CausalCandidate): Promise<CausalEdge> {
  return saveCausalEdge({
    cause: candidate.cause,
    effect: candidate.effect,
    relationship: candidate.relationship,
    strength: candidate.strength,
    confidence: candidate.confidence,
    detectedBy: 'rule',
    ruleKey: candidate.ruleKey,
    evidence: candidate.evidence,
  });
}

// ============================================================
// RULES — transparent, timestamp-based candidate detection
// ============================================================

function sourcesOf(model: WorldModel, targetKey: string, relation: EdgeRelation): string[] {
  return model.edges.filter((e) => e.target === targetKey && e.relation === relation).map((e) => e.source);
}

function targetsOf(model: WorldModel, sourceKey: string, relation: EdgeRelation): string[] {
  return model.edges.filter((e) => e.source === sourceKey && e.relation === relation).map((e) => e.target);
}

function hoursBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const diff = (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60);
  return Number.isFinite(diff) ? diff : null;
}

/** Rule 1: an emergency call, followed by a job for the same customer within 24h. */
function detectEmergencyCallToJob(model: WorldModel): CausalCandidate[] {
  const out: CausalCandidate[] = [];
  for (const comm of model.nodes) {
    if (comm.type !== 'communication' || comm.subtitle !== 'Emergency call') continue;
    for (const custKey of sourcesOf(model, comm.key, 'contacted_via')) {
      for (const jobKey of targetsOf(model, custKey, 'requested')) {
        const job = model.nodesByKey.get(jobKey);
        if (!job || job.type !== 'job') continue;
        const gap = hoursBetween(comm.at, job.at);
        if (gap === null || gap < 0 || gap > 24) continue;
        out.push({
          cause: comm,
          effect: job,
          relationship: 'contributes_to',
          strength: Math.max(0.4, 1 - gap / 24),
          confidence: gap <= 6 ? 'high' : 'medium',
          ruleKey: 'emergency_call_to_job',
          ruleLabel: 'Emergency call \u2192 job within 24h',
          evidence: { gap_hours: Math.round(gap * 10) / 10 },
        });
      }
    }
  }
  return out;
}

/** Rule 2: a quote sent (or accepted), followed by a job for the same customer within 14 days. */
function detectQuoteToJob(model: WorldModel): CausalCandidate[] {
  const out: CausalCandidate[] = [];
  for (const invoice of model.nodes) {
    if (invoice.type !== 'invoice' || (invoice.status !== 'sent' && invoice.status !== 'accepted')) continue;
    for (const custKey of sourcesOf(model, invoice.key, 'quoted')) {
      for (const jobKey of targetsOf(model, custKey, 'requested')) {
        const job = model.nodesByKey.get(jobKey);
        if (!job || job.type !== 'job') continue;
        const gapHours = hoursBetween(invoice.at, job.at);
        if (gapHours === null || gapHours < 0 || gapHours > 24 * 14) continue;
        const gapDays = gapHours / 24;
        out.push({
          cause: invoice,
          effect: job,
          relationship: 'contributes_to',
          strength: Math.max(0.3, 1 - gapDays / 14),
          confidence: invoice.status === 'accepted' ? 'high' : gapDays <= 3 ? 'medium' : 'low',
          ruleKey: 'quote_to_job',
          ruleLabel: 'Quote sent \u2192 job within 14 days',
          evidence: { gap_days: Math.round(gapDays * 10) / 10, quote_status: invoice.status },
        });
      }
    }
  }
  return out;
}

/** Rule 3: equipment overdue for its service interval puts the property it's installed at, at risk. */
function detectOverdueMaintenanceRisk(model: WorldModel): CausalCandidate[] {
  const out: CausalCandidate[] = [];
  for (const asset of model.nodes) {
    if (asset.type !== 'asset' || asset.flag !== 'overdue_maintenance') continue;
    for (const propKey of targetsOf(model, asset.key, 'installed_at')) {
      const property = model.nodesByKey.get(propKey);
      if (!property || property.type !== 'property') continue;
      out.push({
        cause: asset,
        effect: property,
        relationship: 'contributes_to',
        strength: 0.5,
        confidence: 'medium',
        ruleKey: 'overdue_maintenance_risk',
        ruleLabel: 'Overdue maintenance \u2192 property risk',
        evidence: {},
      });
    }
  }
  return out;
}

const RULES = [detectEmergencyCallToJob, detectQuoteToJob, detectOverdueMaintenanceRisk];

/** Run every rule and drop candidates that already have a confirmed edge (same rule + cause + effect). */
export function detectCausalCandidates(model: WorldModel, existing: CausalEdge[]): CausalCandidate[] {
  const existingKeys = new Set(existing.filter((e) => e.rule_key).map((e) => `${e.rule_key}:${e.cause_id}:${e.effect_id}`));
  const all = RULES.flatMap((rule) => rule(model));
  return all.filter((c) => !existingKeys.has(`${c.ruleKey}:${c.cause.id}:${c.effect.id}`));
}
