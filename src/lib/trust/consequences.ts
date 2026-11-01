import { consequenceLines, type ConsequenceLine } from './confirmTier';

/**
 * Exact, countable consequence lines for ConfirmDialog.consequences, e.g.
 *   ["Delete 12 jobs", "and 4 invoices"]
 * `t` and `noun` come from useTrustT().
 */
export function formatConsequences(
  t: (key: string, vars?: Record<string, string | number>) => string,
  noun: (name: string, count: number) => string,
  primary: ConsequenceLine,
  dependents: ConsequenceLine[] = [],
): string[] {
  return consequenceLines(primary, dependents).map((l, i) =>
    t(i === 0 ? 'confirm.lineDelete' : 'confirm.lineAlso', { count: l.count, noun: noun(l.nounKey, l.count) }),
  );
}
