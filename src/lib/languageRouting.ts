import type { TeamMember } from '@/lib/supabase';

export interface LanguageRoutingResult {
  technician: TeamMember;
  reason: string;
}

/**
 * Finds the best technician to route a live call to based on the
 * caller's detected language. Same shape and intent as
 * suggestTechnicians() in src/lib/dispatch.ts — a pure, testable
 * heuristic today, and the exact logic to port into an edge function
 * (escalate-emergency, or a future Vapi tool-call handler) so Sarah can
 * make this decision live during a call, not just after the fact.
 *
 * Only considers technicians who are dispatch-enabled and have that
 * language listed. Ties are broken by whoever has fewer jobs already
 * assigned today, if that count is supplied — otherwise by array order.
 * Returns null if no technician speaks the requested language, so
 * callers can fall back to the business's general escalation number.
 */
export function findTechnicianForLanguage(
  technicians: TeamMember[],
  callerLanguage: string,
  jobCountByTechnician: Record<string, number> = {}
): LanguageRoutingResult | null {
  const normalizedTarget = callerLanguage.trim().toLowerCase();
  if (!normalizedTarget) return null;

  const candidates = technicians.filter(
    (t) =>
      t.role === 'technician' &&
      t.dispatch_enabled &&
      !!t.member_phone &&
      t.languages.some((lang) => lang.trim().toLowerCase() === normalizedTarget)
  );

  if (candidates.length === 0) return null;

  const best = [...candidates].sort((a, b) => {
    const loadA = jobCountByTechnician[a.id] ?? 0;
    const loadB = jobCountByTechnician[b.id] ?? 0;
    return loadA - loadB;
  })[0];

  return {
    technician: best,
    reason: `Speaks ${callerLanguage}`,
  };
}
