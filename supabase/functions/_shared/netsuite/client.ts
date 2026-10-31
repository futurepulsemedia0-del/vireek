// supabase/functions/_shared/netsuite/client.ts
//
// Thin, dependency-free NetSuite REST client: request signing, retries, rate-limit handling and the
// handful of calls the sync needs (SuiteQL, GET record, upsert by externalId, PATCH). `fetch`, sleep and
// the clock are injectable so the whole client is unit-tested against an in-memory fake NetSuite.
//
// NOT LIVE-VERIFIED against a real NetSuite account (see engine.ts NS_VERIFICATION).
//
// Safety:
//   - A request is only ever signed and sent to https://<account>.suitetalk.api.netsuite.com.
//   - Credentials live in the client instance only; they are never logged and never part of an error message.
//   - 401 -> NsAuthError (token revoked / wrong key), 429 -> retried, then NsRateLimitError.

import {
  apiBaseFor,
  buildGetRequest,
  buildPatchRequest,
  buildSuiteQlRequest,
  buildUpsertRequest,
  classifyResponse,
  idFromLocation,
  isAllowedApiBase,
  parseSuiteQlResponse,
  signRequest,
  type FaultKind,
  type HttpReq,
  type NsCredentials,
  type NsEntity,
  type NsFault,
  type RawRecord,
} from './engine.ts';

export class NsAuthError extends Error {}
export class NsRateLimitError extends Error {}

export interface NsApiResult {
  status: number;
  json: unknown;
  location: string | null;
}

export interface NsClientOptions {
  credentials: NsCredentials;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts per request (network errors, 5xx and 429 are retried). */
  maxAttempts?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NsClient {
  readonly base: string;
  private readonly creds: NsCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;

  constructor(opts: NsClientOptions) {
    this.creds = opts.credentials;
    this.base = apiBaseFor(opts.credentials.accountId);
    if (!isAllowedApiBase(this.base)) throw new Error('Refusing to use an address outside NetSuite.');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async request(req: HttpReq): Promise<NsApiResult> {
    if (!req.url.startsWith(`${this.base}/`)) throw new Error('Refusing to call an address outside NetSuite.');
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const last = attempt === this.maxAttempts;
      let res: Response;
      try {
        // A fresh nonce and timestamp for every attempt: NetSuite rejects a replayed nonce.
        const authorization = await signRequest(req.method, req.url, this.creds);
        res = await this.fetchImpl(req.url, {
          method: req.method,
          headers: {
            Authorization: authorization,
            Accept: 'application/json',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(req.headers ?? {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (last) throw new Error(`NetSuite request failed: ${err instanceof Error ? err.name : 'network error'}`);
        await this.sleep(500 * attempt);
        continue;
      }
      if (res.status === 401) throw new NsAuthError('NetSuite rejected the credentials.');
      if (res.status === 429) {
        if (last) throw new NsRateLimitError('NetSuite is rate limiting requests.');
        const retryAfter = Number(res.headers.get('Retry-After'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000 * attempt);
        continue;
      }
      if (res.status >= 500 && !last) {
        await this.sleep(800 * attempt);
        continue;
      }
      const text = res.status === 204 ? '' : await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
      }
      return { status: res.status, json, location: res.headers.get('Location') };
    }
    throw new Error('NetSuite request failed.');
  }

  /** SuiteQL page. Throws on any non-2xx so a half-read list can never be mistaken for a complete one. */
  async suiteql(q: string, limit: number, offset: number): Promise<{ rows: RawRecord[]; hasMore: boolean }> {
    const r = await this.request(buildSuiteQlRequest({ base: this.base, q, limit, offset }));
    const c = classifyResponse(r.status, r.json);
    if (c.kind !== 'ok') throw new NsFaultError(c.kind, faultText(r.status, c.fault));
    return parseSuiteQlResponse(r.json);
  }

  /** Full record, or null when it does not exist (deleted in NetSuite). */
  async getRecord(entity: NsEntity, id: string): Promise<RawRecord | null> {
    const r = await this.request(buildGetRequest({ base: this.base, entity, id }));
    const c = classifyResponse(r.status, r.json);
    if (c.kind === 'notfound') return null;
    if (c.kind !== 'ok') throw new NsFaultError(c.kind, faultText(r.status, c.fault));
    return r.json && typeof r.json === 'object' ? (r.json as RawRecord) : null;
  }

  /** Create-or-update by externalId (idempotent), then read the record back (NetSuite answers 204 + Location). */
  async upsert(entity: NsEntity, externalId: string, payload: RawRecord): Promise<WriteOutcome> {
    const r = await this.request(buildUpsertRequest({ base: this.base, entity, externalId, payload }));
    return this.afterWrite(entity, r, externalId);
  }

  async patch(entity: NsEntity, id: string, payload: RawRecord, replace?: string | null): Promise<WriteOutcome> {
    const r = await this.request(buildPatchRequest({ base: this.base, entity, id, payload, replace }));
    return this.afterWrite(entity, r, null, id);
  }

  private async afterWrite(entity: NsEntity, r: NsApiResult, externalId: string | null, knownId?: string): Promise<WriteOutcome> {
    const c = classifyResponse(r.status, r.json);
    if (c.kind !== 'ok') return { ok: false, kind: c.kind, message: faultText(r.status, c.fault) };
    let id = knownId ?? idFromLocation(r.location);
    if (!id && externalId) {
      // Location header missing: resolve the internal id through SuiteQL by the externalId we just wrote.
      const q = `SELECT id FROM ${entity === 'invoice' || entity === 'payment' ? 'transaction' : entity} WHERE externalId = '${externalId}' FETCH FIRST 1 ROWS ONLY`;
      const page = await this.suiteql(q, 1, 0);
      id = page.rows[0]?.id !== undefined ? String(page.rows[0].id) : null;
    }
    if (!id) return { ok: false, kind: 'error', message: 'NetSuite did not return the record id.' };
    const record = await this.getRecord(entity, id);
    if (!record) return { ok: false, kind: 'error', message: 'The record could not be read back from NetSuite.' };
    return { ok: true, id, record: { ...record, id: record.id ?? id } };
  }
}

export type WriteOutcome = { ok: true; id: string; record: RawRecord } | { ok: false; kind: FaultKind; message: string };

export class NsFaultError extends Error {
  constructor(readonly kind: FaultKind, message: string) {
    super(message);
  }
}

export function faultText(status: number, fault: NsFault | null): string {
  if (!fault) return `HTTP ${status}`;
  return `${fault.code ? `${fault.code}: ` : ''}${fault.message}`.slice(0, 300) || `HTTP ${status}`;
}
