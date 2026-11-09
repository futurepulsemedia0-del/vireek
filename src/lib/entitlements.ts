// Pure module-entitlement logic: types, display helpers, nav filtering, form parsing and the client store.
// No React and no network here (the store takes a `fetchRows` function), so everything is unit-tested in
// entitlements.test.ts. Data access: entitlementsApi.ts. React hook: hooks/useEntitlement.ts.
//
// Layering: feature flags (featureFlags.ts) = platform switch; entitlements = per-account switch.
// DEFAULT DENY: no row, 'off', expired, not yet loaded, signed out, or a failed first load all mean "not allowed".

export const FIXED_MODULE_IDS = ['core', 'pay', 'ai', 'supply', 'finance', 'passport', 'intelligence', 'connect'] as const;
export type FixedModuleId = (typeof FIXED_MODULE_IDS)[number];
export type PackModuleId = `packs:${string}`;
export type ModuleId = FixedModuleId | PackModuleId;

export const ENTITLEMENT_STATES = ['off', 'trial', 'on'] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];
export const ENTITLEMENT_SOURCES = ['manual', 'plan', 'override'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

export const ENTITLEMENT_CACHE_TTL_MS = 5 * 60 * 1000;
export const REASON_MIN = 5;
export const REASON_MAX = 300;

// Mirrors is_valid_module_id() in the migration.
const MODULE_RE = /^(core|pay|ai|supply|finance|passport|intelligence|connect|packs:[a-z0-9][a-z0-9_-]{0,39})$/;
export const isValidModuleId = (v: string): v is ModuleId => MODULE_RE.test(v);

export interface Entitlement {
  module_id: string;
  state: EntitlementState;
  source: EntitlementSource;
  /** ISO timestamp or null (no expiry). */
  expires_at: string | null;
  /** Server-computed with the server clock at fetch time. Re-checked locally against expires_at on every read. */
  active: boolean;
}

export interface StaffEntitlement extends Entitlement {
  reason: string | null;
  updated_at: string;
  updated_by_email: string | null;
}

export interface EntitlementAuditEntry {
  id: number;
  module_id: string;
  action: 'grant' | 'change' | 'revoke' | 'remove';
  before: { state?: string; source?: string; expires_at?: string | null } | null;
  after: { state?: string; source?: string; expires_at?: string | null } | null;
  reason: string | null;
  created_at: string;
  actor_email: string | null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * A row only grants access when it is on/trial, the server said it was active, AND it has not expired by the
 * local clock since the fetch. The local check can only DENY (never grant), so clock skew cannot open a module;
 * the server (has_module / entitlement_check) stays the authority for anything that matters.
 */
export function isEntitled(row: Entitlement | undefined, nowMs: number): boolean {
  if (!row || !row.active) return false;
  if (row.state !== 'on' && row.state !== 'trial') return false;
  if (row.expires_at === null) return true;
  const exp = Date.parse(row.expires_at);
  return Number.isFinite(exp) && exp > nowMs;
}

export type EntitlementStatus = 'loading' | 'ready' | 'error';

export interface EntitlementResult {
  /** The only value to gate UI on. False while loading or after an error with nothing cached. */
  allowed: boolean;
  status: EntitlementStatus;
  /** 'on' | 'trial' when allowed; 'off' otherwise (including expired). */
  state: EntitlementState;
  source: EntitlementSource | null;
  expiresAt: string | null;
  /** Whole days left on a trial / timed grant, or null. */
  daysLeft: number | null;
  /** True when a row exists but has expired (lets the UI say "expired" instead of "not available"). */
  expired: boolean;
}

export function resolveEntitlement(snap: EntitlementSnapshot, userId: string | null, moduleId: string, nowMs: number): EntitlementResult {
  const known = userId !== null && snap.userId === userId && snap.fetchedAt > 0;
  if (!known) {
    return { allowed: false, status: snap.status === 'error' && snap.userId === userId ? 'error' : 'loading', state: 'off', source: null, expiresAt: null, daysLeft: null, expired: false };
  }
  const row = snap.rows.get(moduleId);
  const allowed = isEntitled(row, nowMs);
  const exp = row?.expires_at ? Date.parse(row.expires_at) : NaN;
  const expired = Boolean(row && (row.state === 'on' || row.state === 'trial') && Number.isFinite(exp) && exp <= nowMs);
  return {
    allowed,
    status: 'ready',
    state: allowed ? (row!.state === 'trial' ? 'trial' : 'on') : 'off',
    source: row?.source ?? null,
    expiresAt: row?.expires_at ?? null,
    daysLeft: allowed && Number.isFinite(exp) ? Math.max(0, Math.ceil((exp - nowMs) / 86_400_000)) : null,
    expired,
  };
}

/** Nav / command-palette filter. Items without `requiresModule` are never affected (zero change when unused). */
export function passesModuleGate(requiresModule: string | undefined, hasModule: ((id: string) => boolean) | undefined): boolean {
  if (!requiresModule) return true;
  return hasModule ? hasModule(requiresModule) : false; // no checker supplied -> default deny
}

// ---------------------------------------------------------------------------
// Display helpers (staff UI)
// ---------------------------------------------------------------------------

export const MODULE_LABELS: Record<FixedModuleId, string> = {
  core: 'Core', pay: 'Pay', ai: 'AI', supply: 'Supply', finance: 'Finance',
  passport: 'Passport', intelligence: 'Intelligence', connect: 'Connect',
};

export function moduleLabel(id: string): string {
  if (id.startsWith('packs:')) return `Pack · ${id.slice(6)}`;
  return MODULE_LABELS[id as FixedModuleId] ?? id;
}

export type EntitlementTone = 'success' | 'warning' | 'neutral' | 'info';

export function describeEntitlement(e: Pick<Entitlement, 'state' | 'active' | 'expires_at'>, nowMs: number): { label: string; tone: EntitlementTone } {
  const exp = e.expires_at ? Date.parse(e.expires_at) : NaN;
  if ((e.state === 'on' || e.state === 'trial') && Number.isFinite(exp) && exp <= nowMs) return { label: 'Expired', tone: 'warning' };
  if (!e.active || e.state === 'off') return { label: 'Off', tone: 'neutral' };
  return e.state === 'trial' ? { label: 'Trial', tone: 'info' } : { label: 'On', tone: 'success' };
}

export function describeAuditEntry(e: Pick<EntitlementAuditEntry, 'action' | 'before' | 'after' | 'module_id'>): string {
  const b = e.before?.state;
  const a = e.after?.state;
  const m = moduleLabel(e.module_id);
  switch (e.action) {
    case 'grant': return `${m}: granted (${a ?? 'on'})`;
    case 'revoke': return `${m}: revoked${b ? ` (was ${b})` : ''}`;
    case 'remove': return `${m}: row removed`;
    default: return `${m}: ${b ?? '—'} → ${a ?? '—'}`;
  }
}

// ---------------------------------------------------------------------------
// Staff form parsing
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export interface EntitlementFormValues {
  module_id: string;
  state: EntitlementState;
  source: EntitlementSource;
  /** value of <input type="datetime-local"> or '' */
  expires_local: string;
  reason: string;
}

export interface EntitlementPayload {
  module_id: ModuleId;
  state: EntitlementState;
  source: EntitlementSource;
  expires_at: string | null;
  reason: string;
}

export const EMPTY_ENTITLEMENT_FORM: EntitlementFormValues = { module_id: 'pay', state: 'on', source: 'manual', expires_local: '', reason: '' };

export function parseEntitlementForm(f: EntitlementFormValues, nowMs: number): ParseResult<EntitlementPayload> {
  const errors: FieldErrors = {};
  const module_id = f.module_id.trim().toLowerCase();
  if (!isValidModuleId(module_id)) errors.module_id = 'Pick a module, or use packs:<slug> (lowercase letters, digits, - and _).';
  if (!ENTITLEMENT_STATES.includes(f.state)) errors.state = 'Pick off, trial or on.';
  if (!ENTITLEMENT_SOURCES.includes(f.source)) errors.source = 'Pick a source.';

  let expires_at: string | null = null;
  if (f.state !== 'off' && f.expires_local.trim()) {
    const t = Date.parse(f.expires_local);
    if (!Number.isFinite(t)) errors.expires_local = 'Enter a valid date and time.';
    else if (t <= nowMs) errors.expires_local = 'The expiry must be in the future.';
    else expires_at = new Date(t).toISOString();
  }
  if (f.state === 'trial' && !f.expires_local.trim()) errors.expires_local = 'A trial needs an expiry date.';

  const reason = f.reason.trim();
  if (reason.length < REASON_MIN) errors.reason = `Give a reason (at least ${REASON_MIN} characters). It is saved in the audit log.`;
  else if (reason.length > REASON_MAX) errors.reason = `Reason must be ${REASON_MAX} characters or fewer.`;

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { module_id: module_id as ModuleId, state: f.state, source: f.source, expires_at, reason } };
}

// ---------------------------------------------------------------------------
// Client store (one fetch for ALL modules: no N+1)
// ---------------------------------------------------------------------------

export interface EntitlementSnapshot {
  userId: string | null;
  status: EntitlementStatus | 'idle';
  rows: ReadonlyMap<string, Entitlement>;
  /** 0 until the first successful fetch for this user. */
  fetchedAt: number;
}

const NO_ROWS: ReadonlyMap<string, Entitlement> = new Map();
const IDLE: EntitlementSnapshot = { userId: null, status: 'idle', rows: NO_ROWS, fetchedAt: 0 };

export interface EntitlementStoreOptions {
  fetchRows: () => Promise<Entitlement[]>;
  now?: () => number;
  ttlMs?: number;
}

/**
 * - one request returns every module for the tenant, shared by all components;
 * - never serves one user's rows to another (a user switch resets to empty = deny);
 * - stale-while-revalidate; a failed refetch keeps last known rows for the SAME user (expiry is still enforced
 *   on every read) but a failed first load stays denied;
 * - concurrent refreshes share one request.
 */
export function createEntitlementStore({ fetchRows, now = Date.now, ttlMs = ENTITLEMENT_CACHE_TTL_MS }: EntitlementStoreOptions) {
  let snap: EntitlementSnapshot = IDLE;
  let inflight: { userId: string; promise: Promise<void> | null } | null = null;
  const listeners = new Set<() => void>();

  const emit = (next: EntitlementSnapshot) => {
    snap = next;
    listeners.forEach((l) => l());
  };

  async function run(entry: { userId: string }): Promise<void> {
    try {
      const rows = await fetchRows();
      if (inflight !== entry) return; // superseded (user switched / signed out)
      emit({ userId: entry.userId, status: 'ready', rows: new Map(rows.map((r) => [r.module_id, r])), fetchedAt: now() });
    } catch {
      if (inflight !== entry) return;
      emit({ ...snap, userId: entry.userId, status: 'error' });
    } finally {
      if (inflight === entry) inflight = null;
    }
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snap,
    refresh(userId: string | null, force = false): Promise<void> {
      if (!userId) {
        inflight = null;
        if (snap !== IDLE) emit(IDLE);
        return Promise.resolve();
      }
      const sameUser = snap.userId === userId;
      if (!force && sameUser && snap.status === 'ready' && now() - snap.fetchedAt < ttlMs) return Promise.resolve();
      if (inflight && inflight.userId === userId) return inflight.promise ?? Promise.resolve();

      if (!sameUser) emit({ userId, status: 'loading', rows: NO_ROWS, fetchedAt: 0 });
      else if (snap.status !== 'ready') emit({ ...snap, status: 'loading' });

      const entry: { userId: string; promise: Promise<void> | null } = { userId, promise: null };
      inflight = entry;
      entry.promise = run(entry);
      return entry.promise;
    },
  };
}
