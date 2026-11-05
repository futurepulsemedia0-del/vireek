// supabase/functions/_shared/chief-of-staff/conflicts.ts
//
// Deterministic conflict detection + priority arbitration across everything the agents want to do.
// No language model: rules are explicit and testable. Arbitration only HIDES the lower-priority item
// from the ranked list (status "suppressed" with a reason). It never rejects, edits or executes an
// agent action — approvals stay in agent_action_log under the owner's control.

import type { CosCandidate } from "./types.ts";

export interface ConflictContext {
  /** True when get_capacity_status reports "full" for any of the next days checked. */
  capacityFull: boolean;
  capacityFullDates: string[];
  /** True when a confirmed gross-margin goal is currently below target (computed from real data). */
  marginBelowTarget: boolean;
}

export interface ConflictRecord {
  rule_key: "demand_vs_capacity" | "margin_vs_discount" | "same_subject_contact";
  fingerprint: string;
  severity: "info" | "warning" | "critical";
  summary: string;
  dedupe_keys: string[];
  winner_dedupe_key: string | null;
  detail: Record<string, unknown>;
}

export interface Suppression {
  reason: string;
  rule_key: ConflictRecord["rule_key"];
  by: string | null;
}

export interface ConflictResult {
  suppressed: Map<string, Suppression>;
  conflicts: ConflictRecord[];
}

/**
 * Lower number wins. compliance > cash protection > capacity protection > customer care > growth.
 * (Protect the business before growing it: never spend to attract demand you cannot serve.)
 */
export function arbitrationClass(c: Pick<CosCandidate, "domain" | "kind">): number {
  if (c.domain === "compliance") return 0;
  if (c.domain === "finance" && (c.kind === "leak" || c.kind === "risk")) return 1;
  if (c.domain === "capacity") return 2;
  if (c.domain === "customer") return 3;
  return 4;
}

export function compareForArbitration(a: CosCandidate, b: CosCandidate): number {
  const ca = arbitrationClass(a);
  const cb = arbitrationClass(b);
  if (ca !== cb) return ca - cb;
  if (a.priority_score !== b.priority_score) return b.priority_score - a.priority_score;
  return a.dedupe_key < b.dedupe_key ? -1 : a.dedupe_key > b.dedupe_key ? 1 : 0;
}

export function detectConflicts(cands: readonly CosCandidate[], ctx: ConflictContext): ConflictResult {
  const suppressed = new Map<string, Suppression>();
  const conflicts: ConflictRecord[] = [];
  const mark = (key: string, s: Suppression) => { if (!suppressed.has(key)) suppressed.set(key, s); };

  // Rule 1 — never attract demand while capacity is full.
  if (ctx.capacityFull) {
    const demand = cands.filter((c) => c.effects.includes("increases_demand"));
    if (demand.length > 0) {
      const protector = [...cands].filter((c) => c.source_engine === "capacity-demand-control")
        .sort(compareForArbitration)[0] ?? null;
      const keys = demand.map((d) => d.dedupe_key).sort();
      for (const d of demand) {
        mark(d.dedupe_key, { rule_key: "demand_vs_capacity", by: protector?.dedupe_key ?? null,
          reason: `Capacity is full on ${ctx.capacityFullDates.join(", ")}. Adding demand now would create waiting or turned-away customers.` });
      }
      conflicts.push({
        rule_key: "demand_vs_capacity",
        fingerprint: `demand_vs_capacity:${keys.join("+")}`,
        severity: "warning",
        summary: `${demand.length} demand-increasing action(s) conflict with full capacity on ${ctx.capacityFullDates.join(", ")}.`,
        dedupe_keys: protector ? [protector.dedupe_key, ...keys] : keys,
        winner_dedupe_key: protector?.dedupe_key ?? null,
        detail: { capacity_full_dates: ctx.capacityFullDates },
      });
    }
  }

  // Rule 2 — don't cut margin while a margin goal is already missed.
  if (ctx.marginBelowTarget) {
    const cutters = cands.filter((c) => c.effects.includes("reduces_margin"));
    if (cutters.length > 0) {
      const keys = cutters.map((c) => c.dedupe_key).sort();
      for (const c of cutters) {
        mark(c.dedupe_key, { rule_key: "margin_vs_discount", by: null,
          reason: "Gross margin is currently below its goal; this action would lower it further." });
      }
      conflicts.push({
        rule_key: "margin_vs_discount",
        fingerprint: `margin_vs_discount:${keys.join("+")}`,
        severity: "warning",
        summary: `${cutters.length} margin-reducing action(s) conflict with a gross-margin goal that is below target.`,
        dedupe_keys: keys,
        winner_dedupe_key: null,
        detail: {},
      });
    }
  }

  // Rule 3 — two agents must not contact the same customer/subject for the same reason at once.
  const bySubject = new Map<string, CosCandidate[]>();
  for (const c of cands) {
    if (!c.effects.includes("contacts_customer") || !c.subject_key) continue;
    bySubject.set(c.subject_key, [...(bySubject.get(c.subject_key) ?? []), c]);
  }
  for (const [subject, list] of bySubject) {
    if (list.length < 2) continue;
    const sorted = [...list].sort(compareForArbitration);
    const winner = sorted[0]!;
    for (const loser of sorted.slice(1)) {
      mark(loser.dedupe_key, { rule_key: "same_subject_contact", by: winner.dedupe_key,
        reason: "Another recommendation already covers contacting this customer; doing both would message them twice." });
    }
    const keys = sorted.map((c) => c.dedupe_key).sort();
    conflicts.push({
      rule_key: "same_subject_contact",
      fingerprint: `same_subject_contact:${subject}:${keys.join("+")}`,
      severity: "info",
      summary: `${list.length} recommendations would each contact the same customer.`,
      dedupe_keys: keys,
      winner_dedupe_key: winner.dedupe_key,
      detail: { subject },
    });
  }

  return { suppressed, conflicts };
}

/** Applies arbitration to the candidate list: survivors stay "open", the rest become "suppressed". */
export function applyArbitration(cands: readonly CosCandidate[], result: ConflictResult): CosCandidate[] {
  return cands.map((c) => {
    const s = result.suppressed.get(c.dedupe_key);
    return s ? { ...c, status: "suppressed", suppressed_reason: s.reason } : { ...c, status: "open", suppressed_reason: null };
  });
}

/** The ranked "top actions" the home screen shows: open items only, best first, capped. */
export function topActions(cands: readonly CosCandidate[], n: number): CosCandidate[] {
  return cands
    .filter((c) => c.status !== "suppressed")
    .sort((a, b) => b.priority_score - a.priority_score || (a.dedupe_key < b.dedupe_key ? -1 : 1))
    .slice(0, n);
}
