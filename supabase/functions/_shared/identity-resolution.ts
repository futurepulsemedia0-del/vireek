// Customer identity resolution — Edge Function helper.
// All scoring lives in SQL (identity_lookup / identity_ingest, migration
// 20271102000000). This file only calls it and turns the result into safe
// wording for the voice agent. Dependency-free so it is unit-testable.

export interface RpcClient {
  rpc(
    fn: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type IdentityBand = "high" | "medium" | "low" | "none";

export interface IdentityHouseholdMember {
  customerId: string;
  name: string;
  status: string;
}

export interface IdentityLookup {
  matched: boolean;
  band: IdentityBand;
  customerId: string | null;
  name: string | null;
  score: number;
  signals: string[];
  conflict: boolean;
  alternatives: { customerId: string; name: string; score: number }[];
  household: { id: string; name: string; members: IdentityHouseholdMember[] } | null;
}

export interface IdentityQuery {
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  name?: string | null;
}

const NONE: IdentityLookup = {
  matched: false, band: "none", customerId: null, name: null, score: 0,
  signals: [], conflict: false, alternatives: [], household: null,
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clean = (v: unknown): string | null => str(v);

/** Defensive parse of the identity_lookup() payload. Never throws. */
export function parseIdentityLookup(raw: unknown): IdentityLookup {
  if (!raw || typeof raw !== "object") return NONE;
  const r = raw as Record<string, unknown>;
  const band = (["high", "medium", "low", "none"] as const).find((b) => b === r.band) ?? "none";
  const cands = Array.isArray(r.candidates) ? (r.candidates as Record<string, unknown>[]) : [];
  const best = (r.best && typeof r.best === "object" ? r.best : cands[0]) as Record<string, unknown> | undefined;
  if (!best || band === "none") return NONE;

  const signals = Array.isArray(best.signals)
    ? (best.signals as Record<string, unknown>[]).map((s) => str(s?.type)).filter((s): s is string => !!s)
    : [];

  let household: IdentityLookup["household"] = null;
  const hh = r.household as Record<string, unknown> | null | undefined;
  if (hh && typeof hh === "object" && str(hh.id)) {
    const members = Array.isArray(hh.members) ? (hh.members as Record<string, unknown>[]) : [];
    household = {
      id: String(hh.id),
      name: str(hh.name) ?? "Household",
      members: members
        .map((m) => ({ customerId: str(m.customer_id) ?? "", name: str(m.name) ?? "", status: str(m.status) ?? "suggested" }))
        .filter((m) => m.customerId && m.name),
    };
  }

  return {
    matched: r.matched === true,
    band,
    customerId: str(best.customer_id),
    name: clean(best.name),
    score: num(best.score),
    signals,
    conflict: best.conflict === true,
    alternatives: cands.slice(1).map((c) => ({
      customerId: str(c.customer_id) ?? "", name: str(c.name) ?? "", score: num(c.score),
    })).filter((c) => c.customerId),
    household,
  };
}

/** Real-time lookup. Never throws: on any failure the call simply proceeds unidentified. */
export async function lookupCallerIdentity(
  admin: RpcClient,
  ownerId: string,
  q: IdentityQuery,
): Promise<IdentityLookup> {
  try {
    const { data, error } = await admin.rpc("identity_lookup", {
      p_owner: ownerId,
      p_phone: q.phone ?? null,
      p_email: q.email ?? null,
      p_address: q.address ?? null,
      p_name: q.name ?? null,
      p_limit: 3,
    });
    if (error) {
      console.error("identity_lookup_failed", error.message);
      return NONE;
    }
    return parseIdentityLookup(data);
  } catch (e) {
    console.error("identity_lookup_exception", e instanceof Error ? e.message : String(e));
    return NONE;
  }
}

/**
 * Wording for the voice agent. High confidence may be greeted by name;
 * medium must be confirmed first; low / ambiguous / conflicting says nothing.
 * Household members are only ever hinted at, never recited.
 */
export function buildIdentityContext(id: IdentityLookup): string {
  if (!id.matched || !id.name || id.conflict) return "";
  const ambiguous = id.alternatives.some((a) => id.score - a.score < 15);
  if (id.band === "high" && !ambiguous) {
    const hh = id.household && id.household.members.length > 0
      ? ` They share a household with ${id.household.members.slice(0, 3).map((m) => m.name).join(", ")} — only mention this if the caller brings it up.`
      : "";
    return `Identity check: the caller is recognised as ${id.name} (high confidence, matched on ${id.signals.join(" + ") || "records"}). You may greet them by name.${hh}`;
  }
  if (id.band === "medium" || (id.band === "high" && ambiguous)) {
    return `Identity check: the caller may be ${id.name} (not certain). Do NOT use the name or any account detail until the caller confirms who they are.`;
  }
  return "";
}

/** The legacy exact-phone builder says "new caller"; when identity disagrees, identity wins. */
export function mergeCallerContext(base: string, identityContext: string): string {
  if (!identityContext) return base;
  const looksNew = base.startsWith("This is a new caller") || base.startsWith("No caller ID");
  return looksNew ? identityContext : `${base} ${identityContext}`;
}

/** Best-effort write path for code that is not covered by the DB triggers. Never throws. */
export async function ingestIdentity(
  admin: RpcClient,
  ownerId: string,
  q: IdentityQuery,
  source: string,
  sourceRef?: string | null,
): Promise<{ status: string; customerId?: string } | null> {
  try {
    const { data, error } = await admin.rpc("identity_ingest", {
      p_owner: ownerId,
      p_phone: q.phone ?? null,
      p_email: q.email ?? null,
      p_address: q.address ?? null,
      p_name: q.name ?? null,
      p_source: source,
      p_source_ref: sourceRef ?? null,
    });
    if (error || !data || typeof data !== "object") return null;
    const d = data as Record<string, unknown>;
    return { status: String(d.status ?? "unknown"), customerId: str(d.customer_id) ?? undefined };
  } catch {
    return null;
  }
}
