// Pure feature-flag logic: types, validation, display helpers and the
// client-side flag store. No React and no network here — the store takes a
// `fetchKeys` function, so everything is unit-tested in featureFlags.test.ts.
// Data access lives in featureFlagsApi.ts, the React hook in hooks/useFeatureFlag.ts.

export const FLAG_KEY_RE = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/;
export const FLAG_CACHE_TTL_MS = 5 * 60 * 1000;

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rollout_pct: number;
  updated_at: string;
  on_overrides: number;
  off_overrides: number;
  reach_tenants: number;
  total_tenants: number;
}

export type OverrideState = 'on' | 'off';
export type OverrideInput = OverrideState | 'inherit';

export interface FlagOverride {
  tenant_id: string;
  state: OverrideState;
  note: string | null;
  updated_at: string;
  email: string | null;
  company_name: string | null;
  full_name: string | null;
}

export interface TenantHit {
  id: string;
  email: string;
  company_name: string | null;
  full_name: string | null;
  plan: string | null;
}

export interface FlagAuditEntry {
  id: number;
  action: 'create' | 'update' | 'delete' | 'override_set' | 'override_clear';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
  tenant_email: string | null;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export type FlagTone = 'success' | 'warning' | 'neutral' | 'info';

export function describeFlag(f: Pick<FeatureFlag, 'enabled' | 'rollout_pct'>): { label: string; tone: FlagTone; detail: string } {
  if (!f.enabled) return { label: 'Off', tone: 'neutral', detail: 'Master switch is off: disabled for every tenant, overrides ignored.' };
  if (f.rollout_pct <= 0) return { label: 'Overrides only', tone: 'info', detail: 'On only for tenants with an “on” override.' };
  if (f.rollout_pct >= 100) return { label: 'Fully on', tone: 'success', detail: 'On for every tenant except those with an “off” override.' };
  return { label: `${f.rollout_pct}% rollout`, tone: 'warning', detail: `On for about ${f.rollout_pct}% of tenants, chosen by a stable hash.` };
}

/** "412 of 1,030 tenants (40%)" — the real reach, which can differ from the target % on small fleets. */
export function describeReach(f: Pick<FeatureFlag, 'reach_tenants' | 'total_tenants'>): string {
  if (f.total_tenants <= 0) return 'No tenants yet';
  const pct = Math.round((f.reach_tenants / f.total_tenants) * 100);
  return `${f.reach_tenants.toLocaleString()} of ${f.total_tenants.toLocaleString()} tenants (${pct}%)`;
}

export function tenantLabel(t: { email: string | null; company_name: string | null; full_name: string | null }): string {
  return t.company_name?.trim() || t.full_name?.trim() || t.email || 'Unknown tenant';
}

/** Suggests a valid key from a human name: "New Dashboard!" -> "new_dashboard". */
export function suggestFlagKey(name: string): string {
  let k = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (k && !/^[a-z]/.test(k)) k = `f_${k}`;
  return k.slice(0, 64).replace(/_+$/g, '');
}

/** One-line, human description of an audit row for the History list. */
export function describeAuditEntry(e: Pick<FlagAuditEntry, 'action' | 'before' | 'after' | 'tenant_email'>): string {
  const b = e.before ?? {};
  const a = e.after ?? {};
  const onOff = (v: unknown) => (v ? 'on' : 'off');
  const tenant = e.tenant_email ?? 'a tenant';
  switch (e.action) {
    case 'create':
      return `Created (master switch ${onOff(a.enabled)}, ${a.rollout_pct ?? 0}% rollout)`;
    case 'delete':
      return 'Deleted';
    case 'override_set':
      return `Override for ${tenant}: ${b.state ? `${b.state} → ` : ''}${a.state}`;
    case 'override_clear':
      return `Override removed for ${tenant}${b.state ? ` (was ${b.state})` : ''}`;
    default: {
      const parts: string[] = [];
      if (b.enabled !== a.enabled) parts.push(`master switch ${onOff(b.enabled)} → ${onOff(a.enabled)}`);
      if (b.rollout_pct !== a.rollout_pct) parts.push(`rollout ${b.rollout_pct}% → ${a.rollout_pct}%`);
      if (b.name !== a.name) parts.push('renamed');
      if (b.description !== a.description) parts.push('description edited');
      return parts.length ? parts[0].charAt(0).toUpperCase() + parts.join(', ').slice(1) : 'Updated';
    }
  }
}

// ---------------------------------------------------------------------------
// Form parsing
// ---------------------------------------------------------------------------

export type FieldErrors = Record<string, string>;
export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export interface FlagFormValues { key: string; name: string; description: string; enabled: boolean; rollout_pct: string }
export interface FlagPayload { key: string; name: string; description: string | null; enabled: boolean; rollout_pct: number }

export const EMPTY_FLAG_FORM: FlagFormValues = { key: '', name: '', description: '', enabled: false, rollout_pct: '0' };

export function flagToForm(f: FeatureFlag): FlagFormValues {
  return { key: f.key, name: f.name, description: f.description ?? '', enabled: f.enabled, rollout_pct: String(f.rollout_pct) };
}

export function parseFlagForm(f: FlagFormValues): ParseResult<FlagPayload> {
  const errors: FieldErrors = {};
  const name = f.name.trim();
  if (!name) errors.name = 'Give the flag a name.';
  else if (name.length > 80) errors.name = 'Name must be 80 characters or fewer.';

  const key = f.key.trim();
  if (!key) errors.key = 'A key is required.';
  else if (!FLAG_KEY_RE.test(key)) errors.key = 'Use 3–64 characters: lowercase letters, digits and underscores, starting with a letter.';

  if (f.description.length > 500) errors.description = 'Description must be 500 characters or fewer.';

  const raw = f.rollout_pct.trim();
  const pct = Number(raw);
  if (raw === '' || !Number.isInteger(pct) || pct < 0 || pct > 100) errors.rollout_pct = 'Rollout must be a whole number from 0 to 100.';

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { key, name, description: f.description.trim() || null, enabled: f.enabled, rollout_pct: pct } };
}

export function parseOverrideNote(note: string): ParseResult<string | null> {
  if (note.length > 300) return { ok: false, errors: { note: 'Note must be 300 characters or fewer.' } };
  return { ok: true, value: note.trim() || null };
}

// ---------------------------------------------------------------------------
// Client flag store
// ---------------------------------------------------------------------------

export type FlagStoreStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface FlagSnapshot {
  userId: string | null;
  status: FlagStoreStatus;
  keys: ReadonlySet<string>;
  /** 0 until the first successful fetch for this user. */
  fetchedAt: number;
}

const NO_KEYS: ReadonlySet<string> = new Set();
const IDLE: FlagSnapshot = { userId: null, status: 'idle', keys: NO_KEYS, fetchedAt: 0 };

export interface FlagStoreOptions {
  fetchKeys: () => Promise<string[]>;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Holds the enabled flag keys for the signed-in tenant.
 * - never serves one user's flags to another (a user switch resets to empty);
 * - stale-while-revalidate: cached keys keep working during a refetch;
 * - a failed refetch keeps the last known keys for the same user (flags don't
 *   flip mid-session on a network blip) but never invents keys for a new user;
 * - concurrent refreshes for one user share a single request.
 */
export function createFlagStore({ fetchKeys, now = Date.now, ttlMs = FLAG_CACHE_TTL_MS }: FlagStoreOptions) {
  let snap: FlagSnapshot = IDLE;
  let inflight: { userId: string; promise: Promise<void> | null } | null = null;
  const listeners = new Set<() => void>();

  const emit = (next: FlagSnapshot) => {
    snap = next;
    listeners.forEach((l) => l());
  };

  async function run(entry: { userId: string }): Promise<void> {
    try {
      const keys = await fetchKeys();
      if (inflight !== entry) return; // superseded (user switched / signed out)
      emit({ userId: entry.userId, status: 'ready', keys: new Set(keys), fetchedAt: now() });
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

      if (!sameUser) emit({ userId, status: 'loading', keys: NO_KEYS, fetchedAt: 0 });
      else if (snap.status !== 'ready') emit({ ...snap, status: 'loading' });

      const entry: { userId: string; promise: Promise<void> | null } = { userId, promise: null };
      inflight = entry;
      entry.promise = run(entry);
      return entry.promise;
    },
  };
}
