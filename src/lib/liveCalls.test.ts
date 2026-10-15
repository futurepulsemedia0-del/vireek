import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIGNALS,
  MAX_RECENT_SHOWN,
  RECENT_ENDED_MS,
  STALE_AFTER_MS,
  applyCallerLine,
  detectLiveIntent,
  detectWantsHuman,
  formatElapsed,
  isStale,
  isValidE164,
  maskNumber,
  mergeLines,
  parseLiveEvent,
  partitionLiveCalls,
  previewOf,
  priorityScore,
  removeById,
  sentimentFromScore,
  upsertById,
  type LiveCallFacts,
} from '../../supabase/functions/_shared/live-calls/logic';

const NOW = Date.parse('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const call = (over: Partial<LiveCallFacts> & { id?: string } = {}): LiveCallFacts & { id: string } => ({
  id: 'c1',
  status: 'in_progress',
  started_at: ago(60_000),
  ended_at: null,
  is_emergency: false,
  wants_human: false,
  human_transfer_requested: false,
  sentiment: 'neutral',
  ...over,
});

describe('parseLiveEvent', () => {
  it('maps status updates', () => {
    expect(parseLiveEvent({ type: 'status-update', status: 'ringing' })).toEqual({ kind: 'status', status: 'ringing', endedReason: null });
    expect(parseLiveEvent({ type: 'status-update', status: 'in-progress' })).toEqual({ kind: 'status', status: 'in_progress', endedReason: null });
    expect(parseLiveEvent({ type: 'status-update', status: 'ended', endedReason: 'customer-hung-up' })).toEqual({
      kind: 'status',
      status: 'ended',
      endedReason: 'customer-hung-up',
    });
    expect(parseLiveEvent({ type: 'status-update', status: 'weird' })).toBeNull();
  });

  it('treats end-of-call-report as ended but never "hang"', () => {
    expect(parseLiveEvent({ type: 'end-of-call-report' })).toEqual({ kind: 'status', status: 'ended', endedReason: null });
    expect(parseLiveEvent({ type: 'hang' })).toBeNull();
  });

  it('keeps only FINAL transcript lines with a known role', () => {
    expect(parseLiveEvent({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: '  my  AC is broken ' })).toEqual({
      kind: 'line',
      role: 'caller',
      text: 'my AC is broken',
    });
    expect(parseLiveEvent({ type: 'transcript', role: 'assistant', transcriptType: 'final', transcript: 'Sure.' })).toEqual({
      kind: 'line',
      role: 'assistant',
      text: 'Sure.',
    });
    expect(parseLiveEvent({ type: 'transcript', role: 'user', transcriptType: 'partial', transcript: 'my AC' })).toBeNull();
    expect(parseLiveEvent({ type: 'transcript', role: 'system', transcriptType: 'final', transcript: 'x' })).toBeNull();
    expect(parseLiveEvent({ type: 'transcript', role: 'user', transcriptType: 'final', transcript: '   ' })).toBeNull();
    expect(parseLiveEvent({ type: 'conversation-update' })).toBeNull();
  });
});

describe('live signals', () => {
  it('detects intent, defaulting to new_inquiry and null when silent', () => {
    expect(detectLiveIntent('I smell gas in my kitchen')).toBe('emergency');
    expect(detectLiveIntent('how much for a new water heater')).toBe('price_quote');
    expect(detectLiveIntent('I need to reschedule tomorrow')).toBe('reschedule_cancel');
    expect(detectLiveIntent('I want to file a complaint')).toBe('complaint');
    expect(detectLiveIntent('my furnace is making a noise')).toBe('new_inquiry');
    expect(detectLiveIntent('   ')).toBeNull();
  });

  it('detects a request for a person without over-triggering on "manager"', () => {
    expect(detectWantsHuman('can I talk to a real person')).toBe(true);
    expect(detectWantsHuman('let me speak with a supervisor')).toBe(true);
    expect(detectWantsHuman("I'm the property manager at the address")).toBe(false);
  });

  it('moves sentiment negative on angry lines and recovers on calm ones', () => {
    let s = applyCallerLine(EMPTY_SIGNALS, 'This is unacceptable, I want a refund');
    expect(sentimentFromScore(s.sentiment_score)).toBe('negative');
    for (let i = 0; i < 6; i++) s = applyCallerLine(s, 'okay thanks, that works great');
    expect(sentimentFromScore(s.sentiment_score)).not.toBe('negative');
  });

  it('keeps the wants_human flag once set and caps the signal window', () => {
    let s = applyCallerLine(EMPTY_SIGNALS, 'get me a real person');
    expect(s.wants_human).toBe(true);
    s = applyCallerLine(s, 'x'.repeat(2000));
    expect(s.wants_human).toBe(true);
    expect(s.signal_text.length).toBeLessThanOrEqual(600);
  });

  it('truncates previews with an ellipsis', () => {
    expect(previewOf('short')).toBe('short');
    expect(previewOf('a'.repeat(300)).endsWith('…')).toBe(true);
  });
});

describe('board ordering', () => {
  it('ranks emergency > wants a human > negative, then oldest first', () => {
    expect(priorityScore(call({ is_emergency: true }))).toBeGreaterThan(priorityScore(call({ wants_human: true })));
    expect(priorityScore(call({ wants_human: true }))).toBeGreaterThan(priorityScore(call({ sentiment: 'negative' })));

    const { active } = partitionLiveCalls(
      [
        call({ id: 'old', started_at: ago(600_000) }),
        call({ id: 'new', started_at: ago(10_000) }),
        call({ id: 'emerg', is_emergency: true, started_at: ago(5_000) }),
      ],
      NOW,
    );
    expect(active.map((c) => c.id)).toEqual(['emerg', 'old', 'new']);
  });

  it('hides stale "live" rows and old ended calls, caps the recent list', () => {
    expect(isStale(call({ started_at: ago(STALE_AFTER_MS + 1000) }), NOW)).toBe(true);
    expect(isStale(call({ status: 'ended', started_at: ago(STALE_AFTER_MS * 2) }), NOW)).toBe(false);

    const rows = [
      call({ id: 'stale', started_at: ago(STALE_AFTER_MS + 5000) }),
      call({ id: 'fresh-ended', status: 'ended', ended_at: ago(60_000) }),
      call({ id: 'old-ended', status: 'ended', ended_at: ago(RECENT_ENDED_MS + 60_000) }),
      ...Array.from({ length: 15 }, (_, i) => call({ id: `e${i}`, status: 'ended', ended_at: ago(1000 * (i + 1)) })),
    ];
    const { active, recent } = partitionLiveCalls(rows, NOW);
    expect(active).toHaveLength(0);
    expect(recent.some((c) => c.id === 'old-ended')).toBe(false);
    expect(recent).toHaveLength(MAX_RECENT_SHOWN);
    expect(recent[0].ended_at && Date.parse(recent[0].ended_at)).toBeGreaterThan(Date.parse(recent[1].ended_at as string));
  });
});

describe('realtime merging', () => {
  it('upserts and removes rows by id', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 1 };
    expect(upsertById([a], b).map((r) => r.id)).toEqual(['b', 'a']);
    expect(upsertById([a, b], { id: 'a', v: 2 }).find((r) => r.id === 'a')?.v).toBe(2);
    expect(removeById([a, b], 'a')).toEqual([b]);
  });

  it('merges transcript lines without duplicates, in order, capped to the newest', () => {
    const l = (id: number) => ({ id, text: `t${id}` });
    expect(mergeLines([l(1), l(3)], [l(2), l(3)]).map((x) => x.id)).toEqual([1, 2, 3]);
    expect(mergeLines([l(1), l(2), l(3), l(4)], [], 2).map((x) => x.id)).toEqual([3, 4]);
  });
});

describe('formatting + hand-off safety', () => {
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_000)).toBe('1:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatElapsed(-500)).toBe('0:00');
  });

  it('only accepts E.164 numbers and masks them', () => {
    expect(isValidE164('+15551234567')).toBe(true);
    expect(isValidE164('5551234567')).toBe(false);
    expect(isValidE164('+0123456789')).toBe(false);
    expect(isValidE164(null)).toBe(false);
    expect(maskNumber('+15551234567')).toBe('••••4567');
  });
});
