export type MemoryEntryType = 'winning_playbook' | 'failure_pattern' | 'tribal_knowledge' | 'best_practice' | 'decision' | 'exception';
export type MemorySource = 'manual' | 'warranty_claims' | 'commercial_contracts';
export type MemoryStatus = 'active' | 'needs_review' | 'retired';

export const ENTRY_TYPE_LABELS: Record<MemoryEntryType, string> = {
  winning_playbook: 'Winning Playbook',
  failure_pattern: 'Failure Pattern',
  tribal_knowledge: 'Tribal Knowledge',
  best_practice: 'Best Practice',
  decision: 'Decision',
  exception: 'Exception',
};
export const ENTRY_TYPE_COLORS: Record<MemoryEntryType, string> = {
  winning_playbook: 'bg-success-500/10 text-success-500',
  failure_pattern: 'bg-danger/10 text-danger',
  tribal_knowledge: 'bg-accent/10 text-accent',
  best_practice: 'bg-success-500/10 text-success-500',
  decision: 'bg-accent/10 text-accent',
  exception: 'bg-warning-500/10 text-warning-500',
};

export const STATUS_LABELS: Record<MemoryStatus, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  retired: 'Retired',
};

export const STATUS_COLORS: Record<MemoryStatus, string> = {
  active: 'bg-success-500/10 text-success-500',
  needs_review: 'bg-warning-500/10 text-warning-500',
  retired: 'bg-bg-tertiary text-text-secondary',
};

export const ENTRY_TYPE_OPTIONS: MemoryEntryType[] = ['tribal_knowledge', 'winning_playbook', 'best_practice', 'failure_pattern', 'decision', 'exception'];
export const STATUS_OPTIONS: MemoryStatus[] = ['active', 'needs_review', 'retired'];

export function confidenceLabel(score: number): string {
  if (score >= 75) return 'High confidence';
  if (score >= 45) return 'Medium confidence';
  return 'Low confidence';
}

export function confidenceColor(score: number): string {
  if (score >= 75) return 'text-success-500';
  if (score >= 45) return 'text-warning-500';
  return 'text-text-secondary';
}

export function parseTags(input: string): string[] {
  return Array.from(new Set(input.split(',').map((t) => t.trim()).filter(Boolean)));
}
import { supabase } from '@/lib/supabase';

export interface OrgMemoryEntry {
  id: string;
  entry_type: MemoryEntryType;
  title: string;
  situation: string | null;
  action_taken: string | null;
  rationale: string | null;
  outcome_summary: string | null;
  confidence_score: number;
  sample_size: number | null;
  source: MemorySource;
  contributor_id: string | null;
  contributor_name: string | null;
  tags: string[];
  status: MemoryStatus;
  endorsement_count: number;
  created_at: string;
  updated_at: string;
}

export interface OrgMemorySummaryRow {
  entry_type: MemoryEntryType;
  active_count: number;
  needs_review_count: number;
  total_endorsements: number;
  distinct_contributors: number;
}

export interface NewOrgMemoryEntry {
  entry_type: MemoryEntryType;
  title: string;
  situation?: string;
  action_taken?: string;
  rationale?: string;
  outcome_summary?: string;
  contributor_id?: string | null;
  tags?: string[];
}

export async function searchOrgMemory(query?: string, entryType?: MemoryEntryType, status?: MemoryStatus, limit = 50): Promise<OrgMemoryEntry[]> {
  const { data, error } = await supabase.rpc('search_org_memory', {
    p_query: query ?? null,
    p_entry_type: entryType ?? null,
    p_status: status ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  return (data as OrgMemoryEntry[]) ?? [];
}

export async function fetchOrgMemorySummary(): Promise<OrgMemorySummaryRow[]> {
  const { data, error } = await supabase.rpc('get_org_memory_summary');
  if (error) throw error;
  return (data as OrgMemorySummaryRow[]) ?? [];
}

export async function createOrgMemoryEntry(entry: NewOrgMemoryEntry): Promise<void> {
  const { error } = await supabase.from('org_memory_entries').insert({ ...entry, source: 'manual' });
  if (error) throw error;
}

export async function updateOrgMemoryStatus(id: string, status: MemoryStatus): Promise<void> {
  const { error } = await supabase.from('org_memory_entries').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function endorseOrgMemoryEntry(id: string): Promise<number> {
  const { data, error } = await supabase.rpc('increment_memory_endorsement', { p_id: id });
  if (error) throw error;
  return data as number;
}

export async function deleteOrgMemoryEntry(id: string): Promise<void> {
  const { error } = await supabase.from('org_memory_entries').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchContributorOptions(): Promise<{ id: string; member_name: string }[]> {
  const { data, error } = await supabase.from('team_members').select('id, member_name').eq('invite_status', 'accepted').order('member_name');
  if (error) throw error;
  return data ?? [];
}
