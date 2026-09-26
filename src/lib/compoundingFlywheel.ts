// src/lib/compoundingFlywheel.ts
//
// Types, labels and pure helpers for the Compounding Intelligence
// Flywheel. Mirrors the pattern already used across this project's
// other *Intelligence libs.

export type FlywheelSourceType = 'org_memory_entry' | 'business_immune_detector';

export const SOURCE_TYPE_LABELS: Record<FlywheelSourceType, string> = {
  org_memory_entry: 'Organizational lesson',
  business_immune_detector: 'Confirmed recurring threat',
};

export function compoundingScoreLabel(score: number): string {
  if (score >= 75) return 'Accelerating';
  if (score >= 55) return 'Compounding';
  if (score >= 45) return 'Steady';
  return 'Slowing';
}

export function compoundingScoreColor(score: number): string {
  if (score >= 75) return 'text-success-500';
  if (score >= 55) return 'text-accent';
  if (score >= 45) return 'text-warning-500';
  return 'text-danger';
}

export function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
