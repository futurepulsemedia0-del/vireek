// supabase/functions/_shared/price-playbook/policy.ts
//
// Pure glue between database rows and the playbook engine. No imports from Deno, Supabase or the
// network, so it is unit-testable and shared by every channel (voice tool, SMS/email auto-reply,
// web chat). Database access lives in runtime.ts.

import type { Figure, PriceAnswer, PricePolicy, Trade } from './engine.ts';

export interface PricePolicyRow {
  service_key: string;
  display_name: string;
  trade: string;
  mode: PricePolicy['mode'];
  keywords: string[] | null;
  source_kind: 'price_book' | 'owner_entered';
  price_book_item_id: string | null;
  amount_low_cents: number | null;
  amount_high_cents: number | null;
  diagnostic_fee_cents: number | null;
  fee_credited_on_repair: boolean;
  written_price_before_work: boolean;
  includes: string[] | null;
  changes_price: string[] | null;
  verified_at: string;
  approved_states: string[] | null;
  legal_review_status: 'pending' | 'approved';
  active: boolean;
}

const TRADES: ReadonlySet<string> = new Set(['hvac', 'plumbing', 'electrical', 'appliance', 'roofing', 'general']);

export function rowToPolicy(r: PricePolicyRow): PricePolicy {
  return {
    service_key: r.service_key,
    display_name: r.display_name,
    trade: (TRADES.has(r.trade) ? r.trade : 'general') as Trade,
    mode: r.mode,
    amount_low_cents: r.amount_low_cents,
    amount_high_cents: r.amount_high_cents,
    diagnostic_fee_cents: r.diagnostic_fee_cents,
    fee_credited_on_repair: r.fee_credited_on_repair,
    written_price_before_work: r.written_price_before_work,
    includes: r.includes ?? [],
    changes_price: r.changes_price ?? [],
    source: { kind: r.source_kind, price_book_item_id: r.price_book_item_id, verified_at: r.verified_at },
    approved_states: r.approved_states ?? [],
    legal_review_status: r.legal_review_status,
    active: r.active,
  };
}

// ---------------------------------------------------------------------------
// Price-ask detection (English). Deliberately broad: a false positive only adds an approved
// answer to the context; a false negative would let a price question skip the policy.
// ---------------------------------------------------------------------------

const PRICE_ASK_RE =
  /\b(how much|price|prices|pricing|cost|costs|quote|quotes|estimate|ballpark|rate|rates|charge|charges|fee|fees|cheap|cheaper|afford|expensive|what do you charge|\$\s?\d)/i;

export function isPriceAsk(text: string): boolean {
  return PRICE_ASK_RE.test(text);
}

// ---------------------------------------------------------------------------
// Which policy does the conversation refer to?
//   - voice tool: `needle` is a short service phrase from the model
//   - SMS/email/web: `needle` is the whole customer message
// The most specific (longest) matching name wins; ties break on service_key for determinism.
// ---------------------------------------------------------------------------

export function matchPolicy<T extends Pick<PricePolicyRow, 'service_key' | 'display_name' | 'keywords'>>(
  rows: T[],
  needleRaw: string,
): T | null {
  const needle = needleRaw.toLowerCase().trim();
  if (!needle) return null;
  let best: { row: T; score: number } | null = null;
  for (const row of rows) {
    const names = [row.service_key, row.display_name, ...(row.keywords ?? [])]
      .map((s) => String(s).toLowerCase().trim())
      .filter((s) => s.length >= 3);
    for (const name of names) {
      const exact = name === needle;
      const partial = needle.includes(name) || (needle.length >= 3 && name.includes(needle));
      if (!exact && !partial) continue;
      const score = (exact ? 1000 : 0) + name.length;
      if (!best || score > best.score || (score === best.score && row.service_key < best.row.service_key)) {
        best = { row, score };
      }
    }
  }
  return best?.row ?? null;
}

// ---------------------------------------------------------------------------
// Jurisdiction: price-advertising law follows where the work is done. A phone area code only says
// where a number was issued, so it is never used. Falls back to the business's own state.
// ---------------------------------------------------------------------------

export function chooseState(
  resolved: { state: string | null; basis: 'explicit' | 'address' | 'phone' | 'unknown' },
  businessState: string | null,
): string | null {
  if (resolved.state && (resolved.basis === 'explicit' || resolved.basis === 'address')) return resolved.state;
  return businessState && /^[A-Z]{2}$/.test(businessState) ? businessState : null;
}

// ---------------------------------------------------------------------------
// Bridge to ai-core/priceEnforcement: every figure Sarah is allowed to say is logged as a lookup,
// so the post-call accuracy check treats it as grounded instead of a false "mismatch".
// ---------------------------------------------------------------------------

export interface LookupItem {
  service_name: string;
  pricing_model: 'flat' | 'starting_at' | 'range';
  price_cents: number;
  price_max_cents: number | null;
}

export function figuresToLookupItems(serviceName: string, figures: Figure[]): LookupItem[] {
  const low = figures.find((f) => f.kind === 'range_low');
  const high = figures.find((f) => f.kind === 'range_high');
  const out: LookupItem[] = [];
  for (const f of figures) {
    if (f.kind === 'range_high') continue;
    if (f.kind === 'range_low' && low) {
      out.push({ service_name: serviceName, pricing_model: 'range', price_cents: low.cents, price_max_cents: high?.cents ?? low.cents });
    } else if (f.kind === 'starting_at') {
      out.push({ service_name: serviceName, pricing_model: 'starting_at', price_cents: f.cents, price_max_cents: null });
    } else {
      out.push({ service_name: serviceName, pricing_model: 'flat', price_cents: f.cents, price_max_cents: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text channels: when a policy matched, knowledge-base dollar amounts are removed from what the
// model may use or ground against, so the existing "price not in knowledge base" guard blocks any
// KB price that contradicts the owner's policy. Fail closed.
// ---------------------------------------------------------------------------

const MONEY_STRIP_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|eur|euros?)\b)/gi;

export function stripMoney(text: string): string {
  return text.replace(MONEY_STRIP_RE, '[amount]');
}

export function buildTextChannelContext(answer: PriceAnswer, questions: { text: string }[]): string {
  const qs = questions.length ? ` Then ask the customer: ${questions.map((q, i) => `(${i + 1}) ${q.text}`).join(' ')}` : '';
  return [
    'APPROVED PRICE ANSWER (set by the business, overrides every other price in the knowledge base):',
    `Say: ${answer.spoken}`,
    `Do not state any other dollar amount, discount or price match.${qs}`,
  ].join('\n');
}
