// supabase/functions/_shared/privacy/readLog.ts
//
// Server-side helper for the sensitive-read access log (see migration
// 20281103000000_sensitive_read_access_log.sql). Pure, dependency-free
// functions plus one thin RPC wrapper. NEVER pass content here: only ids,
// counts and enumerated classes are accepted, everything else is rejected.

export type AssetClass = "call_recording" | "transcript" | "customer_pii" | "payment_data" | "document" | "export";
export type ReadAction = "view" | "list" | "download" | "export_create" | "export_download" | "signed_url" | "api_read";
export type ReadChannel = "ui" | "rpc" | "edge" | "api" | "export" | "staff";
export type ActorKind = "user" | "staff" | "api_key" | "system" | "public_link";
export type ReadPurpose = "service_delivery" | "support_ticket" | "security_review" | "legal_hold" | "customer_export" | "integration";

export interface ReadLogEntry {
  accountId: string;
  actorKind: ActorKind;
  actorId?: string | null;
  apiKeyId?: string | null;
  assetClass: AssetClass;
  action: ReadAction;
  channel: ReadChannel;
  targetTable?: string | null;
  targetId?: string | null;
  recordCount?: number;
  purpose?: ReadPurpose;
  requestId?: string | null;
}

export interface RpcCaller {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = /^[a-z_]{1,63}$/;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const ASSETS: readonly AssetClass[] = ["call_recording", "transcript", "customer_pii", "payment_data", "document", "export"];
const ACTIONS: readonly ReadAction[] = ["view", "list", "download", "export_create", "export_download", "signed_url", "api_read"];
const MAX_RECORDS = 10_000_000;

export class ReadLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadLogError";
  }
}

/** Validates an entry and returns the RPC argument object. Throws ReadLogError on anything unsafe. */
export function buildReadLogArgs(e: ReadLogEntry): Record<string, unknown> {
  if (!UUID.test(e.accountId)) throw new ReadLogError("accountId must be a UUID");
  if (e.actorId != null && !UUID.test(e.actorId)) throw new ReadLogError("actorId must be a UUID");
  if (e.apiKeyId != null && !UUID.test(e.apiKeyId)) throw new ReadLogError("apiKeyId must be a UUID");
  if (!ASSETS.includes(e.assetClass)) throw new ReadLogError("unknown assetClass");
  if (!ACTIONS.includes(e.action)) throw new ReadLogError("unknown action");
  if (e.targetTable != null && !TABLE.test(e.targetTable)) throw new ReadLogError("targetTable invalid");
  if (e.targetId != null && !UUID.test(e.targetId)) throw new ReadLogError("targetId must be a UUID (never free text)");
  if (e.requestId != null && !REQUEST_ID.test(e.requestId)) throw new ReadLogError("requestId invalid");
  const n = e.recordCount ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_RECORDS) throw new ReadLogError("recordCount out of range");
  return {
    p_account_id: e.accountId,
    p_actor_kind: e.actorKind,
    p_actor_id: e.actorId ?? null,
    p_api_key_id: e.apiKeyId ?? null,
    p_asset_class: e.assetClass,
    p_action: e.action,
    p_channel: e.channel,
    p_target_table: e.targetTable ?? null,
    p_target_id: e.targetId ?? null,
    p_record_count: n,
    p_purpose: e.purpose ?? "service_delivery",
    p_request_id: e.requestId ?? null,
  };
}

/**
 * Writes one log row via the service-role-only RPC. FAIL CLOSED: if the log
 * cannot be written the caller must NOT return the sensitive data.
 */
export async function logSensitiveRead(admin: RpcCaller, entry: ReadLogEntry): Promise<void> {
  const args = buildReadLogArgs(entry);
  const { error } = await admin.rpc("log_sensitive_read", args);
  if (error) throw new ReadLogError("read log unavailable");
}

/** Which asset classes a public-API table exposes. Tables not listed expose none of the sensitive classes. */
export const API_TABLE_ASSETS: Readonly<Record<string, readonly AssetClass[]>> = {
  calls: ["call_recording", "transcript"],
  leads: ["customer_pii"],
  jobs: ["customer_pii"],
};

/** Log entries for one API read (single record => "view" with id, collection => one aggregated "list" row). */
export function apiReadEntries(opts: {
  accountId: string; apiKeyId: string; table: string; recordId: string | null; returned: number; requestId?: string | null;
}): ReadLogEntry[] {
  const assets = API_TABLE_ASSETS[opts.table];
  if (!assets || assets.length === 0 || opts.returned < 1) return [];
  return assets.map((assetClass) => ({
    accountId: opts.accountId,
    actorKind: "api_key" as const,
    apiKeyId: opts.apiKeyId,
    assetClass,
    action: "api_read" as const,
    channel: "api" as const,
    targetTable: opts.table,
    targetId: opts.recordId,
    recordCount: Math.max(1, opts.returned),
    purpose: "integration" as const,
    requestId: opts.requestId ?? null,
  }));
}

/** Maps DB error codes from the protected RPCs to HTTP statuses for edge functions. */
export function readGateStatus(err: { message: string; code?: string } | null): { status: number; code: string } | null {
  if (!err) return null;
  switch (err.code) {
    case "SR401": return { status: 401, code: "step_up_required" };
    case "SR429": return { status: 429, code: "rate_limited" };
    case "42501": return { status: 403, code: "forbidden" };
    case "28000": return { status: 401, code: "unauthenticated" };
    default: return { status: 500, code: "read_gate_failed" };
  }
}
