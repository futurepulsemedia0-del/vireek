import { describe, it, expect } from 'vitest';
import {
  applyPriceBookAmounts,
  auditReply,
  buildNextSteps,
  classifyObjection,
  composeFirstReply,
  composeGuidance,
  DEFAULT_PLAYBOOK_SETTINGS,
  composeObjectionReply,
  composeValueLine,
  formatCents,
  pickQualifyingQuestions,
  resolvePriceAnswer,
  summarizePriceConversations,
  type Channel,
  type PriceMode,
  type PricePolicy,
  type PriceEvent,
  type ResolveContext,
  type Trade,
  type ValueProps,
} from './engine';

const NOW = new Date('2028-04-01T12:00:00Z');
const CTX: ResolveContext = { state: 'TX', now: NOW };
const VALUE: ValueProps = { licensed_techs: true, warranty_months: 12, on_time_guarantee: true };
const TRADES: Trade[] = ['hvac', 'plumbing', 'electrical', 'appliance', 'roofing'];
const MODES: PriceMode[] = ['exact_flat', 'range', 'starting_at', 'diagnostic_fee_only', 'needs_visit'];
const CHANNELS: Channel[] = ['voice', 'sms', 'web'];

function policy(trade: Trade, mode: PriceMode, over: Partial<PricePolicy> = {}): PricePolicy {
  return {
    service_key: `${trade}_svc`,
    display_name: `${trade} service`,
    trade,
    mode,
    amount_low_cents: 24900,
    amount_high_cents: 44900,
    diagnostic_fee_cents: mode === 'exact_flat' || mode === 'diagnostic_fee_only' ? 8900 : null,
    fee_credited_on_repair: true,
    written_price_before_work: true,
    includes: ['labor', 'a 12-month warranty'],
    changes_price: ['we find additional damage'],
    source: { kind: 'owner_entered', price_book_item_id: null, verified_at: '2028-03-15T00:00:00Z' },
    approved_states: ['TX'],
    legal_review_status: 'approved',
    active: true,
    ...over,
  };
}

describe('resolvePriceAnswer', () => {
  it('speaks an exact flat rate with its fee, inclusions and price-changers', () => {
    const a = resolvePriceAnswer(policy('hvac', 'exact_flat'), CTX);
    expect(a.mode_used).toBe('exact_flat');
    expect(a.spoken).toContain('$249');
    expect(a.spoken).toContain('$89 diagnostic fee');
    expect(a.spoken).toContain('credited toward the repair');
    expect(a.spoken).toContain('That includes labor and a 12-month warranty.');
    expect(a.spoken).toContain('can change if we find additional damage');
    expect(a.source_labels.length).toBeGreaterThan(0);
  });

  it('range and starting_at never present a figure as final', () => {
    expect(resolvePriceAnswer(policy('plumbing', 'range'), CTX).spoken).toContain('between $249 and $449');
    const s = resolvePriceAnswer(policy('plumbing', 'starting_at'), CTX).spoken;
    expect(s).toContain('starts at $249');
    expect(s).toContain('can be higher');
  });

  it('diagnostic_fee_only never states a repair price', () => {
    const a = resolvePriceAnswer(policy('electrical', 'diagnostic_fee_only'), CTX);
    expect(a.figures).toHaveLength(1);
    expect(a.figures[0].kind).toBe('diagnostic_fee');
    expect(a.spoken).not.toContain('$249');
    expect(a.spoken).toContain('before any work starts');
  });

  it('does not claim price-before-work unless the business does it', () => {
    const a = resolvePriceAnswer(policy('electrical', 'diagnostic_fee_only', { written_price_before_work: false }), CTX);
    expect(a.spoken).not.toContain('before any work starts');
  });

  it.each([
    ['inactive', { active: false }, 'inactive'],
    ['invalid range', { mode: 'range' as PriceMode, amount_low_cents: 50000, amount_high_cents: 100 }, 'invalid_policy'],
    ['null amount', { amount_low_cents: null }, 'invalid_policy'],
    ['float cents', { amount_low_cents: 249.5 }, 'invalid_policy'],
    ['stale source', { source: { kind: 'owner_entered' as const, price_book_item_id: null, verified_at: '2027-01-01T00:00:00Z' } }, 'stale_source'],
    ['garbage date', { source: { kind: 'owner_entered' as const, price_book_item_id: null, verified_at: 'nope' } }, 'stale_source'],
    ['legal pending', { legal_review_status: 'pending' as const }, 'legal_gate'],
    ['state not approved', { approved_states: ['CA'] }, 'legal_gate'],
  ])('fails closed (%s) with no dollar figure', (_n, over, reason) => {
    const a = resolvePriceAnswer(policy('hvac', 'exact_flat', over), CTX);
    expect(a.mode_used).toBe('needs_visit');
    expect(a.downgraded_reason).toBe(reason);
    expect(a.figures).toHaveLength(0);
    expect(a.spoken).not.toMatch(/\$/);
  });

  it('fails closed when the caller state is unknown', () => {
    const a = resolvePriceAnswer(policy('hvac', 'exact_flat'), { ...CTX, state: null });
    expect(a.downgraded_reason).toBe('region_unknown');
    expect(a.spoken).not.toMatch(/\$/);
  });

  it('formats cents correctly', () => {
    expect(formatCents(24900)).toBe('$249');
    expect(formatCents(24950)).toBe('$249.50');
    expect(formatCents(1234500)).toBe('$12,345');
    expect(formatCents(5)).toBe('$0.05');
  });
});

describe('applyPriceBookAmounts', () => {
  const pb = { ...policy('hvac', 'range'), source: { kind: 'price_book' as const, price_book_item_id: 'x', verified_at: '2028-03-15T00:00:00Z' }, amount_low_cents: null, amount_high_cents: null };
  it('reads live amounts from the catalog item', () => {
    const p = applyPriceBookAmounts(pb, { pricing_model: 'range', price_cents: 10000, price_max_cents: 20000 });
    expect(p.amount_low_cents).toBe(10000);
    expect(p.amount_high_cents).toBe(20000);
  });
  it('refuses hourly rates and missing items (no number to speak)', () => {
    expect(resolvePriceAnswer(applyPriceBookAmounts(pb, { pricing_model: 'hourly', price_cents: 15000, price_max_cents: null }), CTX).mode_used).toBe('needs_visit');
    expect(resolvePriceAnswer(applyPriceBookAmounts(pb, null), CTX).downgraded_reason).toBe('invalid_policy');
  });
  it('leaves owner-entered policies untouched', () => {
    const p = policy('hvac', 'exact_flat');
    expect(applyPriceBookAmounts(p, { pricing_model: 'flat', price_cents: 1, price_max_cents: null })).toBe(p);
  });
});

describe('qualifying questions', () => {
  it('returns at most 3 and skips answered ones', () => {
    const qs = pickQualifyingQuestions('hvac', new Set(['hvac_symptom']), 99);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(qs.map((q) => q.id)).not.toContain('hvac_symptom');
  });
});

describe('objections', () => {
  it('classifies', () => {
    expect(classifyObjection('The chatbot online quoted me way less')).toBe('cheaper_online');
    expect(classifyObjection("I found it cheaper elsewhere")).toBe('cheaper_online');
    expect(classifyObjection("that's too expensive")).toBe('too_expensive');
    expect(classifyObjection("I'm calling around for a few quotes")).toBe('shopping_around');
    expect(classifyObjection("I'm shopping around")).toBe('shopping_around');
    expect(classifyObjection('how long will it take')).toBe('none');
  });
  it('only claims value the business enabled', () => {
    expect(composeValueLine({ licensed_techs: false, warranty_months: null, on_time_guarantee: false })).toBeNull();
    expect(composeValueLine({ licensed_techs: true, warranty_months: null, on_time_guarantee: false })).toBe('What you get with us: licensed technicians.');
    const r = composeObjectionReply('cheaper_online', { licensed_techs: false, warranty_months: null, on_time_guarantee: false }) as string;
    expect(r).not.toContain('What you get');
    expect(r).toContain("can't speak to another company's quote");
  });
  it('returns null for no objection', () => {
    expect(composeObjectionReply('none', VALUE)).toBeNull();
  });
});

describe('next steps', () => {
  const a = resolvePriceAnswer(policy('hvac', 'range'), CTX);
  const base = { remote_estimate_ready: false, has_mobile_number: true, same_day_slot_available: false, human_callback_available: false, financing_min_cents: null };
  it('offers nothing that is not ready', () => {
    expect(buildNextSteps(a, base).steps).toHaveLength(0);
  });
  it('orders remote estimate, same-day, callback', () => {
    const { steps } = buildNextSteps(a, { ...base, remote_estimate_ready: true, same_day_slot_available: true, human_callback_available: true });
    expect(steps.map((s) => s.kind)).toEqual(['remote_estimate', 'same_day_diagnostic', 'human_callback']);
  });
  it('needs a mobile number for the text-a-link step', () => {
    expect(buildNextSteps(a, { ...base, remote_estimate_ready: true, has_mobile_number: false }).steps).toHaveLength(0);
  });
  it('mentions financing only when enabled and above threshold; never quotes payments', () => {
    expect(buildNextSteps(a, { ...base, financing_min_cents: 100000 }).financing_line).toBeNull();
    const f = buildNextSteps(a, { ...base, financing_min_cents: 40000 }).financing_line as string;
    expect(f).toContain('may be available');
    expect(f).not.toMatch(/\$|%|approved|guarantee/i);
    const none = buildNextSteps(resolvePriceAnswer(policy('hvac', 'needs_visit'), CTX), { ...base, financing_min_cents: 1 });
    expect(none.financing_line).toBeNull();
  });
});

describe('auditReply', () => {
  const a = resolvePriceAnswer(policy('hvac', 'exact_flat'), CTX);
  it('flags invented prices, missing fee, disparagement, superlatives, pressure, persona bans', () => {
    expect(auditReply('It is $199.', a, VALUE)).toContain('invented_price');
    expect(auditReply('Our flat rate is $249.', a, VALUE)).toContain('missing_fee_disclosure');
    expect(auditReply('Our flat rate is $249.', a, VALUE, { expect_fee: false })).not.toContain('missing_fee_disclosure');
    expect(auditReply('They are a scam.', a, VALUE)).toContain('disparagement');
    expect(auditReply("We're the cheapest in town.", a, VALUE)).toContain('false_superlative_or_price_match');
    expect(auditReply('Act now, today only!', a, VALUE)).toContain('pressure_tactic');
    expect(auditReply('I understand your frustration.', a, VALUE)).toContain('banned_persona_phrase');
    expect(auditReply('We guarantee it.', a, { licensed_techs: true, warranty_months: null, on_time_guarantee: false })).toContain('unbacked_guarantee');
  });
  it('passes the answer itself', () => {
    expect(auditReply(a.spoken, a, VALUE)).toEqual([]);
  });
});

describe('metrics', () => {
  const ev = (k: string, stage: PriceEvent['stage'], t: number | null = null, at = '2028-04-01T10:00:00Z'): PriceEvent => ({ conversation_key: k, stage, ticket_cents: t, occurred_at: at });
  it('counts a conversation once by its furthest stage', () => {
    const m = summarizePriceConversations(
      [ev('a', 'price_asked'), ev('a', 'answer_given'), ev('a', 'booked', 30000), ev('b', 'price_asked'), ev('b', 'abandoned'), ev('c', 'price_asked'), ev('d', 'price_asked'), ev('d', 'booked', 50000)],
      20,
    );
    expect(m.conversations_with_price_ask).toBe(4);
    expect(m.price_ask_rate).toBe(0.2);
    expect(m.conversion_after_price).toBe(0.5);
    expect(m.abandon_rate).toBe(0.25);
    expect(m.average_ticket_cents).toBe(40000);
  });
  it('returns null (not NaN) with no data', () => {
    const m = summarizePriceConversations([], 0);
    expect(m.price_ask_rate).toBeNull();
    expect(m.conversion_after_price).toBeNull();
    expect(m.average_ticket_cents).toBeNull();
  });
});

describe('composeGuidance', () => {
  const a = resolvePriceAnswer(policy('hvac', 'range'), CTX);
  const ON = { ...DEFAULT_PLAYBOOK_SETTINGS, licensed_techs: true, warranty_months: 12, same_day_diagnostic_enabled: true, human_callback_enabled: true, financing_min_cents: 20000 };
  it('claims nothing the owner has not enabled', () => {
    const g = composeGuidance(a, DEFAULT_PLAYBOOK_SETTINGS, 'voice', true);
    expect(g).not.toContain('What you get');
    expect(g).not.toContain('same-day');
    expect(g).not.toContain('Financing');
    expect(g).not.toContain('estimators');
    expect(g).toContain('Never disparage');
  });
  it('includes value, all three objections, next steps and financing when enabled', () => {
    const g = composeGuidance(a, ON, 'voice', true);
    expect(g).toContain('licensed technicians');
    expect(g).toContain('12-month warranty');
    expect(g).toContain('found it cheaper');
    expect(g).toContain('too expensive');
    expect(g).toContain('shopping around');
    expect(g).toContain('same-day diagnostic');
    expect(g).toContain('availability tool');
    expect(g).toContain('Financing may be available');
  });
  it('never offers a same-day slot on text channels and never offers the text-a-link estimate', () => {
    const g = composeGuidance(a, ON, 'sms', true);
    expect(g).not.toContain('same-day');
    expect(g).not.toContain('text you a link');
  });
  it('contains no dollar amount and no audit violation', () => {
    for (const ch of ['voice', 'sms', 'web'] as const) {
      const g = composeGuidance(a, ON, ch, true);
      expect(g).not.toMatch(/\$/);
      expect(auditReply(g.replace(/Never disparage[^\n]*/g, ''), a, ON, { expect_fee: false })).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario evals: 50 price conversations per trade (250 total).
//   5 modes x 3 channels x 3 objection variants = 45, plus 5 fail-closed degradations.
// Checks: no invented prices, fee disclosure, no disparagement / pressure / banned phrases,
// "allowed answer first", and at most 3 qualifying questions.
// ---------------------------------------------------------------------------
type Scenario = { name: string; p: PricePolicy; channel: Channel; objection: string | null; ctx: ResolveContext };

function scenariosFor(trade: Trade): Scenario[] {
  const out: Scenario[] = [];
  const objections: (string | null)[] = [null, 'I found it cheaper online, a chatbot gave me a quote', "I'm just shopping around"];
  for (const mode of MODES) for (const channel of CHANNELS) for (const objection of objections) {
    out.push({ name: `${trade}/${mode}/${channel}/${objection ? 'objection' : 'plain'}`, p: policy(trade, mode), channel, objection, ctx: CTX });
  }
  const degraded: [string, Partial<PricePolicy>, ResolveContext][] = [
    ['inactive', { active: false }, CTX],
    ['stale', { source: { kind: 'owner_entered', price_book_item_id: null, verified_at: '2026-01-01T00:00:00Z' } }, CTX],
    ['legal_pending', { legal_review_status: 'pending' }, CTX],
    ['state_unapproved', { approved_states: ['CA'] }, CTX],
    ['region_unknown', {}, { ...CTX, state: null }],
  ];
  for (const [n, over, ctx] of degraded) out.push({ name: `${trade}/degraded-${n}`, p: policy(trade, 'exact_flat', over), channel: 'voice', objection: null, ctx });
  return out;
}

describe.each(TRADES)('price conversation evals: %s', (trade) => {
  const list = scenariosFor(trade);
  it('has exactly 50 scenarios', () => expect(list).toHaveLength(50));
  it.each(list.map((s) => [s.name, s] as const))('%s', (_n, s) => {
    const first = composeFirstReply(s.p, s.ctx, s.channel);
    const texts = [first.text];
    if (s.objection) {
      const r = composeObjectionReply(classifyObjection(s.objection), VALUE);
      expect(r).not.toBeNull();
      texts.push(r as string);
    }
    const value = composeValueLine(VALUE);
    if (value) texts.push(value);
    const { steps, financing_line } = buildNextSteps(first.answer, {
      remote_estimate_ready: true, has_mobile_number: true, same_day_slot_available: true, human_callback_available: true, financing_min_cents: 20000,
    });
    texts.push(...steps.map((x) => x.speak));
    if (financing_line) texts.push(financing_line);

    expect(auditReply(first.text, first.answer, VALUE)).toEqual([]);
    for (const t of texts.slice(1)) expect(auditReply(t, first.answer, VALUE, { expect_fee: false })).toEqual([]);
    // allowed answer comes before any question
    expect(first.text.indexOf(first.answer.core_sentence)).toBeGreaterThan(-1);
    if (first.questions.length) expect(first.text.indexOf(first.answer.core_sentence)).toBeLessThan(first.text.indexOf(first.questions[0].text));
    expect(first.questions.length).toBeLessThanOrEqual(3);
    if (s.channel === 'voice') expect(first.questions.length).toBeLessThanOrEqual(1);
    // degraded or needs_visit -> no dollar sign anywhere in the first reply
    if (first.answer.mode_used === 'needs_visit') expect(first.text).not.toMatch(/\$/);
  });
});
