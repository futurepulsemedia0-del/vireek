// Service-protection offer framework (item 139) — pure logic, no I/O except the sandbox stub adapter.
// Mirrors the SQL in 20290312000000_service_protection_commissions.sql; keep both in sync.
//
// Rules this module enforces:
//  * Prices, terms, plan names and disclosure TEXT come from the provider only. Vireek never authors them.
//  * Commission amounts come from provider-reported events only. Vireek never computes or assumes a rate.
//  * Sandbox/stub data can never create ledger money.

import type { EnvReader, PartnerAdapter, PartnerWebhookEvent } from './types.ts';
import { sha256Hex, timingSafeEqualHex, verifyWebhookSignature } from './signature.ts';

// ---------------------------------------------------------------------------
// Offer lifecycle: requested -> quoted -> accepted -> active (fulfilled)
// ---------------------------------------------------------------------------
export const PROTECTION_STATUSES = [
  'requested', 'quoted', 'accepted', 'active', 'declined', 'expired', 'canceled', 'failed',
] as const;
export type ProtectionStatus = (typeof PROTECTION_STATUSES)[number];

export const PROTECTION_TERMINAL: readonly ProtectionStatus[] = ['active', 'declined', 'expired', 'canceled', 'failed'];

const RANK: Partial<Record<ProtectionStatus, number>> = { requested: 0, quoted: 1, accepted: 2, active: 3 };

export const isProtectionStatus = (s: unknown): s is ProtectionStatus =>
  typeof s === 'string' && (PROTECTION_STATUSES as readonly string[]).includes(s);

export type TransitionVerdict = 'apply' | 'noop' | 'reject';

/** Same matrix as public.fin_protection_transition(). Forward-only; terminal states are final. */
export function protectionTransition(from: ProtectionStatus, to: ProtectionStatus): TransitionVerdict {
  if (from === to) return 'noop';
  if (PROTECTION_TERMINAL.includes(from)) return 'reject';
  if (to === 'failed') return from === 'requested' ? 'apply' : 'reject';
  if (to === 'declined' || to === 'canceled') return 'apply';
  if (to === 'expired') return from === 'requested' || from === 'quoted' ? 'apply' : 'reject';
  const a = RANK[from], b = RANK[to];
  if (a === undefined || b === undefined) return 'reject';
  // A partner may not skip acceptance: quoted -> active is rejected (flagged for review in SQL).
  return b === a + 1 ? 'apply' : 'reject';
}

// ---------------------------------------------------------------------------
// Eligibility (advisory pre-check; the SQL function is authoritative)
// ---------------------------------------------------------------------------
export interface ProtectionCapabilities {
  currencies: readonly string[];
  minQuoteCents?: number;
  maxQuoteCents?: number;
}

export type EligibilityReason =
  | 'gate_closed' | 'quote_not_found' | 'quote_status' | 'no_partner'
  | 'currency_unsupported' | 'below_minimum' | 'above_maximum' | 'live_offer_exists';

export interface EligibilityInput {
  gate: { allowed: boolean; reason?: string | null };
  quote: { status: string; totalCents: number; currency: string } | null;
  partner: ProtectionCapabilities | null;
  hasLiveOffer: boolean;
}
export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: EligibilityReason; detail?: string | number | null };

export const ELIGIBLE_QUOTE_STATUSES: readonly string[] = ['sent', 'accepted'];

export function evaluateProtectionEligibility(i: EligibilityInput): EligibilityResult {
  if (!i.gate.allowed) return { eligible: false, reason: 'gate_closed', detail: i.gate.reason ?? null };
  if (!i.quote) return { eligible: false, reason: 'quote_not_found' };
  if (!ELIGIBLE_QUOTE_STATUSES.includes(i.quote.status)) return { eligible: false, reason: 'quote_status', detail: i.quote.status };
  if (!i.partner) return { eligible: false, reason: 'no_partner' };
  const cur = i.quote.currency.toUpperCase();
  if (!i.partner.currencies.map((c) => c.toUpperCase()).includes(cur)) return { eligible: false, reason: 'currency_unsupported', detail: cur };
  if (!Number.isInteger(i.quote.totalCents) || i.quote.totalCents <= 0) return { eligible: false, reason: 'below_minimum', detail: 0 };
  if (i.partner.minQuoteCents !== undefined && i.quote.totalCents < i.partner.minQuoteCents) return { eligible: false, reason: 'below_minimum', detail: i.partner.minQuoteCents };
  if (i.partner.maxQuoteCents !== undefined && i.quote.totalCents > i.partner.maxQuoteCents) return { eligible: false, reason: 'above_maximum', detail: i.partner.maxQuoteCents };
  if (i.hasLiveOffer) return { eligible: false, reason: 'live_offer_exists' };
  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Provider quote validation + disclosure integrity
// ---------------------------------------------------------------------------
export interface ProtectionQuote {
  partnerReference: string;
  priceCents: number;
  currency: string;
  termMonths: number;
  planLabel: string;
  /** Verbatim provider text. Shown to the customer unchanged; its SHA-256 must be acknowledged on accept. */
  disclosureText: string;
}

export const MAX_DISCLOSURE_CHARS = 8000;

export function validateProviderQuote(q: unknown): ProtectionQuote | null {
  if (!q || typeof q !== 'object') return null;
  const o = q as Record<string, unknown>;
  const ref = typeof o.partnerReference === 'string' ? o.partnerReference : '';
  const label = typeof o.planLabel === 'string' ? o.planLabel.trim() : '';
  const disc = typeof o.disclosureText === 'string' ? o.disclosureText : '';
  const cur = typeof o.currency === 'string' ? o.currency.toUpperCase() : '';
  if (!ref || ref.length > 128) return null;
  if (!label || label.length > 120) return null;
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  if (!Number.isInteger(o.priceCents) || (o.priceCents as number) <= 0 || (o.priceCents as number) > 2_147_483_647) return null;
  if (!Number.isInteger(o.termMonths) || (o.termMonths as number) < 1 || (o.termMonths as number) > 600) return null;
  // No provider disclosure => no offer. We never substitute our own wording.
  if (disc.trim().length < 40 || disc.length > MAX_DISCLOSURE_CHARS) return null;
  return { partnerReference: ref, priceCents: o.priceCents as number, currency: cur, termMonths: o.termMonths as number, planLabel: label, disclosureText: disc };
}

export const disclosureSha256 = (text: string) => sha256Hex(text);

export function acknowledgedMatches(storedSha: string | null | undefined, ackSha: string | null | undefined): boolean {
  if (!storedSha || !ackSha) return false;
  if (!/^[0-9a-f]{64}$/.test(storedSha) || !/^[0-9a-f]{64}$/.test(ackSha)) return false;
  return timingSafeEqualHex(storedSha, ackSha);
}

// ---------------------------------------------------------------------------
// Commission ledger math (mirror of public.fin_record_commission)
// ---------------------------------------------------------------------------
export type CommissionKind = 'accrual' | 'reversal' | 'settlement';
export interface CommissionLine { kind: CommissionKind; amountCents: number; currency: string }

export interface CommissionBalance { accrued: number; reversed: number; settled: number; net: number; outstanding: number }

export function commissionBalance(lines: readonly CommissionLine[], currency: string): CommissionBalance {
  let accrued = 0, reversed = 0, settled = 0;
  for (const l of lines) {
    if (l.currency !== currency) continue;
    if (l.kind === 'accrual') accrued += l.amountCents;
    else if (l.kind === 'reversal') reversed += l.amountCents;
    else settled += l.amountCents;
  }
  const net = accrued - reversed;
  return { accrued, reversed, settled, net, outstanding: net - settled };
}

export type CommissionCheck = 'ok' | 'invalid_amount' | 'currency_mismatch' | 'exceeds_balance';

export function checkCommissionEntry(lines: readonly CommissionLine[], next: CommissionLine): CommissionCheck {
  if (!Number.isInteger(next.amountCents) || next.amountCents <= 0) return 'invalid_amount';
  if (!/^[A-Z]{3}$/.test(next.currency)) return 'invalid_amount';
  if (lines.length > 0 && lines.some((l) => l.currency !== next.currency)) return 'currency_mismatch';
  const b = commissionBalance(lines, next.currency);
  if (next.kind === 'reversal' && next.amountCents > b.net) return 'exceeds_balance';
  if (next.kind === 'settlement' && next.amountCents > b.outstanding) return 'exceeds_balance';
  return 'ok';
}

/** Entity states in which a provider-reported commission accrual is allowed (mirrors SQL). */
export const COMMISSION_ACCRUAL_STATES = {
  consumer_financing: 'funded',
  service_protection: 'active',
  insurance_referral: 'bound',
} as const;

// ---------------------------------------------------------------------------
// Provider adapter contract for protection + sandbox stub
// ---------------------------------------------------------------------------
export interface ProtectionQuoteRequest {
  referenceId: string;
  amountCents: number;
  currency: string;
  description: string;
}
export interface ProtectionAcceptRequest {
  referenceId: string;
  partnerReference: string;
  disclosureSha256: string;
}
export interface ProtectionPartner extends PartnerAdapter {
  readonly sandbox: boolean;
  readonly protection: ProtectionCapabilities;
  requestProtectionQuote(p: ProtectionQuoteRequest): Promise<ProtectionQuote>;
  acceptProtection(p: ProtectionAcceptRequest): Promise<{ partnerReference: string }>;
}

export const isProtectionPartner = (p: PartnerAdapter | null): p is ProtectionPartner =>
  !!p && typeof (p as Partial<ProtectionPartner>).requestProtectionQuote === 'function'
    && typeof (p as Partial<ProtectionPartner>).acceptProtection === 'function'
    && !!(p as Partial<ProtectionPartner>).protection;

export interface ProtectionWebhookEvent extends PartnerWebhookEvent {
  quote?: ProtectionQuote;
  commission?: { kind: CommissionKind; amountCents: number; currency: string };
}

export const PROTECTION_STUB_KEY = 'protection_stub';
export const PROTECTION_STUB_SIGNATURE_HEADER = 'X-Partner-Signature';

const defaultEnv: EnvReader = (k) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined);

/**
 * SANDBOX stub. It is NOT a real provider: its quote is a fixed placeholder, its disclosure says so, and
 * SQL refuses to book commission for sandbox offers. A real provider replaces this file's adapter, not the framework.
 * Selectable only when FINANCING_PARTNER_ALLOW_PROTECTION_STUB=true.
 */
export function createProtectionStub(env: EnvReader = defaultEnv): ProtectionPartner {
  return {
    key: PROTECTION_STUB_KEY,
    sandbox: true,
    capabilities: { displayName: 'Sandbox Protection Provider', products: ['service_protection'] },
    protection: { currencies: ['USD'], minQuoteCents: 10_000, maxQuoteCents: 5_000_000 },
    isConfigured: () => env('FINANCING_PARTNER_ALLOW_PROTECTION_STUB') === 'true',

    async createApplication() { throw new Error('unsupported'); },
    async submitWorkingCapitalSignals() { throw new Error('unsupported'); },
    async createInsuranceReferral() { throw new Error('unsupported'); },

    async requestProtectionQuote(p) {
      return {
        partnerReference: `stub_prot_${p.referenceId}`,
        priceCents: 1_000,
        currency: p.currency.toUpperCase(),
        termMonths: 12,
        planLabel: 'Sandbox plan (not a real product)',
        disclosureText: 'SANDBOX ONLY. This is a test quote from a stub provider. It is not an offer, has no coverage and must never be shown to a real customer.',
      };
    },
    async acceptProtection(p) { return { partnerReference: p.partnerReference }; },

    verifyWebhook(rawBody, headers) {
      return verifyWebhookSignature(rawBody, headers.get(PROTECTION_STUB_SIGNATURE_HEADER), env('FINANCING_PARTNER_PROTECTION_STUB_WEBHOOK_SECRET'));
    },
    parseWebhook(rawBody): ProtectionWebhookEvent | null {
      return parseProtectionWebhook(rawBody);
    },
  };
}

/** Generic JSON shape a provider adapter can reuse: {id, type:'protection.status', reference, status, quote?, commission?}. */
export function parseProtectionWebhook(rawBody: string): ProtectionWebhookEvent | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(rawBody); } catch { return null; }
  if (!j || typeof j !== 'object' || j.type !== 'protection.status') return null;
  const eventId = typeof j.id === 'string' ? j.id : '';
  const reference = typeof j.reference === 'string' ? j.reference : '';
  const status = typeof j.status === 'string' ? j.status : '';
  if (!eventId || eventId.length > 128 || !reference || reference.length > 128) return null;
  if (!['quoted', 'active', 'declined', 'expired', 'canceled'].includes(status)) return null;
  const ev: ProtectionWebhookEvent = { eventId, kind: 'protection', partnerReference: reference, status };
  if (j.quote !== undefined) {
    const q = validateProviderQuote({ ...(j.quote as object), partnerReference: reference });
    if (!q) return null;
    ev.quote = q;
  }
  if (j.commission !== undefined) {
    const c = j.commission as Record<string, unknown>;
    const kind = c?.kind;
    const cur = typeof c?.currency === 'string' ? c.currency.toUpperCase() : '';
    if ((kind !== 'accrual' && kind !== 'reversal' && kind !== 'settlement') || !Number.isInteger(c.amountCents) || (c.amountCents as number) <= 0 || !/^[A-Z]{3}$/.test(cur)) return null;
    ev.commission = { kind, amountCents: c.amountCents as number, currency: cur };
  }
  return ev;
}

export const protectionStub = createProtectionStub();
