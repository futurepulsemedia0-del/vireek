/* ------------------------------------------------------------------ */
/*  regionConfig/taxProvider — TaxProvider adapter + document tax       */
/*                                                                      */
/*  CONTRACT                                                            */
/*   A TaxProvider is a PURE-INTERFACE adapter that taxes NET lines     */
/*   (tax-exclusive) in MINOR units (exponent convention, see money.ts) */
/*   and returns a packs `TaxResult`. Everything provider-agnostic —    */
/*   validation, tax-INCLUSIVE back-calculation, idempotency, retries,  */
/*   invariants — lives in createTaxService() so every provider (mock,  */
/*   built-in packs engine, a future Stripe Tax / Avalara adapter)      */
/*   behaves identically on quotes and invoices.                        */
/*                                                                      */
/*  Real third-party providers are NOT implemented here (no scraping,   */
/*  no unverified API contracts). Rates are reference data only and the */
/*  output is not tax advice — REQUIRES COUNSEL / a tax adviser.        */
/* ------------------------------------------------------------------ */

import { computeTax } from '../regionalPacks/packTax';
import { applyRate } from '../regionalPacks/packMoney';
import type { RateCategory, TaxContext, TaxLineInput, TaxLineResult, TaxResult, TaxBreakdownRow, Warning } from '../regionalPacks/packTypes';
import { divRound, money, DEFAULT_ROUNDING, type RoundingMode } from './money';

export type TaxMode = 'exclusive' | 'inclusive';

/** What a provider receives: ALWAYS net (tax-exclusive) lines. */
export interface TaxProviderRequest {
  idempotencyKey: string;
  currency: string;
  lines: readonly TaxLineInput[];
  context: TaxContext;
}

export interface TaxProvider {
  readonly id: string;
  calculate(req: TaxProviderRequest, opts?: { signal?: AbortSignal }): Promise<TaxResult>;
}

export class TaxProviderError extends Error {
  constructor(
    public readonly code: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_REJECTED' | 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT' | 'INVARIANT_VIOLATION' | 'TIMEOUT',
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'TaxProviderError';
  }
}

/* ------------------------------ request ------------------------------ */

export interface TaxDocumentLine {
  id: string;
  /** exclusive mode → NET amount; inclusive mode → GROSS (shelf) amount. Negative for credit notes. */
  amountMinor: number;
  category?: RateCategory;
  reducedIndex?: number;
}

export interface TaxQuoteRequest {
  /** Stable per document+revision, e.g. `quote:<id>:r3`. Same key + same payload = same answer. */
  idempotencyKey: string;
  mode: TaxMode;
  currency: string;
  lines: readonly TaxDocumentLine[];
  context: Omit<TaxContext, 'currency' | 'rounding'>;
  /** Used only to split a tax-inclusive amount. Default half_away_from_zero. */
  rounding?: RoundingMode;
}

export interface DocumentTax extends TaxResult {
  provider: string;
  mode: TaxMode;
  /** inclusive only: Σ input gross − resulting gross (0 when the shelf price was matched exactly). */
  inclusiveResidualMinor: number;
}

const KEY_RE = /^[A-Za-z0-9_.:\-]{8,128}$/;
const PROBE_NET = 10_000_000; // minor units; large enough that tax/PROBE resolves rates to ~1e-7

function validate(req: TaxQuoteRequest): void {
  const bad = (m: string): never => { throw new TaxProviderError('INVALID_REQUEST', m); };
  if (!KEY_RE.test(req.idempotencyKey ?? '')) bad('idempotencyKey must be 8–128 chars of [A-Za-z0-9_.:-].');
  if (req.mode !== 'exclusive' && req.mode !== 'inclusive') bad('mode must be "exclusive" or "inclusive".');
  try { money(0, req.currency); } catch { bad(`Invalid currency "${String(req.currency)}".`); }
  if (!Array.isArray(req.lines) || req.lines.length === 0) bad('At least one line is required.');
  if (req.lines.length > 500) bad('Too many lines (max 500).');
  const seen = new Set<string>();
  for (const l of req.lines) {
    if (typeof l.id !== 'string' || !l.id || l.id.length > 64) bad('Each line needs an id (1–64 chars).');
    if (seen.has(l.id)) bad(`Duplicate line id "${l.id}".`);
    seen.add(l.id);
    if (!Number.isSafeInteger(l.amountMinor)) bad(`Line "${l.id}": amountMinor must be a safe integer.`);
    if (Math.abs(l.amountMinor) > 1e12) bad(`Line "${l.id}": amount out of range.`);
  }
}

function checkInvariants(r: TaxResult, expectCurrency: string): void {
  const fail = (m: string): never => { throw new TaxProviderError('INVARIANT_VIOLATION', `Tax provider returned inconsistent data: ${m}`); };
  if (r.currency.toUpperCase() !== expectCurrency) fail('currency changed.');
  if (r.netMinor + r.taxMinor !== r.grossMinor) fail('net + tax ≠ gross.');
  let n = 0; let t = 0;
  for (const l of r.lines) {
    if (l.netMinor + l.taxMinor !== l.grossMinor) fail(`line ${l.id}: net + tax ≠ gross.`);
    n += l.netMinor; t += l.taxMinor;
  }
  if (n !== r.netMinor || t !== r.taxMinor) fail('line sums do not match totals.');
}

/* ------------------------------ service ------------------------------ */

export interface TaxServiceOptions {
  maxAttempts?: number;
  /** Injectable for tests; default is an exponential backoff (200ms, 400ms…). */
  sleep?: (ms: number) => Promise<void>;
  /** Cap on remembered idempotency entries (oldest evicted). */
  cacheSize?: number;
}

export interface TaxService {
  quote(req: TaxQuoteRequest, opts?: { signal?: AbortSignal }): Promise<DocumentTax>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createTaxService(provider: TaxProvider, options: TaxServiceOptions = {}): TaxService {
  const maxAttempts = Math.max(1, Math.min(5, options.maxAttempts ?? 3));
  const sleep = options.sleep ?? defaultSleep;
  const cacheSize = options.cacheSize ?? 200;
  const cache = new Map<string, { fingerprint: string; promise: Promise<DocumentTax> }>();

  async function callProvider(req: TaxQuoteRequest, suffix: string, lines: readonly TaxLineInput[], signal?: AbortSignal): Promise<TaxResult> {
    const cur = req.currency.trim().toUpperCase();
    const pReq: TaxProviderRequest = {
      idempotencyKey: `${req.idempotencyKey}#${suffix}`.slice(0, 160),
      currency: cur,
      lines,
      context: { ...req.context, currency: cur },
    };
    let last: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) throw new TaxProviderError('TIMEOUT', 'Tax calculation was cancelled.');
      try {
        const res = await provider.calculate(pReq, { signal });
        checkInvariants(res, cur);
        return res;
      } catch (e) {
        last = e;
        const retryable = e instanceof TaxProviderError && e.retryable;
        if (!retryable || attempt === maxAttempts) break;
        await sleep(200 * 2 ** (attempt - 1));
      }
    }
    if (last instanceof TaxProviderError) throw last;
    throw new TaxProviderError('PROVIDER_UNAVAILABLE', last instanceof Error ? last.message : 'Tax provider failed.', true);
  }

  async function run(req: TaxQuoteRequest, signal?: AbortSignal): Promise<DocumentTax> {
    const cur = req.currency.trim().toUpperCase();
    const mode = req.rounding ?? DEFAULT_ROUNDING;

    if (req.mode === 'exclusive') {
      const lines: TaxLineInput[] = req.lines.map((l) => ({ id: l.id, netMinor: l.amountMinor, category: l.category, reducedIndex: l.reducedIndex }));
      const res = await callProvider(req, 'x', lines, signal);
      return { ...res, provider: provider.id, mode: 'exclusive', inclusiveResidualMinor: 0 };
    }

    // ---- tax-INCLUSIVE: derive net from the shelf (gross) price, keeping gross authoritative ----
    const targetGross = req.lines.reduce((a, l) => a + l.amountMinor, 0);
    const probeLines: TaxLineInput[] = req.lines.map((l) => ({ id: l.id, netMinor: PROBE_NET, category: l.category, reducedIndex: l.reducedIndex }));
    const probe = await callProvider(req, 'p', probeLines, signal);
    const taxByLine = new Map(probe.lines.map((l) => [l.id, l.taxMinor]));

    const nets = new Map<string, number>();
    for (const l of req.lines) {
      const t = taxByLine.get(l.id);
      if (t === undefined) throw new TaxProviderError('INVARIANT_VIOLATION', `Provider omitted probe line "${l.id}".`);
      // taxPortion = gross × t / (PROBE + t)
      const portion = divRound(BigInt(l.amountMinor) * BigInt(t), BigInt(PROBE_NET + t), mode);
      nets.set(l.id, l.amountMinor - Number(portion));
    }

    const build = (): TaxLineInput[] => req.lines.map((l) => ({ id: l.id, netMinor: nets.get(l.id)!, category: l.category, reducedIndex: l.reducedIndex }));
    let best = await callProvider(req, 'i0', build(), signal);
    let bestResidual = targetGross - best.grossMinor;

    for (let round = 1; round <= 2 && bestResidual !== 0; round++) {
      // nudge the largest line by the residual and keep whichever attempt lands closest to the shelf price
      const anchor = [...req.lines].sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor))[0];
      const prev = nets.get(anchor.id)!;
      nets.set(anchor.id, prev + bestResidual);
      const cand = await callProvider(req, `i${round}`, build(), signal);
      const candResidual = targetGross - cand.grossMinor;
      if (Math.abs(candResidual) < Math.abs(bestResidual)) { best = cand; bestResidual = candResidual; }
      else nets.set(anchor.id, prev);
    }

    const warnings: Warning[] = [...best.warnings];
    if (bestResidual !== 0) {
      warnings.push({
        code: 'INCLUSIVE_RESIDUAL',
        message: `A tax-inclusive price of ${targetGross} minor units cannot be split exactly at these rates; the result is ${Math.abs(bestResidual)} minor unit(s) ${bestResidual > 0 ? 'below' : 'above'} the shelf price.`,
      });
    }
    return { ...best, warnings, provider: provider.id, mode: 'inclusive', inclusiveResidualMinor: bestResidual };
  }

  return {
    quote(req, opts) {
      try { validate(req); } catch (e) { return Promise.reject(e); } // always a Promise, never a sync throw
      const fingerprint = JSON.stringify([req.mode, req.currency.toUpperCase(), req.rounding ?? null, req.lines, req.context]);
      const hit = cache.get(req.idempotencyKey);
      if (hit) {
        if (hit.fingerprint !== fingerprint) {
          return Promise.reject(new TaxProviderError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with a different request.'));
        }
        return hit.promise;
      }
      const promise = run(req, opts?.signal);
      cache.set(req.idempotencyKey, { fingerprint, promise });
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value as string);
      // failures are not remembered: a retry with the same key must be able to succeed
      promise.catch(() => { if (cache.get(req.idempotencyKey)?.promise === promise) cache.delete(req.idempotencyKey); });
      return promise;
    },
  };
}

/* ------------------------------ providers ------------------------------ */

/** Built-in, offline provider: the audited regional-packs engine (VAT / GST / HST / QST / PST). */
export function createPackTaxProvider(): TaxProvider {
  return {
    id: 'regional-packs',
    async calculate(req) {
      try {
        return computeTax(req.context, req.lines);
      } catch (e) {
        // computeTax throws on unknown jurisdictions / missing provinces: a caller error, not retryable
        throw new TaxProviderError('PROVIDER_REJECTED', e instanceof Error ? e.message : 'Tax could not be computed.');
      }
    },
  };
}

export interface MockTaxOptions {
  /** Flat percent (up to 3 decimals) applied to non-zero/exempt lines. Default 10. */
  ratePct?: number;
  label?: string;
  /** Fail the first N calls with a retryable error (to exercise retry paths). */
  failFirst?: number;
  /** Always reject with this non-retryable error message. */
  rejectWith?: string;
}

/** Deterministic mock: flat rate, no network, call log exposed for assertions. */
export function createMockTaxProvider(opts: MockTaxOptions = {}): TaxProvider & { readonly calls: TaxProviderRequest[] } {
  const rate = opts.ratePct ?? 10;
  const label = opts.label ?? 'Mock tax';
  let failures = opts.failFirst ?? 0;
  const calls: TaxProviderRequest[] = [];
  return {
    id: 'mock',
    calls,
    async calculate(req) {
      calls.push(req);
      if (opts.rejectWith) throw new TaxProviderError('PROVIDER_REJECTED', opts.rejectWith);
      if (failures > 0) { failures -= 1; throw new TaxProviderError('PROVIDER_UNAVAILABLE', 'Mock outage', true); }
      let net = 0; let tax = 0; let taxableNet = 0;
      const lines: TaxLineResult[] = req.lines.map((l) => {
        const category = l.category ?? 'standard';
        const t = category === 'zero' || category === 'exempt' ? 0 : applyRate(l.netMinor, rate);
        net += l.netMinor; tax += t;
        if (t !== 0 || category === 'standard') taxableNet += l.netMinor;
        return {
          id: l.id, netMinor: l.netMinor, taxMinor: t, grossMinor: l.netMinor + t, category,
          components: t === 0 && rate === 0 ? [] : [{ code: 'VAT', ratePct: category === 'zero' || category === 'exempt' ? 0 : rate, taxMinor: t }],
        };
      });
      const breakdown: TaxBreakdownRow[] = tax === 0 && rate === 0 ? [] : [{ code: 'VAT', label, ratePct: rate, netMinor: taxableNet, taxMinor: tax }];
      return {
        status: 'ok', currency: req.currency, netMinor: net, taxMinor: tax, grossMinor: net + tax, lines, breakdown,
        reverseCharge: false, placeOfSupply: { country: req.context.siteCountry, subdivision: req.context.siteSubdivision ?? null },
        notes: ['Mock provider — not a real tax calculation.'], warnings: [],
      };
    },
  };
}

/**
 * Call before ISSUING an invoice: only status 'ok' is a complete calculation. Other statuses
 * (no_registration, needs_rate, needs_review, out_of_scope) mean tax may be missing — a human must resolve them.
 */
export function requireOkTax(t: TaxResult): TaxResult {
  if (t.status !== 'ok') {
    throw new TaxProviderError('PROVIDER_REJECTED', `Tax is not final (status: ${t.status}). ${t.warnings.map((w) => w.message).join(' ')}`.trim());
  }
  return t;
}
