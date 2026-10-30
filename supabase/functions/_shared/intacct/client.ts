// supabase/functions/_shared/intacct/client.ts
//
// Sage Intacct gateway client: session handling, retries with backoff, throttle handling.
// Transport is injectable (fetch, sleep, clock, random) so it is fully testable with mockGateway.ts.
// NOT LIVE-VERIFIED (see engine.ts).
//
// Retry policy (the part that keeps writes idempotent):
//   - READS retry on network errors, HTTP 429 / 5xx, non-XML bodies and throttle faults.
//   - WRITES retry ONLY when Intacct provably rejected the request before executing it
//     (HTTP 429, a throttle fault, or an expired session). A network error or 5xx on a write has an
//     unknown outcome: it throws IaTransportError and the caller re-checks existence (find-before-create).

import {
  IA_GATEWAY, buildRequest, classifyFault, faultText, fnGetSession, isAllowedGateway, parseResponse, parseSession,
  type IaCredentials, type IaFn, type IaResult, type IaResponse, IaXmlError,
} from './engine.ts';

export class IaAuthError extends Error {}
export class IaThrottleError extends Error {}
export class IaTransportError extends Error {
  unknownOutcome: boolean;
  constructor(m: string, unknownOutcome: boolean) { super(m); this.unknownOutcome = unknownOutcome; }
}
export class IaOpError extends Error {
  kind: string;
  controlId: string | null;
  constructor(m: string, kind: string, controlId: string | null) { super(m); this.kind = kind; this.controlId = controlId; }
}

export interface IaSession { id: string; endpoint: string; expiresAt: number }
export interface IaClientOptions {
  senderId: string;
  senderPassword: string;
  credentials: IaCredentials;
  session?: IaSession | null;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Called when a fresh session was created (persist it) or dropped (null). */
  onSession?: (s: IaSession | null) => Promise<void> | void;
}

const SESSION_TTL_MS = 50 * 60_000;
const SESSION_SKEW_MS = 2 * 60_000;

export class IntacctClient {
  session: IaSession | null;
  /** Control id of the most recent request, for support correlation in the sync log. */
  lastControlId: string | null = null;
  private readonly o: Required<Omit<IaClientOptions, 'session' | 'onSession'>> & Pick<IaClientOptions, 'onSession'>;

  constructor(opts: IaClientOptions) {
    this.session = opts.session ?? null;
    this.o = {
      senderId: opts.senderId, senderPassword: opts.senderPassword, credentials: opts.credentials,
      fetchFn: opts.fetchFn ?? ((...a) => fetch(...a)),
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? (() => Date.now()),
      random: opts.random ?? (() => Math.random()),
      maxAttempts: opts.maxAttempts ?? 4,
      timeoutMs: opts.timeoutMs ?? 30_000,
      onSession: opts.onSession,
    };
  }

  newControlId(): string {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return `vk-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
  }

  private backoff(attempt: number): number {
    return Math.min(8000, 400 * 2 ** (attempt - 1)) + Math.floor(this.o.random() * 250);
  }

  private async post(url: string, body: string): Promise<{ status: number; text: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    try {
      const res = await this.o.fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }, body, signal: ctl.signal });
      return { status: res.status, text: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Create (or reuse) an API session. Wrong credentials throw IaAuthError and are never retried. */
  async ensureSession(force = false): Promise<IaSession> {
    if (!force && this.session && this.session.expiresAt - this.o.now() > SESSION_SKEW_MS) return this.session;
    for (let attempt = 1; ; attempt++) {
      const controlId = this.newControlId();
      this.lastControlId = controlId;
      const xml = buildRequest({ senderId: this.o.senderId, senderPassword: this.o.senderPassword, auth: { kind: 'login', creds: this.o.credentials }, fns: [fnGetSession(`${controlId}-s`)], controlId });
      let r: { status: number; text: string };
      try {
        r = await this.post(IA_GATEWAY, xml);
      } catch (e) {
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaTransportError(`Could not reach Sage Intacct: ${e instanceof Error ? e.message : 'network error'}`, false);
      }
      if (r.status === 429 || r.status >= 500) {
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw r.status === 429 ? new IaThrottleError('Sage Intacct is rate limiting requests.') : new IaTransportError(`Sage Intacct error ${r.status}.`, false);
      }
      let resp: IaResponse;
      try { resp = parseResponse(r.text); } catch (e) {
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaTransportError(e instanceof IaXmlError ? e.message : 'Unreadable response from Sage Intacct.', false);
      }
      if (!resp.controlOk || !resp.authOk) {
        const errs = [...resp.controlErrors, ...resp.authErrors, ...resp.results.flatMap((x) => x.errors)];
        throw new IaAuthError(faultText(errs) || 'Sage Intacct rejected the credentials.');
      }
      const first = resp.results[0];
      if (first && !first.ok) {
        const kind = classifyFault(first.errors);
        if (kind === 'throttle' && attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw kind === 'throttle' ? new IaThrottleError(faultText(first.errors)) : new IaAuthError(faultText(first.errors));
      }
      const s = parseSession(resp);
      if (!s) throw new IaAuthError('Sage Intacct did not return a session.');
      const endpoint = isAllowedGateway(s.endpoint) ? s.endpoint : IA_GATEWAY;
      this.session = { id: s.id, endpoint, expiresAt: this.o.now() + SESSION_TTL_MS };
      await this.o.onSession?.(this.session);
      return this.session;
    }
  }

  /** Run functions. Returns one IaResult per function (including failed ones: callers classify them). */
  async call(fns: IaFn[], opts: { write?: boolean } = {}): Promise<IaResult[]> {
    const write = !!opts.write;
    let relogged = false;
    for (let attempt = 1; ; attempt++) {
      const session = await this.ensureSession();
      const controlId = this.newControlId();
      this.lastControlId = controlId;
      const xml = buildRequest({ senderId: this.o.senderId, senderPassword: this.o.senderPassword, auth: { kind: 'session', sessionId: session.id }, fns, controlId, transaction: write && fns.length > 1 });
      let r: { status: number; text: string };
      try {
        r = await this.post(session.endpoint, xml);
      } catch (e) {
        if (write) throw new IaTransportError(`Connection lost while writing to Sage Intacct: ${e instanceof Error ? e.message : 'network error'}. The write may or may not have been applied.`, true);
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaTransportError('Could not reach Sage Intacct.', false);
      }
      if (r.status === 429) {
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaThrottleError('Sage Intacct is rate limiting requests.');
      }
      if (r.status >= 500) {
        if (write) throw new IaTransportError(`Sage Intacct error ${r.status} while writing. The write may or may not have been applied.`, true);
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaTransportError(`Sage Intacct error ${r.status}.`, false);
      }
      let resp: IaResponse;
      try { resp = parseResponse(r.text); } catch {
        if (write) throw new IaTransportError('Unreadable response from Sage Intacct while writing. The write may or may not have been applied.', true);
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaTransportError('Unreadable response from Sage Intacct.', false);
      }
      if (!resp.authOk) {
        // Session expired or revoked: the request was rejected before executing, so retrying is safe for writes.
        if (!relogged) { relogged = true; this.session = null; await this.o.onSession?.(null); await this.ensureSession(true); continue; }
        throw new IaAuthError(faultText(resp.authErrors) || 'Sage Intacct rejected the session.');
      }
      if (!resp.controlOk) throw new IaOpError(faultText(resp.controlErrors) || 'Sage Intacct rejected the request.', 'validation', controlId);
      if (resp.results.some((x) => !x.ok && classifyFault(x.errors) === 'throttle')) {
        if (attempt < this.o.maxAttempts) { await this.o.sleep(this.backoff(attempt)); continue; }
        throw new IaThrottleError('Sage Intacct is rate limiting requests.');
      }
      if (resp.results.some((x) => !x.ok && classifyFault(x.errors) === 'auth') && !relogged) {
        relogged = true; this.session = null; await this.o.onSession?.(null); await this.ensureSession(true); continue;
      }
      return resp.results;
    }
  }

  async single(fn: IaFn, write = false): Promise<IaResult> {
    const [r] = await this.call([fn], { write });
    if (!r) throw new IaOpError('Sage Intacct returned no result.', 'error', this.lastControlId);
    return r;
  }
}
