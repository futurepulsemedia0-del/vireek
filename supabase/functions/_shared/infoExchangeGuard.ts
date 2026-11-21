// supabase/functions/_shared/infoExchangeGuard.ts
//
// Fail-closed client for the antitrust information-exchange guardrails (migration
// 20290306000000_antitrust_info_exchange_guardrails.sql). Edge functions that publish cross-tenant
// aggregates call guardRows() BEFORE writing. The thresholds (minimum cohort, single-tenant share, data lag,
// narrow geography, counsel approval) live in the database config, never here.
//
// Contract: if the guard cannot give a complete, well-formed answer for EVERY item, guardRows() throws
// GuardUnavailableError. The caller must then publish nothing and purge what is already published.

export interface GuardItemInput {
  metric: string;
  cohort_size: number | null;
  geo_text?: string | null;
  geo_level?: string | null;
  max_share_pct?: number | null;
  data_end?: string | null; // YYYY-MM-DD
}

export interface GuardVerdict {
  key: string;
  allowed: boolean;
  reasons: string[];
}

export interface GuardRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export class GuardUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardUnavailableError";
  }
}

export interface GuardResult<T> {
  allowed: T[];
  blocked: { row: T; reasons: string[] }[];
}

function isVerdict(v: unknown): v is GuardVerdict {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.key === "string" && typeof o.allowed === "boolean" && Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === "string");
}

/**
 * Evaluates every row. A row may carry several metrics (wide rows such as regional demand): it is allowed
 * only if ALL of its metrics pass. A row that maps to zero items is blocked (nothing was proven).
 */
export async function guardRows<T>(
  client: GuardRpcClient,
  flow: string,
  rows: T[],
  toItems: (row: T, index: number) => GuardItemInput[],
): Promise<GuardResult<T>> {
  if (rows.length === 0) return { allowed: [], blocked: [] };

  const items: Array<GuardItemInput & { key: string }> = [];
  const itemCountByRow: number[] = [];
  rows.forEach((row, i) => {
    const list = toItems(row, i);
    itemCountByRow.push(list.length);
    list.forEach((it, j) => items.push({ ...it, key: `${i}:${j}` }));
  });

  const { data, error } = await client.rpc("ixg_check_rows", { p_flow: flow, p_items: items });
  if (error) throw new GuardUnavailableError(`ixg_check_rows failed: ${error.message}`);
  if (!Array.isArray(data) || data.length !== items.length || !data.every(isVerdict)) {
    throw new GuardUnavailableError("ixg_check_rows returned an unexpected shape");
  }

  const verdictByKey = new Map<string, GuardVerdict>();
  for (const v of data as GuardVerdict[]) verdictByKey.set(v.key, v);

  const allowed: T[] = [];
  const blocked: { row: T; reasons: string[] }[] = [];
  rows.forEach((row, i) => {
    const reasons = new Set<string>();
    let ok = itemCountByRow[i] > 0;
    if (itemCountByRow[i] === 0) reasons.add("no_items_to_evaluate");
    for (let j = 0; j < itemCountByRow[i]; j++) {
      const v = verdictByKey.get(`${i}:${j}`);
      if (!v) throw new GuardUnavailableError("ixg_check_rows omitted a verdict");
      if (!v.allowed) {
        ok = false;
        v.reasons.forEach((r) => reasons.add(r));
      }
    }
    if (ok) allowed.push(row);
    else blocked.push({ row, reasons: [...reasons] });
  });
  return { allowed, blocked };
}
