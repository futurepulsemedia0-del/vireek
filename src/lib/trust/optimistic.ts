/**
 * Shared optimistic-mutation runner (pure; React wiring lives in
 * `hooks/useOptimisticMutation.ts`).
 *
 *  apply() runs immediately → run() hits the server → on failure rollback()
 *  restores the pre-change snapshot and the error is classified for the UI.
 *
 * Concurrency: mutations sharing a `key` (e.g. the same job id) run on the
 * server strictly in order. `onSettled` fires once, when the LAST pending
 * mutation for that key finishes, so the caller can refetch and heal any
 * interleaved rollback — the same contract as React Query's `invalidate`.
 */
import { toAppError, type AppError } from './appError';

/** `cause` is the raw thrown value, for logging only — never render it. */
export type MutationResult<T> = { ok: true; data: T } | { ok: false; error: AppError; cause: unknown };

export interface OptimisticSpec<V, T, S> {
  /** Serialises mutations touching the same record, e.g. `job:<id>`. */
  key: string;
  vars: V;
  /** Apply the optimistic change to local state; return what rollback needs. */
  apply: (vars: V) => S;
  /** The real write. Throw (or reject) on failure. Must be idempotent if `retries > 0`. */
  run: (vars: V) => Promise<T>;
  rollback: (snapshot: S, vars: V, error: AppError) => void;
  onSuccess?: (data: T, vars: V) => void;
  /** Called when no more mutations are pending for `key` (success OR failure). */
  onSettled?: (key: string) => void;
  /** Extra attempts for transient errors (network / server / rate limit). Default 0. */
  retries?: number;
}

export interface MutationRunnerDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Backoff base in ms (doubles each attempt). */
  backoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createMutationRunner(deps: MutationRunnerDeps = {}) {
  const sleep = deps.sleep ?? defaultSleep;
  const base = deps.backoffMs ?? 400;
  const tails = new Map<string, Promise<unknown>>();
  const pending = new Map<string, number>();

  async function attempt<T>(run: () => Promise<T>, retries: number): Promise<MutationResult<T>> {
    let last: AppError | null = null;
    let cause: unknown = null;
    for (let i = 0; i <= retries; i += 1) {
      try {
        return { ok: true, data: await run() };
      } catch (e) {
        cause = e;
        last = toAppError(e);
        if (!last.retryable || i === retries) break;
        await sleep(last.retryAfterMs ?? base * 2 ** i);
      }
    }
    return { ok: false, error: last as AppError, cause };
  }

  function mutate<V, T, S>(spec: OptimisticSpec<V, T, S>): Promise<MutationResult<T>> {
    const snapshot = spec.apply(spec.vars);
    pending.set(spec.key, (pending.get(spec.key) ?? 0) + 1);

    const previous = tails.get(spec.key) ?? Promise.resolve();
    const job = previous.then(async (): Promise<MutationResult<T>> => {
      const result = await attempt(() => spec.run(spec.vars), spec.retries ?? 0);
      try {
        if (result.ok) spec.onSuccess?.(result.data, spec.vars);
        else spec.rollback(snapshot, spec.vars, result.error);
      } finally {
        const left = (pending.get(spec.key) ?? 1) - 1;
        if (left <= 0) {
          pending.delete(spec.key);
          tails.delete(spec.key);
          spec.onSettled?.(spec.key);
        } else pending.set(spec.key, left);
      }
      return result;
    });
    // Keep the chain alive even if a callback throws.
    tails.set(spec.key, job.catch(() => undefined));
    return job;
  }

  return { mutate, pendingCount: (key: string) => pending.get(key) ?? 0 };
}

/** One runner per app is enough; exported so hooks and non-React code share the same queues. */
export const mutationRunner = createMutationRunner();
