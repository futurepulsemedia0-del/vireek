// supabase/functions/_shared/connector-kernel/kernel.ts
//
// Shared connector kernel: the reliability primitives every accounting / calendar / price-book
// connector needs, in ONE tested place. Pure (no Deno, no network): every side effect is an injected
// dependency, so it runs identically in Deno, Node and vitest against a fake provider.
//
//   callWithRetry     429/5xx/network retries, Retry-After honoured, full jitter, hard caps
//   TokenManager      single-flight refresh (in-process + cross-instance lock), 401-triggered refresh
//   CircuitBreaker    closed -> open -> half-open per connection
//   runIncrementalSync cursor + per-page checkpoint, idempotent upsert by external id,
//                      out-of-order protection, tombstones for upstream deletes, conflict policy
//   reconcile         drift detection between Vireek and the external system
//   deriveHealth      healthy | degraded | failing | stale  (drives the UI badge)

export interface Deps {
  now(): number;               // epoch ms
  sleep(ms: number): Promise<void>;
  random(): number;            // [0,1)
}
export const realDeps: Deps = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };

// ------------------------------------------------------------------ retry
export interface HttpLike { status: number; headers: { get(n: string): string | null } }
export interface RetryPolicy { maxAttempts: number; baseMs: number; capMs: number; maxRetryAfterMs: number }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseMs: 500, capMs: 30_000, maxRetryAfterMs: 120_000 };

export function retryAfterMs(h: string | null, nowMs: number, capMs: number): number | null {
  if (!h) return null;
  const n = Number(h);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(h) - nowMs;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, capMs) : null;
}

export class RetryExhausted<R extends HttpLike> extends Error {
  last: R | null;
  cause?: unknown;
  constructor(last: R | null, cause?: unknown) { super("retry_exhausted"); this.last = last; this.cause = cause; }
}

export async function callWithRetry<R extends HttpLike>(
  send: () => Promise<R>, deps: Deps, policy: RetryPolicy = DEFAULT_RETRY, onRetry?: (a: { attempt: number; waitMs: number; status?: number }) => void,
): Promise<R> {
  let last: R | null = null;
  let cause: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      last = await send();
      cause = undefined;
      const retryable = last.status === 429 || last.status >= 500;
      if (!retryable) return last;
    } catch (e) { cause = e; last = null; }
    if (attempt === policy.maxAttempts) break;
    const ra = last ? retryAfterMs(last.headers.get("retry-after"), deps.now(), policy.maxRetryAfterMs) : null;
    const exp = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
    const waitMs = ra ?? Math.floor(exp / 2 + deps.random() * (exp / 2));
    onRetry?.({ attempt, waitMs, status: last?.status });
    await deps.sleep(waitMs);
  }
  throw new RetryExhausted(last, cause);
}

// ------------------------------------------------------------------ tokens
export interface Token { accessToken: string; refreshToken: string; expiresAt: number }
export interface TokenStore {
  load(conn: string): Promise<Token>;
  save(conn: string, t: Token): Promise<void>;
  /** Cross-instance lock (DB). Returns true when acquired. Lease expires on its own. */
  tryLock(conn: string, leaseMs: number): Promise<boolean>;
  unlock(conn: string): Promise<void>;
}
export class AuthRevoked extends Error { constructor() { super("auth_revoked"); } }

export class TokenManager {
  private inflight = new Map<string, Promise<Token>>();
  private store: TokenStore;
  private deps: Deps;
  private refresh: (refreshToken: string) => Promise<Token>; // throws AuthRevoked on invalid_grant
  private skewMs: number;
  private leaseMs: number;
  constructor(store: TokenStore, deps: Deps, refresh: (refreshToken: string) => Promise<Token>, skewMs = 60_000, leaseMs = 30_000) {
    this.store = store; this.deps = deps; this.refresh = refresh; this.skewMs = skewMs; this.leaseMs = leaseMs;
  }

  async get(conn: string, forceRefreshOf?: string): Promise<Token> {
    const t = await this.store.load(conn);
    const stale = forceRefreshOf ? t.accessToken === forceRefreshOf : t.expiresAt - this.skewMs <= this.deps.now();
    if (!stale) return t;
    const existing = this.inflight.get(conn);
    if (existing) return existing;
    const p = this.refreshOnce(conn, forceRefreshOf).finally(() => this.inflight.delete(conn));
    this.inflight.set(conn, p);
    return p;
  }

  private async refreshOnce(conn: string, rejected?: string): Promise<Token> {
    for (let i = 0; i < 20; i++) {
      if (await this.store.tryLock(conn, this.leaseMs)) {
        try {
          // Another instance may have refreshed while we waited: re-read before spending the refresh token
          // (providers that rotate refresh tokens would otherwise invalidate the winner's token).
          const cur = await this.store.load(conn);
          const fresh = rejected ? cur.accessToken !== rejected : cur.expiresAt - this.skewMs > this.deps.now();
          if (fresh) return cur;
          const next = await this.refresh(cur.refreshToken);
          await this.store.save(conn, next);
          return next;
        } finally { await this.store.unlock(conn); }
      }
      await this.deps.sleep(250 + Math.floor(this.deps.random() * 250));
      const cur = await this.store.load(conn);
      if (rejected ? cur.accessToken !== rejected : cur.expiresAt - this.skewMs > this.deps.now()) return cur;
    }
    throw new Error("token_refresh_timeout");
  }
}

// ------------------------------------------------------------------ circuit breaker
export type BreakerState = "closed" | "open" | "half_open";
export class CircuitBreaker {
  private failures = 0; private openedAt = 0; private state: BreakerState = "closed"; private probing = false;
  private deps: Deps; private threshold: number; private cooldownMs: number;
  constructor(deps: Deps, threshold = 5, cooldownMs = 60_000) { this.deps = deps; this.threshold = threshold; this.cooldownMs = cooldownMs; }
  status(): BreakerState {
    if (this.state === "open" && this.deps.now() - this.openedAt >= this.cooldownMs) this.state = "half_open";
    return this.state;
  }
  canCall(): boolean {
    const s = this.status();
    if (s === "closed") return true;
    if (s === "half_open" && !this.probing) { this.probing = true; return true; } // exactly one probe
    return false;
  }
  success() { this.failures = 0; this.state = "closed"; this.probing = false; }
  failure() {
    this.probing = false;
    this.failures++;
    if (this.state === "half_open" || this.failures >= this.threshold) { this.state = "open"; this.openedAt = this.deps.now(); }
  }
}

// ------------------------------------------------------------------ incremental sync
export type ConflictPolicy = "external_wins" | "vireek_wins" | "newest_wins";
export interface ExternalRecord { externalId: string; updatedAt: number; deleted?: boolean; data: Record<string, unknown> }
export interface LocalRecord { externalId: string; updatedAt: number; localEditedAt: number | null; deleted: boolean; hash: string }
export interface Page { items: ExternalRecord[]; nextCursor: string | null }

export interface SyncSink {
  get(externalId: string): Promise<LocalRecord | null>;
  /** MUST be idempotent: upsert keyed by (tenant, connector, external_id). */
  upsert(r: ExternalRecord): Promise<void>;
  tombstone(externalId: string, at: number): Promise<void>;
}
export interface CheckpointStore { load(): Promise<string | null>; save(cursor: string | null): Promise<void> }

export interface SyncStats { pages: number; upserted: number; tombstoned: number; skippedStale: number; skippedConflict: number; duplicates: number; failedPage: string | null }

export function resolveConflict(policy: ConflictPolicy, local: LocalRecord, incoming: ExternalRecord): "apply" | "skip" {
  if (local.localEditedAt === null || local.localEditedAt <= local.updatedAt) return "apply"; // no unsynced local edit
  if (policy === "external_wins") return "apply";
  if (policy === "vireek_wins") return "skip";
  return incoming.updatedAt >= local.localEditedAt ? "apply" : "skip";
}

export async function runIncrementalSync(o: {
  fetchPage(cursor: string | null): Promise<Page>;
  sink: SyncSink; checkpoint: CheckpointStore; policy: ConflictPolicy;
  maxPages?: number; breaker?: CircuitBreaker;
}): Promise<SyncStats> {
  const stats: SyncStats = { pages: 0, upserted: 0, tombstoned: 0, skippedStale: 0, skippedConflict: 0, duplicates: 0, failedPage: null };
  let cursor = await o.checkpoint.load();
  const maxPages = o.maxPages ?? 1000;
  const seenCursors = new Set<string>();
  while (stats.pages < maxPages) {
    if (o.breaker && !o.breaker.canCall()) { stats.failedPage = cursor ?? "start"; throw Object.assign(new Error("circuit_open"), { stats }); }
    let page: Page;
    try { page = await o.fetchPage(cursor); o.breaker?.success(); }
    catch (e) { o.breaker?.failure(); stats.failedPage = cursor ?? "start"; throw Object.assign(e instanceof Error ? e : new Error(String(e)), { stats }); }

    const inPage = new Map<string, ExternalRecord>();
    for (const r of page.items) {
      const prev = inPage.get(r.externalId);
      if (prev) stats.duplicates++;
      if (!prev || r.updatedAt >= prev.updatedAt) inPage.set(r.externalId, r); // reordered duplicates: newest wins
    }
    for (const r of inPage.values()) {
      const local = await o.sink.get(r.externalId);
      if (local && r.updatedAt < local.updatedAt) { stats.skippedStale++; continue; }        // out-of-order / replayed older event
      if (local && r.updatedAt === local.updatedAt && !!r.deleted === local.deleted) { stats.duplicates++; continue; } // already applied
      if (local && resolveConflict(o.policy, local, r) === "skip") { stats.skippedConflict++; continue; }
      if (r.deleted) { await o.sink.tombstone(r.externalId, r.updatedAt); stats.tombstoned++; }
      else { await o.sink.upsert(r); stats.upserted++; }
    }
    stats.pages++;
    // Checkpoint only AFTER the whole page is applied: a crash re-reads the page, and idempotency makes that safe.
    await o.checkpoint.save(page.nextCursor);
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw Object.assign(new Error("cursor_loop"), { stats });
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return stats;
}

// ------------------------------------------------------------------ reconciliation
export interface DriftReport {
  missingLocal: string[]; missingExternal: string[]; mismatched: string[]; checked: number; driftRate: number;
}
export function reconcile(external: ReadonlyMap<string, string>, local: ReadonlyMap<string, string>): DriftReport {
  const missingLocal: string[] = [], missingExternal: string[] = [], mismatched: string[] = [];
  for (const [id, h] of external) {
    const l = local.get(id);
    if (l === undefined) missingLocal.push(id); else if (l !== h) mismatched.push(id);
  }
  for (const id of local.keys()) if (!external.has(id)) missingExternal.push(id);
  const checked = new Set([...external.keys(), ...local.keys()]).size;
  const bad = missingLocal.length + missingExternal.length + mismatched.length;
  return { missingLocal, missingExternal, mismatched, checked, driftRate: checked === 0 ? 0 : bad / checked };
}

// ------------------------------------------------------------------ health
export type Health = "healthy" | "degraded" | "failing" | "stale" | "never_synced";
export function deriveHealth(o: {
  now: number; lastSuccessAt: number | null; consecutiveFailures: number; breaker: BreakerState; driftRate: number; expectedEveryMs: number;
}): Health {
  if (o.lastSuccessAt === null) return o.consecutiveFailures > 0 ? "failing" : "never_synced";
  if (o.breaker === "open" || o.consecutiveFailures >= 5) return "failing";
  if (o.now - o.lastSuccessAt > o.expectedEveryMs * 3) return "stale";
  if (o.consecutiveFailures > 0 || o.driftRate > 0.01) return "degraded";
  return "healthy";
}
