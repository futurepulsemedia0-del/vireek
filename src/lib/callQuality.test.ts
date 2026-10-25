import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  MIN_TREND_SAMPLE,
  buildDeterministicFindings,
  buildKbArticle,
  buildReviewTranscript,
  cleanPatterns,
  computeScores,
  computeTrend,
  detectContext,
  evaluateCompliance,
  gradeOf,
  isReviewable,
  mergeScriptAddition,
  normalizeText,
  parseAiReview,
  splitTurns,
  verifyEvidence,
  weeklySeries,
  type CallFactsForQuality,
  type ComplianceRule,
  type ScoredPoint,
} from '../../supabase/functions/_shared/call-quality/logic';

const rules: ComplianceRule[] = DEFAULT_RULES.map((r, i) => ({ ...r, id: `r${i}`, enabled: true }));
const facts = (over: Partial<CallFactsForQuality> = {}): CallFactsForQuality => ({
  is_emergency: false, status: 'new_lead', intent: null, sentiment: 'neutral', call_score: null, lead_score: null,
  booking_outcome: null, missed_opportunity_reason: null, upsell_opportunities: [], price_accuracy_status: null,
  price_accuracy_details: [], feedback_rating: null, ...over,
});

const TRANSCRIPT = [
  'AI: Hi, this is Sarah, the AI assistant for Cool Air. This call may be recorded for quality.',
  'User: My AC stopped working, how much is a repair?',
  'AI: A repair is usually $89 for the diagnostic. Would you like me to book a technician?',
  'User: Not right now, thanks.',
].join('\n');

describe('splitTurns', () => {
  it('splits speaker lines and joins continuation lines', () => {
    const t = splitTurns('AI: Hello there\nhow can I help\nUser: Hi');
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ role: 'agent', text: 'Hello there how can I help' });
    expect(t[1].role).toBe('caller');
  });
  it('recognises the caller by name and ignores field-like labels', () => {
    const t = splitTurns('AI: Name?\nJohn: I am John\nAddress: 12 Oak St', 'John Smith');
    expect(t.map((x) => x.role)).toEqual(['agent', 'caller']);
    expect(t[1].text).toContain('12 Oak St');
  });
  it('returns [] for empty input and one unknown turn for unlabeled text', () => {
    expect(splitTurns('  ')).toEqual([]);
    expect(splitTurns(null)).toEqual([]);
    expect(splitTurns('just words')[0].role).toBe('unknown');
  });
});

describe('isReviewable', () => {
  it('needs enough text and both speakers', () => {
    expect(isReviewable('AI: hi\nUser: hi')).toBe(false);
    expect(isReviewable(TRANSCRIPT.repeat(2))).toBe(true);
    expect(isReviewable('x'.repeat(400))).toBe(false);
  });
});

describe('compliance', () => {
  const turns = splitTurns(TRANSCRIPT);
  const ctx = detectContext(turns, { is_emergency: false, booking_outcome: null, status: 'new_lead' });

  it('detects context from the conversation', () => {
    expect(ctx.pricingDiscussed).toBe(true);
    expect(ctx.bookingDiscussed).toBe(true);
    expect(ctx.isEmergency).toBe(false);
  });

  it('passes required phrases said by the agent and skips non-applicable rules', () => {
    const res = evaluateCompliance(turns, ctx, rules);
    const by = Object.fromEntries(res.map((r) => [r.label, r.status]));
    expect(by['Call recording notice']).toBe('pass');
    expect(by['AI disclosure']).toBe('pass');
    expect(by['Emergency safety advice']).toBe('na');
    expect(by['No claiming to be human']).toBe('pass');
  });

  it('fails a required phrase that only the CALLER said', () => {
    const t = splitTurns('AI: Hello, how can I help?\nUser: this call may be recorded right?\nAI: Sure.\nUser: ok');
    const res = evaluateCompliance(t, ctx, rules.filter((r) => r.label === 'Call recording notice'));
    expect(res[0].status).toBe('fail');
  });

  it('fails a forbidden phrase and returns the quote and turn', () => {
    const t = splitTurns("AI: Don't worry, I'm a real person.\nUser: really?");
    const res = evaluateCompliance(t, ctx, rules.filter((r) => r.label === 'No claiming to be human'));
    expect(res[0]).toMatchObject({ status: 'fail', turn_index: 0 });
    expect(res[0].quote).toContain('real person');
  });

  it('requires emergency advice only on emergency calls', () => {
    const t = splitTurns('AI: Sarah here.\nUser: I smell gas in my kitchen\nAI: We will send someone.\nUser: ok');
    const e = detectContext(t, { is_emergency: true, booking_outcome: null, status: 'new_lead' });
    const res = evaluateCompliance(t, e, rules.filter((r) => r.label === 'Emergency safety advice'));
    expect(res[0]).toMatchObject({ status: 'fail', severity: 'critical' });
  });

  it('is "unknown", never a false failure, when speakers cannot be told apart', () => {
    const res = evaluateCompliance(splitTurns('just a blob of text'), ctx, rules);
    expect(res.filter((r) => r.status === 'fail')).toHaveLength(0);
    expect(res.some((r) => r.status === 'unknown')).toBe(true);
  });

  it('skips disabled rules and cleans owner patterns safely', () => {
    expect(evaluateCompliance(turns, ctx, [{ ...rules[0], enabled: false }])).toEqual([]);
    expect(cleanPatterns(['  May BE Recorded! ', 'ab', '(.*)+$', 5, 'may be recorded'])).toEqual(['may be recorded']);
  });
});

describe('buildDeterministicFindings', () => {
  it('turns compliance failures into findings with a script fix', () => {
    const rule = rules.find((r) => r.label === 'Call recording notice')!;
    const f = buildDeterministicFindings(facts(), [{ rule_id: rule.id, label: rule.label, status: 'fail', severity: 'medium', turn_index: null, quote: null }], rules, 'new_inquiry');
    expect(f[0]).toMatchObject({ kind: 'compliance_miss', fingerprint: `compliance:${rule.id}` });
    expect(f[0].fix?.type).toBe('script_patch');
  });

  it('reuses price mismatches, missed bookings and upsells from call intelligence', () => {
    const f = buildDeterministicFindings(
      facts({
        booking_outcome: 'not_booked', missed_opportunity_reason: 'Caller asked for Friday; no slot was offered', lead_score: 85,
        upsell_opportunities: ['annual maintenance plan', 'smart thermostat', 'third one'],
        price_accuracy_status: 'mismatch',
        price_accuracy_details: [{ stated_cents: 8900, context_snippet: 'usually $89', closest_catalog_match: { service_name: 'Diagnostic', price_cents: 12900 } }],
      }),
      [], rules, 'price_quote');
    const kinds = f.map((x) => x.kind);
    expect(kinds).toEqual(['price_error', 'missed_booking', 'missed_upsell', 'missed_upsell']);
    expect(f[0].detail).toContain('$129');
    expect(f[1].severity).toBe('high');
  });

  it('flags nothing for a clean call', () => {
    expect(buildDeterministicFindings(facts({ booking_outcome: 'booked' }), [], rules, 'new_inquiry')).toEqual([]);
  });
});

describe('verifyEvidence / parseAiReview', () => {
  const turns = splitTurns(TRANSCRIPT);
  it('verifies quotes against the right speaker only', () => {
    expect(verifyEvidence(turns, 'A repair is usually $89 for the diagnostic', ['agent'])).toBe(true);
    expect(verifyEvidence(turns, 'A repair is usually $89 for the diagnostic', ['caller'])).toBe(false);
    expect(verifyEvidence(turns, 'short', ['agent'])).toBe(false);
  });

  const ai = (findings: unknown[]) => JSON.stringify({ summary: 'ok', findings });

  it('keeps verified hallucinations and drops invented quotes', () => {
    const r = parseAiReview(ai([
      { kind: 'hallucination', severity: 'high', title: 'Invented price', detail: 'x', evidence_quote: 'A repair is usually $89 for the diagnostic' },
      { kind: 'hallucination', severity: 'high', title: 'Made up', detail: 'x', evidence_quote: 'We offer free lifetime repairs for everyone' },
    ]), turns, 'new_inquiry')!;
    expect(r.findings).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.findings[0].turn_index).toBe(2);
  });

  it('forces the owner to supply facts for KB fixes and rejects money in script patches', () => {
    const r = parseAiReview(ai([
      { kind: 'knowledge_gap', severity: 'medium', title: 'Diagnostic fee unknown', detail: 'd', evidence_quote: 'how much is a repair', fix: { type: 'kb_article', title: 'Diagnostic fee', question: 'What is the diagnostic fee?', keywords: ['fee'] } },
      { kind: 'missed_booking', severity: 'medium', title: 'No booking offer', detail: 'd', fix: { type: 'script_patch', scenario: 'price_quote', addition: 'Quote $49 for every visit always.' } },
    ]), turns, 'new_inquiry')!;
    expect(r.findings[0].fix).toMatchObject({ type: 'kb_article', requires_answer: true });
    expect(r.findings[1].fix).toBeNull();
    expect(r.findings[1].fingerprint).toBe('booking:missed');
  });

  it('falls back to the call scenario for a bad scenario key and survives garbage', () => {
    const r = parseAiReview('```json\n' + ai([{ kind: 'missed_booking', severity: 'zzz', title: 'T', detail: '', fix: { type: 'script_patch', scenario: 'nope', addition: 'Always offer the next open appointment.' } }]) + '\n```', turns, 'complaint')!;
    expect(r.findings[0].severity).toBe('medium');
    expect(r.findings[0].fix?.scenario).toBe('complaint');
    expect(parseAiReview('not json at all', turns, 'complaint')).toBeNull();
    expect(parseAiReview('{"findings": "x"}', turns, 'complaint')!.findings).toEqual([]);
  });
});

describe('computeScores / gradeOf', () => {
  it('scores a perfect booked call 100', () => {
    const s = computeScores({ facts: facts({ booking_outcome: 'booked', sentiment: 'positive', feedback_rating: 5 }), findings: [], compliance: [{ rule_id: 'a', label: 'a', status: 'pass', severity: 'medium', turn_index: 0, quote: null }], aiOk: true });
    expect(s).toMatchObject({ accuracy: 100, compliance: 100, booking: 100, upsell: 100 });
    expect(s.overall).toBeGreaterThanOrEqual(95);
  });

  it('penalises findings by severity and weights failed compliance', () => {
    const s = computeScores({
      facts: facts({ booking_outcome: 'not_booked', missed_opportunity_reason: 'x', upsell_opportunities: ['a', 'b'] }),
      findings: [{ kind: 'hallucination', severity: 'high' }, { kind: 'price_error', severity: 'high' }],
      compliance: [
        { rule_id: 'a', label: 'a', status: 'fail', severity: 'critical', turn_index: null, quote: null },
        { rule_id: 'b', label: 'b', status: 'pass', severity: 'low', turn_index: 1, quote: null },
        { rule_id: 'c', label: 'c', status: 'na', severity: 'low', turn_index: null, quote: null },
      ],
      aiOk: true,
    });
    expect(s.accuracy).toBe(30);
    expect(s.compliance).toBe(20);
    expect(s.booking).toBe(25);
    expect(s.upsell).toBe(40);
    expect(s.overall).toBeLessThan(50);
  });

  it('leaves unassessable dimensions null and renormalises', () => {
    const s = computeScores({ facts: facts({ sentiment: null }), findings: [], compliance: [], aiOk: false });
    expect(s).toMatchObject({ accuracy: null, compliance: null, booking: null, upsell: null, experience: null, overall: null });
    const s2 = computeScores({ facts: facts({ booking_outcome: 'booked', sentiment: null }), findings: [], compliance: [], aiOk: false });
    expect(s2.overall).toBe(100);
  });

  it('blends the customer rating into experience', () => {
    const lo = computeScores({ facts: facts({ feedback_rating: 1, sentiment: 'positive' }), findings: [], compliance: [], aiOk: false });
    const hi = computeScores({ facts: facts({ feedback_rating: 5, sentiment: 'positive' }), findings: [], compliance: [], aiOk: false });
    expect(lo.experience!).toBeLessThan(hi.experience!);
  });

  it('maps grades', () => {
    expect([95, 85, 75, 65, 10].map(gradeOf)).toEqual(['A', 'B', 'C', 'D', 'F']);
    expect(gradeOf(null)).toBeNull();
  });
});

describe('trend vs baseline', () => {
  const NOW = Date.parse('2027-03-15T12:00:00Z');
  const day = 86_400_000;
  const pt = (daysAgo: number, overall: number): ScoredPoint => ({ at: new Date(NOW - daysAgo * day).toISOString(), overall, accuracy: overall, compliance: null, booking: null, experience: null, upsell: null });

  it('reports a reliable delta only with enough reviews in both windows', () => {
    const pts = [...Array(MIN_TREND_SAMPLE).fill(0).map((_, i) => pt(i + 1, 90)), ...Array(MIN_TREND_SAMPLE).fill(0).map((_, i) => pt(20 + i, 70))];
    const t = computeTrend(pts, NOW);
    expect(t.overall).toMatchObject({ current: 90, baseline: 70, delta: 20, reliable: true, direction: 'up' });
    expect(t.compliance.reliable).toBe(false);
  });

  it('hides the delta when a window is thin and marks small moves flat', () => {
    expect(computeTrend([pt(1, 90), pt(30, 70)], NOW).overall.delta).toBeNull();
    const pts = [...Array(6).fill(0).map((_, i) => pt(i + 1, 80)), ...Array(6).fill(0).map((_, i) => pt(20 + i, 79))];
    expect(computeTrend(pts, NOW).overall.direction).toBe('flat');
  });

  it('builds a 12-week series with gaps', () => {
    const s = weeklySeries([pt(1, 80), pt(2, 60)], NOW);
    expect(s).toHaveLength(12);
    expect(s[10]).toMatchObject({ avg: 70, n: 2 });
    expect(s[11].avg).toBeNull();
    expect(s[0]).toMatchObject({ avg: null, n: 0 });
  });
});

describe('fix helpers', () => {
  it('appends guidance once and respects the 2500-char cap', () => {
    const base = 'Greet warmly and collect the address.';
    const add = 'Always offer the next open appointment.';
    const r = mergeScriptAddition(base, add);
    expect(r).toMatchObject({ ok: true, changed: true });
    expect(r.ok && r.body).toBe(`${base}\n\n${add}`);
    const again = mergeScriptAddition(`${base}\n\n${add}`, add);
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(mergeScriptAddition('x'.repeat(2490), add).ok).toBe(false);
    expect(mergeScriptAddition(base, 'short').ok).toBe(false);
  });

  it('neutralises template braces in additions', () => {
    const r = mergeScriptAddition('Base script text here ok.', 'Say {{name}} nicely to the caller.');
    expect(r.ok && r.body).not.toContain('{{');
  });

  it('builds a KB article only from the owner answer', () => {
    expect(buildKbArticle({ title: 'Diagnostic fee', question: 'q' }, 'short').ok).toBe(false);
    const r = buildKbArticle({ title: 'Diagnostic fee', question: 'q', keywords: ['fee'] }, 'The diagnostic fee is $129, credited toward any repair.');
    expect(r).toMatchObject({ ok: true, title: 'Diagnostic fee' });
  });
});

describe('transcript budget', () => {
  it('keeps the opening and the end when a call is very long', () => {
    const long = Array.from({ length: 120 }, (_, i) => `${i % 2 ? 'User' : 'AI'}: line number ${i} ${'blah '.repeat(30)}`).join('\n');
    const out = buildReviewTranscript(splitTurns(long));
    expect(out.length).toBeLessThanOrEqual(3700);
    expect(out).toContain('[0]');
    expect(out).toContain('[119]');
  });
  it('normalizes curly quotes and punctuation', () => {
    expect(normalizeText('I’m  a REAL person!')).toBe('im a real person');
  });
});
