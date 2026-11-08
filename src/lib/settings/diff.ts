import type { RiskLevel } from './registry';

export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

const SENSITIVE = /(secret|token|password|api[_-]?key|private)/i;
export const REDACTED = '••••••';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Flat before -> after list. Sensitive keys are redacted so a diff is safe to log or show. */
export function computeDiff(before: Record<string, unknown>, after: Record<string, unknown>, prefix = ''): DiffEntry[] {
  const out: DiffEntry[] = [];
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  for (const k of keys) {
    const path = prefix ? `${prefix}.${k}` : k;
    const b = before[k];
    const a = after[k];
    if (isObj(b) && isObj(a)) {
      out.push(...computeDiff(b, a, path));
    } else if (!same(b, a)) {
      const hide = SENSITIVE.test(k);
      out.push({ path, before: hide && b !== undefined ? REDACTED : b, after: hide && a !== undefined ? REDACTED : a });
    }
  }
  return out;
}

export interface ChangeGate {
  requiresDiffReview: boolean;
  requiresStepUp: boolean;
  requiresTwoPerson: boolean;
}

/** Risk-aware gating. Two-person approval is off unless the feature flag is on. */
export function gateForRisk(risk: RiskLevel, flags: { twoPersonApproval?: boolean } = {}): ChangeGate {
  return {
    requiresDiffReview: risk !== 'low',
    requiresStepUp: risk === 'high',
    requiresTwoPerson: risk === 'high' && flags.twoPersonApproval === true,
  };
}
