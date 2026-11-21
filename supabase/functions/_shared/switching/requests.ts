// supabase/functions/_shared/switching/requests.ts
//
// Pure logic for the switching-request workflow (see migration 20290306000100_switching_requests.sql and
// docs/compliance/switching-process.md). The transition table and default day counts MUST match the SQL;
// requests.test.ts parses the migration to prove they do. No Deno, no I/O.

export const SWITCHING_STATUSES = [
  "requested", "acknowledged", "exporting", "export_ready", "in_transition", "completed", "cancelled", "rejected",
] as const;
export type SwitchingStatus = (typeof SWITCHING_STATUSES)[number];

export const OPEN_STATUSES: readonly SwitchingStatus[] = ["requested", "acknowledged", "exporting", "export_ready", "in_transition"];

export const TRANSITIONS: Readonly<Record<SwitchingStatus, readonly SwitchingStatus[]>> = {
  requested: ["acknowledged", "rejected", "cancelled"],
  acknowledged: ["exporting", "rejected", "cancelled"],
  exporting: ["export_ready", "cancelled"],
  export_ready: ["in_transition", "completed", "cancelled"],
  in_transition: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: [],
};

/** PLACEHOLDER defaults [COUNSEL] — must equal the column defaults in the migration. */
export const DEFAULT_ACK_DAYS = 3;
export const DEFAULT_EXPORT_DAYS = 30;
export const DEFAULT_RETRIEVAL_DAYS = 30;

export const canTransition = (from: SwitchingStatus, to: SwitchingStatus): boolean => TRANSITIONS[from].includes(to);
export const isOpen = (s: SwitchingStatus): boolean => OPEN_STATUSES.includes(s);

const DAY = 86_400_000;
export function computeDeadlines(requestedAt: Date, days = { ack: DEFAULT_ACK_DAYS, export: DEFAULT_EXPORT_DAYS }) {
  return {
    acknowledgeDueAt: new Date(requestedAt.getTime() + days.ack * DAY),
    exportDueAt: new Date(requestedAt.getTime() + days.export * DAY),
  };
}

export interface RequestRow {
  status: SwitchingStatus;
  acknowledge_due_at: string;
  export_due_at: string;
}

export type DueKind = "acknowledge" | "export";

/** Which deadline is currently running (if any) and how far past it the request is. Mirrors switching_requests_overdue(). */
export function currentDeadline(r: RequestRow, now: Date = new Date()): { kind: DueKind; dueAt: Date; overdue: boolean; daysOverdue: number } | null {
  const kind: DueKind | null = r.status === "requested" ? "acknowledge" : r.status === "acknowledged" || r.status === "exporting" ? "export" : null;
  if (!kind) return null;
  const dueAt = new Date(kind === "acknowledge" ? r.acknowledge_due_at : r.export_due_at);
  const overdue = dueAt.getTime() < now.getTime();
  return { kind, dueAt, overdue, daysOverdue: overdue ? Math.floor((now.getTime() - dueAt.getTime()) / DAY) : 0 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max) : "";

export type SwitchingCommand =
  | { action: "create"; targetProvider: string; notes: string }
  | { action: "cancel"; id: string; note: string }
  | { action: "advance"; id: string; to: SwitchingStatus; note: string }
  | { action: "list" }
  | { action: "overdue" };

export function parseCommand(input: unknown): { ok: true; value: SwitchingCommand } | { ok: false; error: string } {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (src.action) {
    case "create":
      return { ok: true, value: { action: "create", targetProvider: clean(src.targetProvider, 120), notes: clean(src.notes, 2000) } };
    case "cancel":
      if (typeof src.id !== "string" || !UUID_RE.test(src.id)) return { ok: false, error: "id must be a UUID." };
      return { ok: true, value: { action: "cancel", id: src.id, note: clean(src.note, 1000) } };
    case "advance": {
      if (typeof src.id !== "string" || !UUID_RE.test(src.id)) return { ok: false, error: "id must be a UUID." };
      const to = src.to as SwitchingStatus;
      if (!SWITCHING_STATUSES.includes(to) || to === "requested") return { ok: false, error: "Unknown target status." };
      return { ok: true, value: { action: "advance", id: src.id, to, note: clean(src.note, 1000) } };
    }
    case "list":
      return { ok: true, value: { action: "list" } };
    case "overdue":
      return { ok: true, value: { action: "overdue" } };
    default:
      return { ok: false, error: "Unknown action." };
  }
}

/** Maps the SQLSTATE/message raised by the RPCs to an HTTP status and a safe message. */
export function mapRpcError(err: { code?: string; message?: string } | null | undefined): { status: number; code: string; message: string } {
  const m = err?.message ?? "";
  if (err?.code === "42501" || m.includes("SWITCHING_FORBIDDEN")) return { status: 403, code: "forbidden", message: "Not allowed." };
  if (m.includes("SWITCHING_ALREADY_OPEN")) return { status: 409, code: "already_open", message: "A switching request is already open for this account." };
  if (m.includes("SWITCHING_BAD_TRANSITION")) return { status: 409, code: "bad_transition", message: "That status change is not allowed from the current status." };
  if (m.includes("SWITCHING_REASON_REQUIRED")) return { status: 422, code: "reason_required", message: "A rejection needs a reason of at least 10 characters." };
  if (m.includes("SWITCHING_USE_CANCEL")) return { status: 422, code: "use_cancel", message: "Cancellation is done by the account owner." };
  return { status: 500, code: "server_error", message: "Something went wrong." };
}
