export type MemoryEntryType = 'winning_playbook' | 'failure_pattern' | 'tribal_knowledge' | 'best_practice';
export type MemorySource = 'manual' | 'warranty_claims' | 'commercial_contracts';
export type MemoryStatus = 'active' | 'needs_review' | 'retired';

export const ENTRY_TYPE_LABELS: Record<MemoryEntryType, string> = {
  winning_playbook: 'Winning Playbook',
  failure_pattern: 'Failure Pattern',
  tribal_knowledge: 'Tribal Knowledge',
  best_practice: 'Best Practice',
};

export const ENTRY_TYPE_COLORS: Record<MemoryEntryType, string> = {
  winning_playbook: 'bg-success-500/10 text-success-500',
  failure_pattern: 'bg-danger/10 text-danger',
  tribal_knowledge: 'bg-accent/10 text-accent',
  best_practice: 'bg-success-500/10 text-success-500',
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

export const ENTRY_TYPE_OPTIONS: MemoryEntryType[] = ['tribal_knowledge', 'winning_playbook', 'best_practice', 'failure_pattern'];
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
