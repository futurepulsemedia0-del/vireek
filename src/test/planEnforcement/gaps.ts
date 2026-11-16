// src/test/planEnforcement/gaps.ts
//
// Turns the KNOWN_GAPS ledger into executable checks. A gap is only "open" while the evidence that it exists still
// holds; when someone closes it the matching test fails and tells them to update registry.ts and regenerate the matrix.

import {
  ABSENCE_PROBES, SENDER_REGISTRY, type AbsenceProbe, type GapId,
} from './registry';
import { PLAN_LIMITS } from '../../../supabase/functions/_shared/fraud/planLimits';
import { DEFAULT_QUIET_HOURS, decideSend } from '../../../supabase/functions/_shared/messaging/quietHoursCore';
import {
  REPO_ROOT, codeMatches, functionFileReferencesGuard, listFiles, listSourceFiles, readSource, stripComments,
} from './scan';

export interface GapState {
  id: GapId;
  open: boolean;
  evidence: string;
}

/** SQL comment stripping (-- line and block), good enough for keyword absence probes. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

export interface ProbeResult {
  probe: AbsenceProbe;
  matches: string[];
  unexpected: string[];
  staleAllow: string[];
}

export function runAbsenceProbe(probe: AbsenceProbe, root: string = REPO_ROOT): ProbeResult {
  const files = probe.dirs.flatMap((d) => (probe.sql ? listFiles(d, '.sql', root) : listSourceFiles(d, root)));
  const matches = files.filter((f) => {
    const text = readSource(f, root);
    return probe.pattern.test(probe.sql ? stripSqlComments(text) : stripComments(text));
  });
  const allowed = Object.keys(probe.allow);
  return {
    probe,
    matches,
    unexpected: matches.filter((m) => !allowed.includes(m)),
    staleAllow: allowed.filter((a) => !matches.includes(a)),
  };
}

export function unguardedSenders(root: string = REPO_ROOT): string[] {
  return SENDER_REGISTRY.filter((s) => !functionFileReferencesGuard(s.file, root)).map((s) => s.file);
}

/** Callers of the inbound allowance helpers outside their own module. */
export function inboundAllowanceCallers(root: string = REPO_ROOT): string[] {
  return listSourceFiles('supabase/functions', root).filter((f) => {
    if (f.endsWith('_shared/fraud/inbound.ts')) return false;
    return /\b(?:evaluateInbound|checkInboundAllowance|exhaustedResponse)\s*\(/.test(stripComments(readSource(f, root)));
  });
}

/** The body of `case "customer.subscription.updated"` up to the next `default:` (comment-stripped). */
export function subscriptionUpdatedBlock(root: string = REPO_ROOT): string {
  const code = stripComments(readSource('supabase/functions/stripe-webhook/index.ts', root));
  const start = code.indexOf('case "customer.subscription.updated"');
  if (start < 0) return '';
  const end = code.indexOf('default:', start);
  return code.slice(start, end < 0 ? undefined : end);
}

export const WEBHOOK_OVERWRITES_MINUTES = /minutes_included\s*:\s*minutesForPlan\(/;

/** Parses `const CLONE_PLANS = ["business", "enterprise"]` from voice-consent. */
export function parsePlanArray(rel: string, constName: string, root: string = REPO_ROOT): string[] | null {
  const m = new RegExp(`const\\s+${constName}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(stripComments(readSource(rel, root)));
  if (!m) return null;
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
}

export function evaluateGaps(root: string = REPO_ROOT): Map<GapId, GapState> {
  const out = new Map<GapId, GapState>();
  const set = (id: GapId, open: boolean, evidence: string) => out.set(id, { id, open, evidence });

  const unguarded = unguardedSenders(root);
  set('GAP-W1', unguarded.length > 0, `${unguarded.length}/${SENDER_REGISTRY.length} registered senders do not call guardOutbound()/guardDestination()`);

  const callers = inboundAllowanceCallers(root);
  set('GAP-I1', callers.length === 0, callers.length === 0 ? 'no caller of checkInboundAllowance()/exhaustedResponse() outside fraud/inbound.ts' : `called from ${callers.join(', ')}`);

  for (const probe of ABSENCE_PROBES) {
    const r = runAbsenceProbe(probe, root);
    const prev = out.get(probe.gap);
    const open = r.unexpected.length === 0 && (prev ? prev.open : true);
    const note = r.unexpected.length === 0 ? `no enforcement pattern in ${probe.dirs.join(', ')}` : `unexpected match: ${r.unexpected.join(', ')}`;
    set(probe.gap, open, prev ? `${prev.evidence}; ${note}` : note);
  }

  const wh = subscriptionUpdatedBlock(root);
  set('GAP-G1', WEBHOOK_OVERWRITES_MINUTES.test(wh), wh ? 'customer.subscription.updated assigns minutes_included from the catalog unconditionally' : 'customer.subscription.updated block not found');

  const clonePlans = parsePlanArray('supabase/functions/voice-consent/index.ts', 'CLONE_PLANS', root);
  const limitsClone = Object.entries(PLAN_LIMITS).filter(([, l]) => l.allowVoiceClone).map(([k]) => k).sort();
  const consentClone = [...(clonePlans ?? [])].sort();
  set('GAP-V1', JSON.stringify(limitsClone) !== JSON.stringify(consentClone), `planLimits.allowVoiceClone=${JSON.stringify(limitsClone)} vs voice-consent CLONE_PLANS=${JSON.stringify(consentClone)}`);

  const siem = parsePlanArray('supabase/functions/_shared/siem/engine.ts', 'SIEM_PLANS', root);
  set('GAP-P1', Boolean(siem?.includes('business')), `SIEM_PLANS=${JSON.stringify(siem)}`);

  set('GAP-E3', !codeMatches('supabase/functions/_shared/messaging/sendSms.ts', /emergency/, root), 'sendCompliantSms never mentions purpose "emergency" in code');
  set('GAP-T1', /subscription_status\s+IN\s*\(\s*'active'\s*,\s*'past_due'\s*\)/.test(stripSqlComments(readSource('supabase/migrations/20280402000000_fraud_abuse_prevention.sql', root))), "fraud_guard_context maps only 'active'/'past_due' to the paid plan");
  const overrideOff = decideSend({
    channel: 'sms', purpose: 'emergency', now: new Date('2026-11-11T08:00:00Z'), // 03:00 in New York
    settings: { ...DEFAULT_QUIET_HOURS, allowEmergencyOverride: false },
    tz: { timezone: 'America/New_York', source: 'business' },
  });
  set('GAP-E4', !overrideOff.allowed, overrideOff.allowed ? 'emergency passes even with allowEmergencyOverride=false' : 'allowEmergencyOverride=false defers an emergency SMS at 03:00 local');
  return out;
}
