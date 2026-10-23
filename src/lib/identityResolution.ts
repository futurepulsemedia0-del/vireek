/**
 * Customer identity resolution — client types, pure helpers and RPC wrappers.
 * Scoring is done in SQL (single source of truth); this file never recomputes
 * it. Backed by supabase/migrations/20271102000000_customer_identity_resolution.sql.
 */

import { supabase } from '@/lib/supabase';
import type { DuplicatePair, DuplicateRecord, MatchReason } from '@/lib/duplicates';

// ── Types ───────────────────────────────────────────────────────────────────

export type IdentityKeyType = 'phone' | 'email' | 'address';
export type CandidateBand = 'auto_merge' | 'review';
export type HouseholdStatus = 'suggested' | 'confirmed' | 'rejected';
export type SignalType = IdentityKeyType | 'name';

export interface IdentitySignal {
  type: SignalType;
  weight: number;
}

export interface IdentityKey {
  id: string;
  type: IdentityKeyType;
  value: string;
  raw: string | null;
  source: string;
  isPrimary: boolean;
  seenCount: number;
  lastSeenAt: string | null;
}

export interface HouseholdMember {
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  role: string;
  status: HouseholdStatus;
  source: 'address' | 'phone' | 'manual';
  confidence: number;
  isSelf: boolean;
}

export interface Household {
  id: string;
  name: string;
  members: HouseholdMember[];
}

export interface ProfileCandidate {
  id: string;
  otherId: string;
  otherName: string;
  score: number;
  band: CandidateBand;
  signals: IdentitySignal[];
}

export interface IdentityProfile {
  customerId: string;
  keys: IdentityKey[];
  household: Household | null;
  candidates: ProfileCandidate[];
}

export interface IdentityCandidate {
  id: string;
  score: number;
  band: CandidateBand;
  signals: IdentitySignal[];
  source: string;
  createdAt: string;
  a: DuplicateRecord;
  b: DuplicateRecord;
}

export interface IdentitySettings {
  autoEnabled: boolean;
  auto: number;
  review: number;
}

export const DEFAULT_IDENTITY_SETTINGS: IdentitySettings = { autoEnabled: true, auto: 95, review: 60 };

export type IdentityErrorCode = 'forbidden' | 'not_found' | 'invalid' | 'unknown';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export function toIdentityError(error: { message?: string; code?: string }): IdentityError {
  const m = error.message ?? '';
  if (m.includes('forbidden') || error.code === '42501') {
    return new IdentityError('forbidden', "You don't have permission to do that.");
  }
  if (m.includes('not_found') || error.code === 'P0002') {
    return new IdentityError('not_found', 'This record no longer exists or was already handled.');
  }
  if (m.includes('invalid_') || error.code === '22023') {
    return new IdentityError('invalid', 'That value is not allowed.');
  }
  return new IdentityError('unknown', m || 'Something went wrong.');
}

// ── Labels + bands ──────────────────────────────────────────────────────────

export const SIGNAL_LABELS: Record<SignalType, string> = {
  phone: 'Same phone',
  email: 'Same email',
  address: 'Same address',
  name: 'Similar name',
};

export const KEY_TYPE_LABELS: Record<IdentityKeyType, { singular: string; plural: string }> = {
  phone: { singular: 'Phone', plural: 'Phones' },
  email: { singular: 'Email', plural: 'Emails' },
  address: { singular: 'Address', plural: 'Addresses' },
};

export type ConfidenceTone = 'high' | 'medium' | 'low';

/** Mirrors the SQL bands: >=90 high, >=60 medium. */
export function confidenceTone(score: number): ConfidenceTone {
  if (score >= 90) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

export const CONFIDENCE_LABELS: Record<ConfidenceTone, string> = {
  high: 'High confidence',
  medium: 'Needs review',
  low: 'Weak match',
};

export const HOUSEHOLD_SOURCE_LABELS: Record<HouseholdMember['source'], string> = {
  address: 'Shares an address',
  phone: 'Shares a phone',
  manual: 'Confirmed by you',
};

export function describeSignals(signals: readonly IdentitySignal[]): string {
  if (signals.length === 0) return 'No matching signals';
  return signals.map((s) => SIGNAL_LABELS[s.type] ?? s.type).join(' · ');
}

// ── Defensive normalisers ───────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
const asNum = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
};
const SIGNAL_TYPES: readonly SignalType[] = ['phone', 'email', 'address', 'name'];

export function normalizeSignals(raw: unknown): IdentitySignal[] {
  if (!Array.isArray(raw)) return [];
  const out: IdentitySignal[] = [];
  for (const s of raw) {
    if (!isObj(s)) continue;
    const type = SIGNAL_TYPES.find((t) => t === s.type);
    if (type) out.push({ type, weight: asNum(s.weight) });
  }
  return out;
}

function normalizeBand(v: unknown): CandidateBand {
  return v === 'auto_merge' ? 'auto_merge' : 'review';
}

function normalizeStatus(v: unknown): HouseholdStatus {
  return v === 'confirmed' || v === 'rejected' ? v : 'suggested';
}

export function normalizeProfile(raw: unknown): IdentityProfile | null {
  if (!isObj(raw)) return null;
  const customerId = asStr(raw.customer_id);
  if (!customerId) return null;

  const keys: IdentityKey[] = (Array.isArray(raw.keys) ? raw.keys : []).flatMap((k): IdentityKey[] => {
    if (!isObj(k)) return [];
    const type = (['phone', 'email', 'address'] as const).find((t) => t === k.type);
    const id = asStr(k.id);
    const value = asStr(k.value);
    if (!type || !id || !value) return [];
    return [{
      id, type, value, raw: asStr(k.raw), source: asStr(k.source) ?? 'system',
      isPrimary: k.is_primary === true, seenCount: asNum(k.seen_count, 1), lastSeenAt: asStr(k.last_seen_at),
    }];
  });

  let household: Household | null = null;
  if (isObj(raw.household) && asStr(raw.household.id)) {
    const members = (Array.isArray(raw.household.members) ? raw.household.members : []).flatMap((m): HouseholdMember[] => {
      if (!isObj(m)) return [];
      const id = asStr(m.customer_id);
      const name = asStr(m.name);
      if (!id || !name) return [];
      const source = m.source === 'phone' || m.source === 'manual' ? m.source : 'address';
      return [{
        customerId: id, name, phone: asStr(m.phone), email: asStr(m.email), role: asStr(m.role) ?? 'member',
        status: normalizeStatus(m.status), source, confidence: asNum(m.confidence, 70), isSelf: m.is_self === true,
      }];
    });
    household = { id: String(raw.household.id), name: asStr(raw.household.name) ?? 'Household', members };
  }

  const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).flatMap((c): ProfileCandidate[] => {
    if (!isObj(c)) return [];
    const id = asStr(c.id);
    const otherId = asStr(c.other_id);
    if (!id || !otherId) return [];
    return [{
      id, otherId, otherName: asStr(c.other_name) ?? 'Unnamed', score: asNum(c.score),
      band: normalizeBand(c.band), signals: normalizeSignals(c.signals),
    }];
  });

  return { customerId, keys, household, candidates };
}

export function groupKeys(keys: readonly IdentityKey[]): Record<IdentityKeyType, IdentityKey[]> {
  const out: Record<IdentityKeyType, IdentityKey[]> = { phone: [], email: [], address: [] };
  for (const k of keys) out[k.type].push(k);
  return out;
}

/** Readable value for a key: the original text when we have it, else the normalised form. */
export function displayKey(k: Pick<IdentityKey, 'raw' | 'value'>): string {
  return k.raw?.trim() || k.value;
}

// ── Candidate -> MergeDialog bridge ─────────────────────────────────────────

/** The queue reuses the existing side-by-side MergeDialog from the Duplicates page. */
export function candidateToPair(c: IdentityCandidate): DuplicatePair {
  const reasons: MatchReason[] = c.signals
    .map((s) => s.type)
    .filter((t): t is MatchReason => t === 'phone' || t === 'email' || t === 'address');
  return {
    key: `${c.a.id}:${c.b.id}`,
    kind: 'customers',
    a: c.a,
    b: c.b,
    reasons,
    confidence: c.band === 'auto_merge' ? 'high' : 'medium',
    score: c.score,
  };
}

// ── Household graph layout (deterministic, dependency-free) ─────────────────

export interface GraphNode {
  id: string;
  label: string;
  kind: 'self' | 'member' | 'phone' | 'email' | 'address';
  x: number;
  y: number;
  status?: HouseholdStatus;
}

export interface GraphEdge {
  from: string;
  to: string;
  confidence: number;
  dashed: boolean;
}

export interface HouseholdGraph {
  width: number;
  height: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const GRAPH_SIZE = { width: 520, height: 360 } as const;
const MAX_MEMBERS = 8;
const MAX_KEYS = 6;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Self in the centre, housemates on a ring, the customer's own identifiers on an
 * outer arc. Rejected members are omitted. Same input -> same layout.
 */
export function buildHouseholdGraph(selfName: string, profile: IdentityProfile): HouseholdGraph {
  const { width, height } = GRAPH_SIZE;
  const cx = width / 2;
  const cy = height / 2;
  const nodes: GraphNode[] = [{ id: 'self', label: truncate(selfName || 'Customer', 22), kind: 'self', x: cx, y: cy }];
  const edges: GraphEdge[] = [];

  const members = (profile.household?.members ?? []).filter((m) => !m.isSelf && m.status !== 'rejected').slice(0, MAX_MEMBERS);
  members.forEach((m, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(members.length, 1);
    const id = `m:${m.customerId}`;
    nodes.push({
      id, label: truncate(m.name, 18), kind: 'member', status: m.status,
      x: Math.round(cx + 118 * Math.cos(angle)), y: Math.round(cy + 98 * Math.sin(angle)),
    });
    edges.push({ from: 'self', to: id, confidence: m.confidence, dashed: m.status !== 'confirmed' });
  });

  const keys = profile.keys.slice(0, MAX_KEYS);
  keys.forEach((k, i) => {
    const span = Math.PI * 0.9;
    const angle = Math.PI / 2 - span / 2 + (keys.length === 1 ? span / 2 : (span * i) / (keys.length - 1));
    const id = `k:${k.id}`;
    nodes.push({
      id, label: truncate(displayKey(k), 24), kind: k.type,
      x: Math.round(cx + 225 * Math.cos(angle)), y: Math.round(cy + 160 * Math.sin(angle)),
    });
    edges.push({ from: 'self', to: id, confidence: k.isPrimary ? 100 : 80, dashed: !k.isPrimary });
  });

  return { width, height, nodes, edges };
}

// ── RPC wrappers ────────────────────────────────────────────────────────────

export async function fetchIdentityProfile(customerId: string): Promise<IdentityProfile | null> {
  const { data, error } = await supabase.rpc('customer_identity_profile', { p_customer: customerId });
  if (error) throw toIdentityError(error);
  return normalizeProfile(data);
}

interface CandidateRow {
  id: string;
  score: number | string;
  band: string;
  signals: unknown;
  source: string;
  created_at: string;
  a: DuplicateRecord;
  b: DuplicateRecord;
  total_count: number | string;
}

export async function fetchIdentityCandidates(limit = 20, offset = 0): Promise<{ items: IdentityCandidate[]; total: number }> {
  const { data, error } = await supabase.rpc('identity_list_candidates', { p_limit: limit, p_offset: offset });
  if (error) throw toIdentityError(error);
  const rows = (data ?? []) as CandidateRow[];
  return {
    total: rows.length > 0 ? asNum(rows[0].total_count) : 0,
    items: rows.map((r) => ({
      id: r.id, score: asNum(r.score), band: normalizeBand(r.band), signals: normalizeSignals(r.signals),
      source: r.source, createdAt: r.created_at, a: r.a, b: r.b,
    })),
  };
}

export async function dismissIdentityCandidate(id: string): Promise<void> {
  const { error } = await supabase.rpc('identity_dismiss_candidate', { p_id: id });
  if (error) throw toIdentityError(error);
}

export async function setHouseholdMemberStatus(householdId: string, customerId: string, status: HouseholdStatus): Promise<void> {
  const { error } = await supabase.rpc('identity_household_set_status', {
    p_household: householdId, p_customer: customerId, p_status: status,
  });
  if (error) throw toIdentityError(error);
}

function normalizeSettings(raw: unknown): IdentitySettings {
  if (!isObj(raw)) return DEFAULT_IDENTITY_SETTINGS;
  return {
    autoEnabled: raw.auto_enabled !== false,
    auto: asNum(raw.auto, DEFAULT_IDENTITY_SETTINGS.auto),
    review: asNum(raw.review, DEFAULT_IDENTITY_SETTINGS.review),
  };
}

export async function fetchIdentitySettings(): Promise<IdentitySettings> {
  const { data, error } = await supabase.rpc('identity_get_settings');
  if (error) throw toIdentityError(error);
  return normalizeSettings(data);
}

export async function saveIdentitySettings(s: IdentitySettings): Promise<IdentitySettings> {
  const { data, error } = await supabase.rpc('identity_save_settings', {
    p_auto_enabled: s.autoEnabled, p_auto_threshold: s.auto, p_review_threshold: s.review,
  });
  if (error) throw toIdentityError(error);
  return normalizeSettings(data);
}
