// Versioned prompts/routes with shadow mode, layered ON TOP of ai-core's routeChat (which stays untouched
// except for one optional route-override parameter).
//  - Production uses the ACTIVE version; any failure of a versioned attempt falls back to the code defaults.
//  - Shadow candidates run on a sample of traffic AFTER the production answer exists; their output is never
//    returned, never stored (only success, latency and a similarity score are recorded).
//  - The 'ai_model_prompt_versions' kill switch makes the resolver return nothing => code defaults.

import type { NormalizedChatRequest, NormalizedChatResponse, RouteEntry, TaskType } from '../ai-core/types.ts';

export type RunFn = (
  task: TaskType,
  req: NormalizedChatRequest,
  allowedProviders?: readonly string[],
  route?: readonly RouteEntry[],
) => Promise<{ response: NormalizedChatResponse }>;

export type VersionKind = 'prompt' | 'route';
export interface VersionRef { version: number; payload: unknown }
export interface Resolved { stopped: boolean; active: VersionRef | null; shadow: (VersionRef & { samplePct: number }) | null }
export const NO_VERSIONS: Resolved = { stopped: false, active: null, shadow: null };

export interface ShadowRecord {
  kind: VersionKind; task: string; candidateVersion: number;
  baselineOk: boolean; candidateOk: boolean; baselineLatencyMs: number; candidateLatencyMs: number; similarity: number | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asRef = (v: unknown): VersionRef | null =>
  isObj(v) && Number.isInteger(v.version) && (v.version as number) > 0 && 'payload' in v ? { version: v.version as number, payload: v.payload } : null;

export function parseResolved(raw: unknown): Resolved {
  if (!isObj(raw)) return NO_VERSIONS;
  if (raw.stopped === true) return { stopped: true, active: null, shadow: null };
  const active = asRef(raw.active);
  const s = asRef(raw.shadow);
  const pct = isObj(raw.shadow) && typeof raw.shadow.sample_pct === 'number' ? raw.shadow.sample_pct : 0;
  return { stopped: false, active, shadow: s && pct > 0 ? { ...s, samplePct: Math.min(25, pct) } : null };
}

export function parseSuffix(payload: unknown): string | null {
  if (!isObj(payload) || typeof payload.system_suffix !== 'string') return null;
  const s = payload.system_suffix.trim();
  return s.length > 0 && s.length <= 4000 ? s : null;
}

export function parseRoute(payload: unknown): RouteEntry[] | null {
  if (!isObj(payload) || !Array.isArray(payload.route) || payload.route.length < 1 || payload.route.length > 6) return null;
  const out: RouteEntry[] = [];
  for (const [i, e] of payload.route.entries()) {
    if (!isObj(e) || typeof e.provider !== 'string' || typeof e.model !== 'string' || !e.provider || !e.model) return null;
    out.push({ provider: e.provider as RouteEntry['provider'], model: e.model, priority: (i + 1) * 10 });
  }
  return out;
}

export function withSuffix(req: NormalizedChatRequest, suffix: string): NormalizedChatRequest {
  return { ...req, system: req.system ? `${req.system}\n\n${suffix}` : suffix };
}

/** Word-set Jaccard similarity in [0,1]. Cheap, order-insensitive; compares outputs without storing them. */
export function textSimilarity(a: string, b: string): number {
  const tok = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const x = tok(a);
  const y = tok(b);
  if (x.size === 0 && y.size === 0) return 1;
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return inter / (x.size + y.size - inter);
}

export interface VersionResolverOptions {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  now?: () => number;
  ttlMs?: number;      // default 15 s
  maxStaleMs?: number; // default 5 min; beyond that => code defaults
}

export function createVersionResolver({ rpc, now = Date.now, ttlMs = 15_000, maxStaleMs = 5 * 60_000 }: VersionResolverOptions) {
  const cache = new Map<string, { value: Resolved; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  return async function resolve(kind: VersionKind, task: string): Promise<Resolved> {
    const id = `${kind}:${task}`;
    const hit = cache.get(id);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    let p = inflight.get(id);
    if (!p) {
      p = (async () => {
        try {
          const { data, error } = await rpc('ai_resolve_versions', { p_kind: kind, p_task_key: task });
          if (!error) cache.set(id, { value: parseResolved(data), at: now() });
        } catch { /* keep stale */ }
      })().finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    await p;
    const fresh = cache.get(id);
    return fresh && now() - fresh.at <= maxStaleMs ? fresh.value : NO_VERSIONS;
  };
}

export interface VersionedRouterDeps {
  run: RunFn;
  resolve: (kind: VersionKind, task: string) => Promise<Resolved>;
  recordShadow: (r: ShadowRecord) => Promise<void>;
  rand?: () => number;
  now?: () => number;
  /** Keep the shadow work alive after the response (EdgeRuntime.waitUntil). Default: detach safely. */
  waitUntil?: (p: Promise<unknown>) => void;
  shadowTimeoutMs?: number; // default 15 s
  maxShadowInflight?: number; // default 3 per isolate
}

export function createVersionedRouter(deps: VersionedRouterDeps) {
  const rand = deps.rand ?? Math.random;
  const now = deps.now ?? Date.now;
  const waitUntil = deps.waitUntil ?? ((p) => { void p.catch(() => undefined); });
  const timeoutMs = deps.shadowTimeoutMs ?? 15_000;
  const maxInflight = deps.maxShadowInflight ?? 3;
  let inflight = 0;

  async function shadow(
    kind: VersionKind, task: string, version: number, baselineText: string, baselineLatencyMs: number,
    candidate: () => Promise<{ response: NormalizedChatResponse }>,
  ): Promise<void> {
    inflight += 1;
    const t0 = now();
    let candidateOk = false;
    let similarity: number | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        candidate(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('shadow timeout')), timeoutMs); }),
      ]);
      candidateOk = true;
      similarity = textSimilarity(baselineText, res.response.text);
    } catch { /* candidate failure is data, not an error */ } finally {
      if (timer) clearTimeout(timer);
      inflight -= 1;
    }
    try {
      await deps.recordShadow({ kind, task, candidateVersion: version, baselineOk: true, candidateOk, baselineLatencyMs, candidateLatencyMs: now() - t0, similarity });
    } catch { /* recording is best-effort */ }
  }

  return async function route(task: TaskType, req: NormalizedChatRequest, allowedProviders?: readonly string[]) {
    const [pr, rt] = await Promise.all([deps.resolve('prompt', task), deps.resolve('route', task)]);
    const suffix = pr.active ? parseSuffix(pr.active.payload) : null;
    const prodRoute = rt.active ? parseRoute(rt.active.payload) : null;
    const prodReq = suffix ? withSuffix(req, suffix) : req;
    const versioned = Boolean(suffix || prodRoute);

    const t0 = now();
    let result: { response: NormalizedChatResponse };
    try {
      result = await deps.run(task, prodReq, allowedProviders, prodRoute ?? undefined);
    } catch (err) {
      if (!versioned) throw err;
      result = await deps.run(task, req, allowedProviders, undefined); // pinned baseline
      return result; // a versioned attempt just failed: no shadow sample from this request
    }
    const latency = now() - t0;

    const jobs: Array<Promise<void>> = [];
    const start = (kind: VersionKind, version: number, samplePct: number, cand: () => Promise<{ response: NormalizedChatResponse }>) => {
      if (inflight + jobs.length >= maxInflight || rand() * 100 >= samplePct) return;
      jobs.push(shadow(kind, task, version, result.response.text, latency, cand));
    };
    const ps = pr.shadow ? parseSuffix(pr.shadow.payload) : null;
    if (pr.shadow && ps) start('prompt', pr.shadow.version, pr.shadow.samplePct, () => deps.run(task, withSuffix(req, ps), allowedProviders, prodRoute ?? undefined));
    const sr = rt.shadow ? parseRoute(rt.shadow.payload) : null;
    if (rt.shadow && sr) start('route', rt.shadow.version, rt.shadow.samplePct, () => deps.run(task, prodReq, allowedProviders, sr));
    for (const j of jobs) waitUntil(j);
    return result;
  };
}
