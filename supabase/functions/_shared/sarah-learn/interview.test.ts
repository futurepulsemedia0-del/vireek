import { describe, it, expect } from 'vitest';
import { MAX_INTERVIEW_QUESTIONS, QUESTION_BANK, SKIP_TOKENS, isGap, nextQuestion, planInterview, questionText, type InterviewState, type KnownField } from './interview';
import { classifyEmergencyMode, ownerAnswerField } from './schema';

const kf = (key: string, o: Partial<KnownField> = {}): KnownField => ({ key, confidence: 'high', assumed: false, status: 'pending', hasValue: true, ...o });

/** Simulates an owner persona answering until the planner is done. */
function runInterview(known: KnownField[], answers: Record<string, string>) {
  const state: InterviewState = { asked: [] };
  const asked: string[] = [];
  const fields: Record<string, unknown> = {};
  for (let guard = 0; guard < 20; guard++) {
    const q = nextQuestion(known, state);
    if (!q) break;
    asked.push(q.id);
    const ans = answers[q.id] ?? 'skip';
    state.asked.push(q.id);
    if (SKIP_TOKENS.test(ans)) continue;
    const f = ownerAnswerField(q.key, ans);
    expect(f).not.toBeNull();
    if (f) {
      fields[q.key] = f.value;
      const i = known.findIndex((k) => k.key === q.key);
      const entry = kf(q.key, { status: f.sensitive ? 'pending' : 'approved' });
      if (i >= 0) known[i] = entry;
      else known.push(entry);
    }
  }
  return { asked, fields };
}

describe('interview planner', () => {
  it('asks nothing when every item is already high-confidence and approved', () => {
    const known = QUESTION_BANK.map((q) => kf(q.key, { status: 'approved' }));
    expect(planInterview(known, { asked: [] })).toHaveLength(0);
  });

  it('asks only about gaps and low-confidence items, in priority order', () => {
    const known = [kf('emergency_policy', { confidence: 'low', assumed: true }), kf('never_book', { status: 'approved' }), kf('service_area_notes', { status: 'approved' }), kf('diagnostic_fee', { status: 'approved' }), kf('escalation_contact', { status: 'approved' }), kf('brand_pronunciation', { status: 'approved' })];
    const plan = planInterview(known, { asked: [] });
    expect(plan.map((q) => q.id)).toEqual(['emergency', 'style']);
  });

  it('never repeats a question and respects the cap', () => {
    const { asked } = runInterview([], {});
    expect(new Set(asked).size).toBe(asked.length);
    expect(asked.length).toBeLessThanOrEqual(MAX_INTERVIEW_QUESTIONS);
  });

  it('a sensitive but medium-confidence website claim is still asked about', () => {
    expect(isGap(kf('diagnostic_fee', { confidence: 'medium', status: 'pending' }), 'diagnostic_fee')).toBe(true);
    expect(isGap(kf('diagnostic_fee', { confidence: 'medium', status: 'approved' }), 'diagnostic_fee')).toBe(false);
    expect(isGap(kf('diagnostic_fee', { status: 'edited' }), 'diagnostic_fee')).toBe(false);
  });

  it('owner persona 1: decisive owner answers everything', () => {
    const { asked, fields } = runInterview([], {
      emergency: 'We take emergency calls any time and charge a premium rate.',
      never_book: 'commercial rooftop units, mold remediation',
      area_edge: 'Up to 10 miles past the city line for an extra $50',
      trip_fee: 'Our trip fee is $89, applied to the repair',
      escalation: 'Call Mike at the office line, text me after 9pm',
      pronounce: 'Kee-stone, like the state',
      style: 'Warm and conversational',
    });
    expect(asked).toHaveLength(7);
    expect(fields.emergency_policy).toEqual({ mode: 'yes_premium', note: 'We take emergency calls any time and charge a premium rate.' });
    expect(fields.never_book).toEqual(['commercial rooftop units', 'mold remediation']);
  });

  it('owner persona 2: skips most questions, only answers emergency', () => {
    const { asked, fields } = runInterview([], { emergency: 'No, we do not do emergency calls outside business hours.' });
    expect(asked.length).toBeGreaterThan(0);
    expect(Object.keys(fields)).toEqual(['emergency_policy']);
    expect((fields.emergency_policy as { mode: string }).mode).toBe('business_hours_only');
  });

  it('owner persona 3: Spanish speaker gets Spanish questions and Spanish skip tokens work', () => {
    const q = QUESTION_BANK[0];
    expect(questionText(q, 'es')).toMatch(/emergencia/);
    expect(SKIP_TOKENS.test('omitir')).toBe(true);
    expect(SKIP_TOKENS.test('No sé')).toBe(true);
    expect(classifyEmergencyMode('Sí, mismo precio a cualquier hora')).toBe('yes_same_rate');
    expect(classifyEmergencyMode('Cobramos recargo de emergencia')).toBe('yes_premium');
  });

  it('emergency classification handles tricky phrasings', () => {
    expect(classifyEmergencyMode('Yes, same rate, no extra charge for emergencies')).toBe('yes_same_rate');
    expect(classifyEmergencyMode('We take emergency calls any time at the same rate.')).toBe('yes_same_rate');
    expect(classifyEmergencyMode('Business hours only')).toBe('business_hours_only');
    expect(classifyEmergencyMode('we sometimes help out')).toBe('unknown');
  });

  it('owner text is sanitised (no markup, length-capped)', () => {
    const f = ownerAnswerField('brand_pronunciation', '<script>alert(1)</script> Kee-stone ' + 'x'.repeat(2000));
    expect(f).not.toBeNull();
    expect(String(f?.value)).not.toContain('<');
    expect(String(f?.value).length).toBeLessThanOrEqual(400);
  });
});
