/**
 * Open Voice Benchmark — client API + pure helpers (public page and staff console).
 * Scoring maths, hashing and chain verification live in
 * supabase/functions/_shared/ovb/logic.ts so the browser, the edge functions and the
 * tests can never disagree.
 */

import { supabase } from '@/lib/supabase';
import {
  CATEGORIES, DIMENSIONS, DIMENSION_LABELS, PROVENANCE_LABELS, sha256Hex, verifyEventChain,
  type Agg, type Dimension, type Provenance, type RunAggregate,
} from '../../supabase/functions/_shared/ovb/logic';

export { CATEGORIES, DIMENSIONS, DIMENSION_LABELS, PROVENANCE_LABELS, verifyEventChain };

export type Scores = Partial<RunAggregate> & {
  overall?: Agg; dimensions?: Partial<Record<Dimension, Agg>>; public_set?: Agg; held_out?: Agg;
  pass_rate?: number | null; pending_reviews?: number; errored_scenarios?: number; latency_coverage?: number; scenarios?: number; human_reviewed?: number;
};

export interface SuiteSummary {
  version: string; title: string; published_at: string | null; manifest_hash: string | null; held_out_commitment: string | null;
  held_out_count: number; rubric?: Record<string, unknown>; changelog?: string; status?: string; held_out_revealed?: boolean;
}
export interface LeaderboardEntry {
  run_id: string; agent_slug: string; agent_name: string; is_first_party: boolean; provenance: Provenance; channel: string;
  latency_basis: string; agent_version: string; scores: Scores; scenario_count: number; finished_at: string | null; published_at: string | null; engine_version: string;
}
export interface Overview {
  suite: SuiteSummary | null; leaderboard: LeaderboardEntry[]; categories: Record<string, number>; suites: SuiteSummary[]; corrections_count: number;
}
export interface CatalogScenario {
  scenario_key: string; category: string; title: string; summary: string; difficulty: number; weight: number; is_held_out: boolean;
  acoustic: Record<string, unknown>; business_context: Record<string, unknown>; turns: { text: string; interrupt?: boolean }[];
  checks: { id: string; dimension: Dimension; type: string; critical?: boolean; weight?: number; question?: string; phrases?: string[] }[];
  content_hash: string; canonical_text: string;
}
export interface Catalog {
  suite: (SuiteSummary & { business_profile: Record<string, unknown>; held_out_salt: string | null; held_out_revealed_at: string | null }) | null;
  scenarios: CatalogScenario[];
}
export interface HistoryPoint {
  run_id: string; suite_version: string; agent_version: string; provenance: Provenance; latency_basis: string; visibility: 'public' | 'retracted';
  scores: Scores; published_at: string; finished_at: string | null; engine_version: string;
}
export interface Correction { id: string; kind: string; title: string; body: string; suite_version: string | null; run_id: string | null; supersedes_id: string | null; published_at: string }
export interface RunDetail {
  run: Record<string, unknown> & { id: string; agent_name: string; provenance: Provenance; visibility: string; scores: Scores; suite_version: string; manifest_hash: string; held_out_commitment: string | null; agent_version: string };
  results: {
    scenario_key: string | null; title: string; category: string; is_held_out: boolean; scenario_hash: string; final_score: number | null;
    dimensions: Partial<Record<Dimension, number>>; critical_failure: boolean; outcome: string | null; review_flags: string[]; human_reviewed: boolean;
    check_results: { id: string; dimension: Dimension; passed: boolean; critical: boolean; method: string; detail: string }[] | null;
    transcript: { role: 'caller' | 'agent'; text: string; latency_ms?: number | null }[] | null; has_recording: boolean; transcript_sha256: string | null;
  }[];
  events: { seq: number; event_type: string; payload: Record<string, unknown>; prev_hash: string; hash: string; at: string; hash_input: string }[];
  chain: { ok: boolean; events: number; broken_at: number | null; head: string };
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchOverview = () => rpc<Overview>('ovb_public_overview');
export const fetchCatalog = (version?: string) => rpc<Catalog>('ovb_public_catalog', { p_version: version ?? null });
export const fetchHistory = (slug = 'vireek') => rpc<HistoryPoint[]>('ovb_public_history', { p_agent_slug: slug });
export const fetchRun = (id: string) => rpc<RunDetail | null>('ovb_public_run', { p_run: id });
export const fetchCorrections = () => rpc<Correction[]>('ovb_public_corrections');

export interface SubmissionInput {
  orgName: string; contactName: string; contactEmail: string; website: string; interfaceKind: 'phone' | 'api' | 'harness';
  phoneNumber: string; apiBaseUrl: string; agentName: string; agentVersion: string; wantsIndependentRun: boolean; wantsBundle: boolean;
  publicListingConsent: boolean; attestProfile: boolean; attestNoRetention: boolean; hp?: string;
}
export async function requestSubmission(i: SubmissionInput): Promise<string> {
  return rpc<string>('ovb_request_submission', {
    p_org_name: i.orgName, p_contact_name: i.contactName, p_contact_email: i.contactEmail, p_website: i.website || null,
    p_interface_kind: i.interfaceKind, p_phone_number: i.phoneNumber || null, p_api_base_url: i.apiBaseUrl || null,
    p_agent_name: i.agentName, p_agent_version: i.agentVersion, p_wants_independent_run: i.wantsIndependentRun,
    p_wants_bundle: i.wantsBundle, p_public_listing_consent: i.publicListingConsent, p_attest_profile: i.attestProfile,
    p_attest_no_retention: i.attestNoRetention, p_hp: i.hp ?? null,
  });
}
export const requestCorrection = (a: { name: string; email: string; org: string; runId: string; suiteVersion: string; message: string; hp?: string }) =>
  rpc<string>('ovb_request_correction', { p_name: a.name, p_email: a.email, p_org: a.org || null, p_run: a.runId || null, p_suite_version: a.suiteVersion || null, p_message: a.message, p_hp: a.hp ?? null });

export async function fetchRecordingUrl(runId: string, scenarioKey: string): Promise<string | null> {
  const { data, error } = await supabase.functions.invoke('ovb-public', { body: { action: 'recording', run_id: runId, scenario_key: scenarioKey } });
  return error ? null : ((data as { url?: string })?.url ?? null);
}

/** Friendly message for the validation / throttling errors raised by the SQL intake RPCs. */
export function intakeErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.includes('RATE_LIMITED')) return 'Too many requests right now. Please try again later.';
  const hit = /INVALID_INPUT:\s*(.+)$/.exec(m);
  return hit ? hit[1] : 'Something went wrong. Please check your details and try again.';
}

// ---- pure helpers -------------------------------------------------------------------------

export const fmtScore = (n: number | null | undefined) => (typeof n === 'number' ? n.toFixed(1) : '—');
export const fmtCi = (a?: Agg) => (a && a.ci_low !== null && a.ci_high !== null ? `${a.ci_low.toFixed(1)}–${a.ci_high.toFixed(1)}` : 'n/a');
export const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : '—');
export const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;

export const PROVENANCE_BADGE: Record<Provenance, { label: string; tone: 'accent' | 'success' | 'warn' }> = {
  first_party: { label: 'First-party', tone: 'warn' },
  independent: { label: 'Independently run', tone: 'success' },
  vendor_submitted: { label: 'Vendor-submitted', tone: 'accent' },
};

/** Browser-side proof that a scenario's published hash matches the exact canonical text. */
export async function verifyScenarioHash(s: Pick<CatalogScenario, 'canonical_text' | 'content_hash'>): Promise<boolean> {
  return (await sha256Hex(s.canonical_text)) === s.content_hash;
}

/** Recompute the held-out commitment once the salt has been revealed (suite retired). */
export async function verifyHeldOutCommitment(scenarios: Pick<CatalogScenario, 'scenario_key' | 'content_hash' | 'is_held_out'>[], salt: string, commitment: string): Promise<boolean> {
  const hashes = scenarios.filter((s) => s.is_held_out).sort((a, b) => (a.scenario_key < b.scenario_key ? -1 : a.scenario_key > b.scenario_key ? 1 : 0)).map((s) => s.content_hash);
  return (await sha256Hex(`${hashes.join(',')}|${salt}`)) === commitment;
}

export interface TrendPoint { x: number; label: string; overall: number; heldOut: number | null; retracted: boolean }
export function toTrend(history: HistoryPoint[]): TrendPoint[] {
  return history.map((h, i) => ({
    x: i, label: `${h.agent_version} · v${h.suite_version}`, overall: h.scores.overall?.score ?? 0,
    heldOut: h.scores.held_out?.score ?? null, retracted: h.visibility === 'retracted',
  }));
}

// ---- staff API ----------------------------------------------------------------------------------

export async function ovbRun(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('ovb-run', { body });
  if (error) throw new Error(error.message);
  return data as Record<string, unknown>;
}
export const staffRpc = rpc;

/** New submission token: shown once to the vendor, only its SHA-256 is stored. */
export async function newSubmissionToken(): Promise<{ token: string; hash: string; prefix: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const token = `ovb_sub_${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { token, hash: await sha256Hex(token), prefix: token.slice(0, 12) };
}
