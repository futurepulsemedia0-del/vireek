// supabase/functions/_shared/economics/routeOverrides.ts
//
// One-switch, evidence-gated per-task route overrides. Pure.
//  - Source: secret AI_ROUTE_OVERRIDES_JSON (same pattern as AI_PRICE_OVERRIDES_JSON). Kill switch: AI_ROUTE_OVERRIDES_DISABLED=1.
//  - An override is IGNORED unless it carries gate evidence that passed (pass=true, n>=minCases, ciLow >= -tolerance).
//  - The original chain is always kept behind the override entries, so a failing candidate falls back to the baseline.

export interface RouteEntryLike { provider: string; priority: number; model: string }
export interface GateEvidence { pass: boolean; n: number; ciLow: number; tolerance: number; reportId: string; approvedBy: string }
export interface RouteOverride { task: string; entries: RouteEntryLike[]; evidence: GateEvidence }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseOverrides(json: string | undefined | null, knownProviders: readonly string[], minCases = 30): RouteOverride[] {
  if (!json) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: RouteOverride[] = [];
  for (const o of raw) {
    if (!isObj(o) || typeof o.task !== "string" || !Array.isArray(o.entries) || !isObj(o.evidence)) continue;
    const e = o.evidence;
    const ev: GateEvidence = {
      pass: e.pass === true, n: Number(e.n), ciLow: Number(e.ciLow), tolerance: Number(e.tolerance),
      reportId: typeof e.reportId === "string" ? e.reportId : "", approvedBy: typeof e.approvedBy === "string" ? e.approvedBy : "",
    };
    if (!ev.pass || !(ev.n >= minCases) || !(ev.ciLow >= -Math.abs(ev.tolerance)) || !ev.reportId || !ev.approvedBy) continue;
    const entries = (o.entries as unknown[]).filter(isObj).map((x) => ({ provider: String(x.provider), priority: Number(x.priority), model: String(x.model) }))
      .filter((x) => knownProviders.includes(x.provider) && Number.isFinite(x.priority) && x.model.length > 0);
    if (entries.length === 0 || entries.length !== (o.entries as unknown[]).length) continue;
    out.push({ task: o.task, entries, evidence: ev });
  }
  return out;
}

export function applyRouteOverrides(
  task: string, base: readonly RouteEntryLike[], json: string | undefined | null, disabled: boolean, knownProviders: readonly string[],
): { route: RouteEntryLike[]; applied: boolean } {
  if (disabled) return { route: [...base], applied: false };
  const ov = parseOverrides(json, knownProviders).find((o) => o.task === task);
  if (!ov) return { route: [...base], applied: false };
  const head = [...ov.entries].sort((a, b) => a.priority - b.priority).map((e, i) => ({ ...e, priority: i + 1 }));
  const tail = base.map((e) => ({ ...e, priority: e.priority + 1000 }));
  return { route: [...head, ...tail], applied: true };
}
