import { describe, it, expect } from 'vitest';
import {
  EMPTY_BALANCE,
  analyzeEquipment,
  applyCallChange,
  buildQuoteSeed,
  buildSignals,
  buildSuggestedScript,
  elapsedLabel,
  formatMoney,
  formatPhone,
  isE164,
  isLiveCall,
  needsRepop,
  phoneKey,
  pruneEnded,
  suggestBookingSlot,
  type DeskCall,
  type LiveCall,
  type PopEquipment,
  type ScreenPopData,
} from './csrScreenPop';

const NOW = Date.parse('2026-10-09T15:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

function call(over: Partial<LiveCall> = {}): LiveCall {
  return {
    id: 'c1',
    caller_phone: '+1 (555) 010-2030',
    caller_name: null,
    call_datetime: ago(1),
    duration_seconds: null,
    is_emergency: false,
    is_voicemail: false,
    human_transfer_requested: false,
    status: 'new_lead',
    sentiment: null,
    summary: null,
    intent: null,
    ...over,
  };
}

function pop(over: Partial<ScreenPopData> = {}): ScreenPopData {
  return {
    matched: true,
    customer: {
      id: 'cu1',
      name: 'Maria Lopez',
      phone: '5550102030',
      email: 'm@example.com',
      address: '12 Oak St',
      customer_type: 'residential',
      lifecycle_stage: 'active',
      tags: [],
      notes: null,
    },
    open_jobs: [],
    recent_jobs: [],
    equipment: [],
    balance: { ...EMPTY_BALANCE },
    open_quotes: [],
    last_conversation: null,
    memory: [],
    history: { total_calls: 3, last_call_at: ago(60 * 24 * 10) },
    ...over,
  };
}

const eq = (over: Partial<PopEquipment> = {}): PopEquipment => ({
  id: 'e1',
  equipment_type: 'furnace',
  make: 'Carrier',
  model: 'X1',
  install_date: '2020-01-01',
  warranty_expires_at: null,
  expected_lifespan_years: 15,
  service_interval_months: 12,
  last_service_date: null,
  ...over,
});

describe('phone helpers', () => {
  it('normalizes to the last 10 digits regardless of formatting', () => {
    expect(phoneKey('+1 (555) 010-2030')).toBe('5550102030');
    expect(phoneKey('555.010.2030')).toBe('5550102030');
    expect(phoneKey('15550102030')).toBe('5550102030');
  });
  it('rejects unusable numbers', () => {
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey('anonymous')).toBeNull();
    expect(phoneKey('12345')).toBeNull();
  });
  it('formats and validates', () => {
    expect(formatPhone('+15550102030')).toBe('(555) 010-2030');
    expect(formatPhone(null)).toBe('Unknown number');
    expect(isE164('+15550102030')).toBe(true);
    expect(isE164('5550102030')).toBe(false);
    expect(formatMoney(123456)).toBe('$1,234.56');
  });
});

describe('isLiveCall', () => {
  it('accepts a fresh call with no duration', () => expect(isLiveCall(call(), NOW)).toBe(true));
  it('rejects finished, voicemail, spam and stale calls', () => {
    expect(isLiveCall(call({ duration_seconds: 30 }), NOW)).toBe(false);
    expect(isLiveCall(call({ is_voicemail: true }), NOW)).toBe(false);
    expect(isLiveCall(call({ status: 'spam' }), NOW)).toBe(false);
    expect(isLiveCall(call({ call_datetime: ago(46) }), NOW)).toBe(false);
  });
});

describe('applyCallChange', () => {
  it('adds a live INSERT and puts emergencies first', () => {
    let list: DeskCall[] = [];
    list = applyCallChange(list, { eventType: 'INSERT', row: call({ id: 'a' }) }, NOW);
    list = applyCallChange(list, { eventType: 'INSERT', row: call({ id: 'b', is_emergency: true, call_datetime: ago(5) }) }, NOW);
    expect(list.map((c) => c.id)).toEqual(['b', 'a']);
  });
  it('upserts without duplicating', () => {
    let list = applyCallChange([], { eventType: 'INSERT', row: call() }, NOW);
    list = applyCallChange(list, { eventType: 'UPDATE', row: call({ caller_name: 'Maria' }) }, NOW);
    expect(list).toHaveLength(1);
    expect(list[0].caller_name).toBe('Maria');
  });
  it('marks a known call ended (kept for wrap-up) and ignores unknown finished calls', () => {
    let list = applyCallChange([], { eventType: 'INSERT', row: call() }, NOW);
    list = applyCallChange(list, { eventType: 'UPDATE', row: call({ duration_seconds: 120 }) }, NOW);
    expect(list[0].ended).toBe(true);
    const untouched = applyCallChange([], { eventType: 'UPDATE', row: call({ id: 'zz', duration_seconds: 9 }) }, NOW);
    expect(untouched).toHaveLength(0);
  });
  it('removes on DELETE and prunes ended calls after retention', () => {
    let list = applyCallChange([], { eventType: 'INSERT', row: call() }, NOW);
    expect(applyCallChange(list, { eventType: 'DELETE', row: null, oldId: 'c1' }, NOW)).toHaveLength(0);
    list = applyCallChange(list, { eventType: 'UPDATE', row: call({ duration_seconds: 60 }) }, NOW);
    expect(pruneEnded(list, NOW + 5 * 60_000)).toHaveLength(1);
    expect(pruneEnded(list, NOW + 11 * 60_000)).toHaveLength(0);
  });
});

describe('needsRepop', () => {
  it('re-pops only when identity-relevant fields change', () => {
    expect(needsRepop(undefined, call())).toBe(true);
    expect(needsRepop(call(), call())).toBe(false);
    expect(needsRepop(call(), call({ caller_name: 'Maria' }))).toBe(true);
    expect(needsRepop(call(), call({ is_emergency: true }))).toBe(true);
  });
});

describe('analyzeEquipment', () => {
  it('detects warranty states', () => {
    expect(analyzeEquipment(eq({ warranty_expires_at: '2027-06-01' }), NOW).warranty).toBe('active');
    expect(analyzeEquipment(eq({ warranty_expires_at: '2026-11-01' }), NOW).warranty).toBe('expiring');
    expect(analyzeEquipment(eq({ warranty_expires_at: '2026-01-01' }), NOW).warranty).toBe('expired');
    expect(analyzeEquipment(eq(), NOW).warranty).toBe('none');
  });
  it('flags overdue service and end-of-life', () => {
    expect(analyzeEquipment(eq({ last_service_date: '2024-01-01' }), NOW).serviceDue).toBe('overdue');
    expect(analyzeEquipment(eq({ last_service_date: '2026-09-01' }), NOW).serviceDue).toBe('ok');
    expect(analyzeEquipment(eq({ install_date: '2010-01-01' }), NOW).nearEndOfLife).toBe(true);
    expect(analyzeEquipment(eq({ install_date: '2025-01-01' }), NOW).nearEndOfLife).toBe(false);
  });
});

describe('buildSignals', () => {
  it('surfaces critical flags first-class', () => {
    const s = buildSignals(call({ is_emergency: true, human_transfer_requested: true }), pop(), NOW);
    expect(s.map((x) => x.key)).toEqual(expect.arrayContaining(['emergency', 'human']));
  });
  it('reports overdue balance, warranty and unresolved objections', () => {
    const s = buildSignals(
      call(),
      pop({
        balance: { outstanding_cents: 50000, overdue_cents: 20000, open_invoice_count: 2, oldest_due_date: '2026-09-01' },
        equipment: [eq({ warranty_expires_at: '2027-06-01' })],
        last_conversation: {
          call_id: 'c0', call_datetime: ago(9999), summary: 's', sentiment: 'negative', intent: null,
          recommended_follow_up: null, objections_raised: ['price'], objections_resolved: false, duration_seconds: 90,
        },
      }),
      NOW
    );
    const keys = s.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['overdue', 'warranty', 'neg_last', 'objection']));
    expect(s.find((x) => x.key === 'overdue')?.label).toBe('$200.00 overdue');
  });
  it('marks unmatched callers as new', () => {
    expect(buildSignals(call(), pop({ matched: false, customer: null }), NOW)[0].key).toBe('new_caller');
  });
});

describe('buildSuggestedScript', () => {
  it('emergency overrides everything and routes to transfer, never mentioning money', () => {
    const sc = buildSuggestedScript(
      call({ is_emergency: true }),
      pop({ balance: { outstanding_cents: 9900, overdue_cents: 9900, open_invoice_count: 1, oldest_due_date: null } }),
      NOW
    );
    expect(sc.primaryAction).toBe('transfer');
    expect(sc.steps.join(' ')).not.toContain('$99');
  });
  it('caller asked for a person → transfer', () => {
    expect(buildSuggestedScript(call({ human_transfer_requested: true }), pop(), NOW).primaryAction).toBe('transfer');
  });
  it('technician en route → status script with the ETA from the job only', () => {
    const sc = buildSuggestedScript(
      call(),
      pop({ open_jobs: [{ id: 'j', service_type: 'AC', job_status: 'en_route', scheduled_datetime: null, address: null, eta_minutes: 25, warranty_expires_at: null, completed_at: null }] }),
      NOW
    );
    expect(sc.primaryAction).toBe('none');
    expect(sc.opener).toContain('25 minutes');
  });
  it('negative last call → recovery before selling', () => {
    const sc = buildSuggestedScript(
      call(),
      pop({ last_conversation: { call_id: 'c0', call_datetime: ago(5), summary: 'Waited 3 days', sentiment: 'negative', intent: null, recommended_follow_up: null, objections_raised: [], objections_resolved: null, duration_seconds: 10 } }),
      NOW
    );
    expect(sc.headline).toBe('Recover the last conversation');
    expect(sc.steps[0]).toContain('Waited 3 days');
  });
  it('open sent quote → closes the loop with the real amount', () => {
    const sc = buildSuggestedScript(call(), pop({ open_quotes: [{ id: 'q', status: 'sent', total_cents: 125000, sent_at: null, ai_detected_issue: null }] }), NOW);
    expect(sc.opener).toContain('$1,250.00');
    expect(sc.primaryAction).toBe('book');
  });
  it('new caller → capture basics; returning → greets by first name', () => {
    expect(buildSuggestedScript(call(), pop({ matched: false, customer: null }), NOW).headline).toContain('New caller');
    expect(buildSuggestedScript(call(), pop(), NOW).opener).toContain('Hi Maria');
  });
  it('never invents history for an unknown caller', () => {
    const sc = buildSuggestedScript(call(), pop({ matched: false, customer: null }), NOW);
    expect(sc.opener).not.toContain('welcome back');
  });
});

describe('one-click helpers', () => {
  it('suggests a business-hour slot on a weekday, skipping weekends', () => {
    const fri = new Date(2026, 9, 9, 16, 30); // Fri 16:30 local → +2h = 18:30 → next business day 09:00 (Mon)
    const slot = suggestBookingSlot(fri, false);
    expect(slot.getDay()).toBe(1);
    expect(slot.getHours()).toBe(9);
  });
  it('emergency slot is within ~45 minutes and quarter-hour aligned', () => {
    const now = new Date(2026, 9, 9, 22, 7);
    const slot = suggestBookingSlot(now, true);
    expect(slot.getMinutes() % 15).toBe(0);
    expect(slot.getTime() - now.getTime()).toBeLessThanOrEqual(45 * 60_000);
  });
  it('seeds a quote from the call without inventing prices', () => {
    const seed = buildQuoteSeed(call({ summary: 'No heat', intent: 'Furnace repair' }), pop());
    expect(seed.customer_name).toBe('Maria Lopez');
    expect(seed.line_items[0].unit_price_cents).toBe(0);
    expect(seed.ai_detected_issue).toBe('No heat');
  });
  it('formats elapsed time', () => {
    expect(elapsedLabel(ago(2.5), NOW)).toBe('02:30');
  });
});
