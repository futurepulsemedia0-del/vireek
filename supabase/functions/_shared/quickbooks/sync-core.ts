// supabase/functions/_shared/quickbooks/sync-core.ts
//
// Pure, dependency-injected pieces of the QuickBooks sync runner, extracted from
// qbo-sync-run/index.ts WITHOUT changing behaviour so they can be unit tested:
//   - conflictSig / addRetry / isPaymentsBlock
//   - qboRequest          : one QuickBooks HTTP call (401 -> refresh once, 429 -> RateLimitError, 5xx / network retry)
//   - writeWithStaleRetry : create / sparse update with ONE refetch-and-retry on a stale SyncToken (fault 5010)
// No Deno, DOM, database or global fetch is touched here: everything arrives through `deps`.

import {
  classifyResponse,
  isAllowedApiBase,
  parseEntityResponse,
  recordMeta,
  type Canon,
  type QboEntity,
  type RawRecord,
} from './engine.ts';

export class AuthError extends Error {}
export class RateLimitError extends Error {}

export interface ApiResult {
  status: number;
  json: unknown;
  tid: string | null;
}

/** Human-readable fault text (<= 300 chars). */
export const faultText = (r: ApiResult): string => {
  const f = classifyResponse(r.status, r.json).fault;
  return f ? `${f.message}${f.detail ? `: ${f.detail}` : ''}`.slice(0, 300) : `HTTP ${r.status}`;
};

/** Stable signature of "which fields conflict and what each side holds". Same signature = same conflict, not logged twice. */
export function conflictSig(fields: string[], v: Canon, q: Canon): string {
  return JSON.stringify([fields, fields.map((f) => [v[f] ?? null, q[f] ?? null])]);
}

/** Retry list: de-duplicated, newest kept when the cap is exceeded. */
export function addRetry(list: string[] | undefined, id: string, cap = 200): string[] {
  const set = new Set(list ?? []);
  set.add(id);
  return [...set].slice(-cap);
}

/** The SQL RPCs raise PAYMENTS_EXIST when an invoice with payments would be re-itemised or voided. */
export const isPaymentsBlock = (msg: string): boolean => /PAYMENTS_EXIST/.test(msg);

export interface HttpDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Always read the CURRENT access token (it changes after a refresh). */
  getAccess: () => string;
  /** Refresh the access token (and persist it). */
  refresh: () => Promise<void>;
  base: string;
}

export async function qboRequest(deps: HttpDeps, req: { method: string; url: string; body?: unknown }): Promise<ApiResult> {
  if (!req.url.startsWith(`${deps.base}/`) || !isAllowedApiBase(deps.base)) {
    throw new Error('Refusing to call an address outside QuickBooks.');
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(req.url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${deps.getAccess()}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
    } catch (err) {
      if (attempt < 2) {
        await deps.sleep(800);
        continue;
      }
      throw err;
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await deps.refresh();
      continue;
    }
    if (res.status === 401) throw new AuthError('QuickBooks rejected our credentials.');
    if (res.status === 429) throw new RateLimitError('QuickBooks is rate limiting requests.');
    if (res.status >= 500 && attempt < 2) {
      await deps.sleep(1000);
      continue;
    }
    const text = res.status === 204 ? '' : await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: res.status, json: body, tid: res.headers.get('intuit_tid') };
  }
  throw new Error('QuickBooks request failed.');
}

export interface WriteDeps {
  /** POST the payload (the caller builds the URL / requestid). */
  send: (payload: RawRecord) => Promise<ApiResult>;
  /** GET the current record (null when it no longer exists). */
  fetchFresh: (id: string) => Promise<RawRecord | null>;
}
export type WriteResult =
  | { ok: true; record: RawRecord; tid: string | null }
  | { ok: false; kind: string; message: string; tid: string | null };

/** Write with one automatic retry on a stale SyncToken (refetch, re-apply). Creates (no Id) are never retried this way. */
export async function writeWithStaleRetry(deps: WriteDeps, entity: QboEntity, payload: RawRecord): Promise<WriteResult> {
  let body = payload;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await deps.send(body);
    const c = classifyResponse(r.status, r.json);
    if (c.kind === 'ok') {
      const rec = parseEntityResponse(entity, r.json);
      if (rec) return { ok: true, record: rec, tid: r.tid };
      return { ok: false, kind: 'error', message: 'QuickBooks returned no record.', tid: r.tid };
    }
    if (c.kind === 'stale' && attempt === 0 && typeof body.Id === 'string') {
      const fresh = await deps.fetchFresh(body.Id);
      if (fresh) {
        body = { ...body, SyncToken: recordMeta(fresh).syncToken };
        continue;
      }
    }
    return { ok: false, kind: c.kind, message: faultText(r), tid: r.tid };
  }
  return { ok: false, kind: 'stale', message: 'The record kept changing in QuickBooks.', tid: null };
}
