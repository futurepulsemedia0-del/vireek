// Pure logic for the Microsoft 365 / Outlook calendar sync.
// No Deno / DOM APIs: runs in the edge functions and in Vitest.

export type ConnectionScope = "office" | "technician";

export const MS_SCOPES = ["offline_access", "User.Read", "Calendars.ReadWrite"] as const;
export const VIREEK_CATEGORY = "Vireek";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_DURATION_MIN = 60;
export const MIN_DURATION_MIN = 15;
export const MAX_DURATION_MIN = 720;
export const WINDOW_PAST_DAYS = 1;
export const WINDOW_FUTURE_DAYS = 120;
export const REBASELINE_BEFORE_DAYS = 30;
export const RESCHEDULE_TOLERANCE_MS = 60_000;
export const MAX_ACTIONS_PER_RUN = 80;
export const MAX_CONSECUTIVE_FAILURES = 5;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- OAuth ----

const TENANT_RE =
  /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,})$/i;

/** Only allow tenant values that are safe to place in a URL path; fall back to "common". */
export function normalizeTenant(raw?: string | null): string {
  const v = (raw ?? "").trim();
  return v && TENANT_RE.test(v) ? v.toLowerCase() : "common";
}

export function authorizeEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${normalizeTenant(tenant)}/oauth2/v2.0/authorize`;
}
export function tokenEndpoint(tenant: string): string {
  return `https://login.microsoftonline.com/${normalizeTenant(tenant)}/oauth2/v2.0/token`;
}

export function buildAuthorizeUrl(p: { clientId: string; tenant: string; redirectUri: string; state: string }): string {
  const u = new URL(authorizeEndpoint(p.tenant));
  u.searchParams.set("client_id", p.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", p.redirectUri);
  u.searchParams.set("response_mode", "query");
  u.searchParams.set("scope", MS_SCOPES.join(" "));
  u.searchParams.set("state", p.state);
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** State = `<userId>.<scope>.<timestamp>.<hmac>`; the callback has no session, so this is the only identity proof. */
export async function signMsState(userId: string, scope: ConnectionScope, secret: string, now = Date.now()): Promise<string> {
  if (!secret) throw new Error("State secret is not configured.");
  const payload = `${userId}.${scope}.${now}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyMsState(
  state: string,
  secret: string,
  now = Date.now(),
): Promise<{ userId: string; scope: ConnectionScope } | null> {
  if (!secret || !state) return null;
  const parts = state.split(".");
  if (parts.length !== 4) return null;
  const [userId, scope, tsRaw, sig] = parts;
  if (!UUID_RE.test(userId) || (scope !== "office" && scope !== "technician")) return null;
  const expected = await hmacHex(secret, `${userId}.${scope}.${tsRaw}`);
  if (!timingSafeEqual(expected, sig)) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts > now + 60_000 || now - ts > STATE_TTL_MS) return null;
  return { userId, scope };
}

/** Maps Microsoft's error response to a short code that is safe to put in a redirect URL. */
export function mapOAuthError(error?: string | null, description?: string | null): string {
  const e = (error ?? "").toLowerCase();
  const d = description ?? "";
  if (e === "access_denied" && !/AADSTS(65001|90094|650056|700016)/.test(d)) return "access_denied";
  if (e === "consent_required" || e === "interaction_required" || /AADSTS(65001|90094|650056)/.test(d)) return "admin_consent_required";
  return "provider_error";
}

export function tokenNeedsRefresh(expiresAtIso: string | null | undefined, now = Date.now(), skewMs = 120_000): boolean {
  if (!expiresAtIso) return true;
  const t = Date.parse(expiresAtIso);
  return !Number.isFinite(t) || t - now <= skewMs;
}

export function canManageCalendars(a: { role?: string | null; permissions?: Record<string, unknown> | null }): boolean {
  return a.role === "admin" || a.role === "owner" || a.permissions?.can_manage_team === true;
}

// ------------------------------------------------------------- Date/time ----

export function toGraphDateTime(d: Date): string {
  return d.toISOString().slice(0, 23); // YYYY-MM-DDTHH:mm:ss.sss (paired with timeZone "UTC")
}

/** Parses a Graph dateTimeTimeZone. We always request `outlook.timezone="UTC"`, so anything else is rejected. */
export function parseGraphDateTime(v: { dateTime?: string; timeZone?: string } | null | undefined): Date | null {
  if (!v?.dateTime || (v.timeZone ?? "").toUpperCase() !== "UTC") return null;
  const s = v.dateTime.trim().replace(/Z$/i, "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) return null;
  const d = new Date(`${s.replace(/(\.\d{3})\d+/, "$1")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function syncWindow(now: Date): { start: Date; end: Date } {
  return { start: new Date(now.getTime() - WINDOW_PAST_DAYS * DAY_MS), end: new Date(now.getTime() + WINDOW_FUTURE_DAYS * DAY_MS) };
}

export function needsRebaseline(s: { deltaLink: string | null; windowEnd: string | null }, now: Date): boolean {
  if (!s.deltaLink || !s.windowEnd) return true;
  const end = Date.parse(s.windowEnd);
  return !Number.isFinite(end) || end - now.getTime() < REBASELINE_BEFORE_DAYS * DAY_MS;
}

// ----------------------------------------------------------------- Jobs ----

export interface SyncJob {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  service_type: string | null;
  address: string | null;
  scheduled_datetime: string | null;
  duration_minutes: number | null;
  assigned_technician_id: string | null;
  job_status: string;
  dispatch_note: string | null;
}

export interface ConnectionInfo { scope: ConnectionScope; teamMemberId: string | null }
export type JobDisposition = "sync" | "remove" | "ignore";

export function clampDuration(minutes: number | null | undefined): number {
  const m = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : DEFAULT_DURATION_MIN;
  return Math.min(MAX_DURATION_MIN, Math.max(MIN_DURATION_MIN, m));
}

export function jobWindow(job: SyncJob): { start: Date; end: Date } | null {
  if (!job.scheduled_datetime) return null;
  const start = new Date(job.scheduled_datetime);
  if (Number.isNaN(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + clampDuration(job.duration_minutes) * 60_000) };
}

/** sync = keep the event correct; remove = delete it from Outlook; ignore = leave whatever is there (history). */
export function classifyJob(job: SyncJob | null, conn: ConnectionInfo, now: Date): JobDisposition {
  if (!job) return "remove";
  if (job.job_status === "cancelled" || job.job_status === "no_show") return "remove";
  const w = jobWindow(job);
  if (!w) return "remove";
  if (conn.scope === "technician" && job.assigned_technician_id !== conn.teamMemberId) return "remove";
  if (w.start.getTime() < now.getTime() - WINDOW_PAST_DAYS * DAY_MS) return "ignore";
  return "sync";
}

export interface GraphEventPayload {
  subject: string;
  body: { contentType: "text"; content: string };
  start: { dateTime: string; timeZone: "UTC" };
  end: { dateTime: string; timeZone: "UTC" };
  location: { displayName: string };
  showAs: "busy";
  categories: string[];
  isReminderOn: boolean;
  reminderMinutesBeforeStart: number;
}

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled", en_route: "Technician en route", in_progress: "In progress", completed: "Completed",
};

export function buildEventPayload(job: SyncJob, appUrl: string): GraphEventPayload | null {
  const w = jobWindow(job);
  if (!w) return null;
  const lines = [
    job.customer_name ? `Customer: ${job.customer_name}` : null,
    job.customer_phone ? `Phone: ${job.customer_phone}` : null,
    job.address ? `Address: ${job.address}` : null,
    `Status: ${STATUS_LABEL[job.job_status] ?? job.job_status}`,
    job.dispatch_note ? `Dispatch note: ${job.dispatch_note}` : null,
    "",
    `Managed in Vireek: ${appUrl.replace(/\/$/, "")}/dashboard/jobs`,
    "Reschedule by moving this event in Outlook or in Vireek; changes sync both ways.",
  ].filter((l): l is string => l !== null);
  return {
    subject: `${job.service_type?.trim() || "Service call"} — ${job.customer_name?.trim() || "Customer"}`.slice(0, 200),
    body: { contentType: "text", content: lines.join("\n") },
    start: { dateTime: toGraphDateTime(w.start), timeZone: "UTC" },
    end: { dateTime: toGraphDateTime(w.end), timeZone: "UTC" },
    location: { displayName: (job.address ?? "").slice(0, 250) },
    showAs: "busy",
    categories: [VIREEK_CATEGORY],
    isReminderOn: true,
    reminderMinutesBeforeStart: 30,
  };
}

/** Deterministic id so a retried create never produces a duplicate Outlook event. */
export function createTransactionId(jobId: string, connectionId: string): string {
  return `vireek-${jobId}-${connectionId}`.slice(0, 255);
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const hashPayload = (p: GraphEventPayload) => sha256Hex(JSON.stringify(p));

// ------------------------------------------------------- Push (Vireek → Outlook)

export interface DesiredEvent { jobId: string; hash: string; payload: GraphEventPayload }
export interface EventMapRow { jobId: string; msEventId: string; hash: string; status: "synced" | "remote_deleted" }
export type PushAction =
  | { kind: "create"; jobId: string; hash: string; payload: GraphEventPayload }
  | { kind: "update"; jobId: string; msEventId: string; hash: string; payload: GraphEventPayload }
  | { kind: "delete"; jobId: string; msEventId: string }
  | { kind: "forget"; jobId: string };

export function planPushActions(i: {
  desired: DesiredEvent[];
  removeJobIds: Iterable<string>;
  mapped: EventMapRow[];
  forceUpdate?: Set<string>;
  limit?: number;
}): PushAction[] {
  const byJob = new Map(i.mapped.map((m) => [m.jobId, m]));
  const force = i.forceUpdate ?? new Set<string>();
  const actions: PushAction[] = [];
  for (const d of [...i.desired].sort((a, b) => a.jobId.localeCompare(b.jobId))) {
    const m = byJob.get(d.jobId);
    if (!m) actions.push({ kind: "create", jobId: d.jobId, hash: d.hash, payload: d.payload });
    else if (m.status === "remote_deleted") {
      // The user deleted it in Outlook: respect that until the job itself changes.
      if (m.hash !== d.hash) actions.push({ kind: "create", jobId: d.jobId, hash: d.hash, payload: d.payload });
    } else if (m.hash !== d.hash || force.has(d.jobId)) {
      actions.push({ kind: "update", jobId: d.jobId, msEventId: m.msEventId, hash: d.hash, payload: d.payload });
    }
  }
  for (const jobId of [...new Set(i.removeJobIds)].sort()) {
    const m = byJob.get(jobId);
    if (!m) continue;
    actions.push(m.status === "synced" ? { kind: "delete", jobId, msEventId: m.msEventId } : { kind: "forget", jobId });
  }
  return actions.slice(0, i.limit ?? MAX_ACTIONS_PER_RUN);
}

// ------------------------------------------------------ Pull (Outlook → Vireek)

export interface RemoteEvent {
  id: string;
  removed: boolean;
  isCancelled: boolean;
  isAllDay: boolean;
  showAs: string;
  start: Date | null;
  end: Date | null;
  lastModified: Date | null;
  categories: string[];
}

export function parseRemoteEvent(raw: unknown): RemoteEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  if (typeof r.id !== "string" || !r.id) return null;
  const base = { id: r.id, isCancelled: false, isAllDay: false, showAs: "busy", start: null, end: null, lastModified: null, categories: [] as string[] };
  if (r["@removed"]) return { ...base, removed: true };
  const start = parseGraphDateTime(r.start);
  const end = parseGraphDateTime(r.end);
  if (!start || !end) return null;
  const lm = typeof r.lastModifiedDateTime === "string" ? new Date(r.lastModifiedDateTime) : null;
  return {
    ...base,
    removed: false,
    isCancelled: r.isCancelled === true,
    isAllDay: r.isAllDay === true,
    showAs: typeof r.showAs === "string" ? r.showAs : "busy",
    start,
    end,
    lastModified: lm && !Number.isNaN(lm.getTime()) ? lm : null,
    categories: Array.isArray(r.categories) ? r.categories.filter((c: unknown): c is string => typeof c === "string") : [],
  };
}

export const BLOCKING_SHOW_AS = new Set(["busy", "oof", "tentative"]);

export interface BusyBlock { msEventId: string; startsAt: string; endsAt: string; showAs: string; isAllDay: boolean; blocking: boolean }

/** Returns null for events that must not count as external busy time (removed, cancelled, Vireek's own events). */
export function toBusyBlock(ev: RemoteEvent, vireekEventIds: Set<string>): BusyBlock | null {
  if (ev.removed || ev.isCancelled || !ev.start || !ev.end || ev.end <= ev.start) return null;
  if (vireekEventIds.has(ev.id) || ev.categories.includes(VIREEK_CATEGORY)) return null;
  return {
    msEventId: ev.id,
    startsAt: ev.start.toISOString(),
    endsAt: ev.end.toISOString(),
    showAs: ev.showAs,
    isAllDay: ev.isAllDay,
    blocking: BLOCKING_SHOW_AS.has(ev.showAs),
  };
}

export interface InboundMapEntry { jobId: string; status: "synced" | "remote_deleted"; lastPushedAt: Date | null }
export type InboundChange =
  | { kind: "reschedule"; jobId: string; newStart: string; durationMinutes: number; expectedStart: string }
  | { kind: "remote_deleted"; jobId: string };

/**
 * Two-way job events. Outlook wins only when the user moved the event after our last push and the job is still
 * "scheduled"; in every other disagreement Vireek wins and the event is forced back to the job's real time.
 * Deleting an event in Outlook never cancels the job.
 */
export function planInboundChanges(
  events: RemoteEvent[],
  mapByEventId: Map<string, InboundMapEntry>,
  jobsById: Map<string, SyncJob>,
): { changes: InboundChange[]; forceUpdateJobIds: Set<string> } {
  const changes: InboundChange[] = [];
  const force = new Set<string>();
  for (const ev of events) {
    const m = mapByEventId.get(ev.id);
    if (!m || m.status !== "synced") continue;
    if (ev.removed || ev.isCancelled) { changes.push({ kind: "remote_deleted", jobId: m.jobId }); continue; }
    const job = jobsById.get(m.jobId);
    const w = job ? jobWindow(job) : null;
    if (!job || !w || !ev.start || !ev.end) continue;
    const differs = Math.abs(ev.start.getTime() - w.start.getTime()) > RESCHEDULE_TOLERANCE_MS ||
      Math.abs(ev.end.getTime() - w.end.getTime()) > RESCHEDULE_TOLERANCE_MS;
    if (!differs) continue;
    const newer = !!ev.lastModified && !!m.lastPushedAt && ev.lastModified.getTime() > m.lastPushedAt.getTime() + 2000;
    if (newer && !ev.isAllDay && job.job_status === "scheduled" && job.scheduled_datetime) {
      changes.push({
        kind: "reschedule",
        jobId: m.jobId,
        newStart: ev.start.toISOString(),
        durationMinutes: clampDuration(Math.round((ev.end.getTime() - ev.start.getTime()) / 60_000)),
        expectedStart: job.scheduled_datetime,
      });
    } else force.add(m.jobId);
  }
  return { changes, forceUpdateJobIds: force };
}

// --------------------------------------------------------------- Errors ----

export interface FailureClass { errorCode: string; recoverable: boolean; resetDelta: boolean }

export function classifyGraphFailure(status: number, code?: string | null): FailureClass {
  const c = (code ?? "").toLowerCase();
  if (c === "invalid_grant" || c === "interaction_required" || c === "consent_required") return { errorCode: "token_revoked", recoverable: false, resetDelta: false };
  if (status === 410 || c === "syncstatenotfound" || c === "resyncrequired") return { errorCode: "unknown", recoverable: true, resetDelta: true };
  if (status === 401) return { errorCode: "provider_auth_failed", recoverable: false, resetDelta: false };
  if (status === 403) return { errorCode: "scope_missing", recoverable: false, resetDelta: false };
  if (status === 429) return { errorCode: "rate_limited", recoverable: true, resetDelta: false };
  if (status === 0 || status >= 500) return { errorCode: "provider_unreachable", recoverable: true, resetDelta: false };
  return { errorCode: "unknown", recoverable: true, resetDelta: false };
}
