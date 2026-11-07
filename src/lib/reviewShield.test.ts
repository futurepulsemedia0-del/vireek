// Review Shield engine tests (Vitest). Pure logic only — no network, no DB, no clock.
// Fixtures are SYNTHETIC. Precision/recall printed at the end are over these fixtures,
// not over real-world traffic, and must not be quoted as production accuracy.

import { describe, expect, it } from 'vitest';
import { assessBurst, binomialTail, buildBaseline, findRepeatedWording, poissonTail, velocitySeries, type ShieldReview } from '../../supabase/functions/_shared/review-shield/detect.ts';
import { scanForExtortionPatterns } from '../../supabase/functions/_shared/review-shield/patterns.ts';
import { evaluateLedger, parseName, scoreName, type LedgerRecord, type LedgerSource } from '../../supabase/functions/_shared/review-shield/match.ts';
import { redactText } from '../../supabase/functions/_shared/review-shield/redact.ts';
import { buildManifest, canonicalJson, csvCell, toCsv, verifyManifest } from '../../supabase/functions/_shared/review-shield/evidence.ts';
import { appealEligibility } from '../../supabase/functions/_shared/review-shield/eligibility.ts';
import { lintReply } from '../../supabase/functions/_shared/review-shield/reply.ts';
import { alertKey, decideAttack, recommendedActions, shouldNotify } from '../../supabase/functions/_shared/review-shield/attack.ts';
import { buildPack, PackError, type PackReviewInput } from '../../supabase/functions/_shared/review-shield/pack.ts';

const NOW = new Date('2027-03-10T12:00:00Z');
const DAY = 86_400_000;
const iso = (daysAgo: number, hourOffset = 0) => new Date(NOW.getTime() - daysAgo * DAY + hourOffset * 3_600_000).toISOString();

let seq = 0;
function review(daysAgo: number, rating: number, body: string | null = null, name = 'Pat Example', hourOffset = 0): ShieldReview {
  seq++;
  return { id: `r${seq}`, platform: 'google', reviewerName: name, rating, body, reviewedAt: iso(daysAgo, hourOffset) };
}

/** ~1 review / 3 days for 150 days, mostly 4-5 stars, with different text each time. */
function healthyHistory(): ShieldReview[] {
  const out: ShieldReview[] = [];
  for (let d = 150; d >= 5; d -= 3) out.push(review(d, d % 15 === 0 ? 2 : 5, `Technician number ${d} arrived and fixed the ${['furnace', 'boiler', 'sink', 'drain', 'heater'][d % 5]} quickly`, `Customer ${d}`));
  return out;
}
const completedJobs = (perDay: number): string[] => {
  const out: string[] = [];
  for (let d = 150; d >= 0; d--) for (let k = 0; k < perDay; k++) out.push(iso(d, k));
  return out;
};

describe('statistics helpers', () => {
  it('poissonTail matches known values', () => {
    expect(poissonTail(0, 2)).toBe(1);
    expect(poissonTail(1, 1)).toBeCloseTo(1 - Math.exp(-1), 10);
    expect(poissonTail(3, 0.5)).toBeCloseTo(0.01439, 4);
  });
  it('binomialTail matches known values', () => {
    expect(binomialTail(0, 5, 0.3)).toBe(1);
    expect(binomialTail(6, 5, 0.3)).toBe(0);
    expect(binomialTail(2, 3, 0.5)).toBeCloseTo(0.5, 10);
  });
});

describe('burst detection', () => {
  it('does not flag a normal quiet week', () => {
    const a = assessBurst([...healthyHistory(), review(1, 5, 'Great job today'), review(0.5, 4, 'Friendly crew')], completedJobs(2), NOW);
    expect(a.level).toBe('none');
    expect(a.signals).toHaveLength(0);
  });

  it('does not flag a single bad review', () => {
    const a = assessBurst([...healthyHistory(), review(1, 1, 'Late and rude')], completedJobs(2), NOW);
    expect(a.level).toBe('none');
  });

  it('flags a low-rating burst far above baseline, without calling it fake', () => {
    const attack = [0.2, 0.5, 1, 1.4, 2, 2.3, 2.6].map((d, i) => review(d, 1, `Awful experience number ${i} would never recommend`, `Stranger ${i}`));
    const a = assessBurst([...healthyHistory(), ...attack], completedJobs(1), NOW);
    expect(['elevated', 'high']).toContain(a.level);
    const codes = a.signals.map((s) => s.code);
    expect(codes).toContain('burst_volume');
    expect(codes).toContain('burst_low_rating');
    expect(codes).toContain('reviews_exceed_jobs');
    expect(a.lowConfidence).toBe(false);
    // the attack must not inflate its own baseline
    expect(a.baseline.baselineReviews).toBe(healthyHistory().length);
  });

  it('identical wording across reviews is a signal; short generic phrases are not', () => {
    const text = 'This company took my deposit and never showed up do not trust them at all';
    const clones = [1, 2, 3].map((i) => review(0.3 * i, 1, text, `Name ${i}`));
    expect(findRepeatedWording(clones)).toHaveLength(1);
    const generic = [1, 2, 3].map((i) => review(0.3 * i, 5, 'Great service', `Name ${i}`));
    expect(findRepeatedWording(generic)).toHaveLength(0);
  });

  it('a thin baseline can prompt a look but never reaches "high"', () => {
    const attack = [0.1, 0.2, 0.3, 0.4, 0.5].map((d, i) => review(d, 1, 'Never again terrible people avoid at all cost please', `S${i}`));
    const a = assessBurst(attack, [], NOW);
    expect(a.lowConfidence).toBe(true);
    expect(a.level).not.toBe('high');
    expect(a.level).not.toBe('none');
  });

  it('ignores reviews with invalid dates instead of throwing', () => {
    const bad: ShieldReview = { id: 'x', platform: 'google', reviewerName: 'A', rating: 1, body: null, reviewedAt: 'not-a-date' };
    expect(() => assessBurst([bad], [], NOW)).not.toThrow();
  });

  it('baseline excludes the test window and reports ratio', () => {
    const b = buildBaseline(healthyHistory(), completedJobs(1), NOW);
    expect(b.baselineDays).toBeGreaterThan(100);
    expect(b.reviewToJobRatio).not.toBeNull();
    expect(b.lowConfidence).toBe(false);
  });

  it('velocitySeries buckets by day', () => {
    const s = velocitySeries([review(0.5, 1), review(0.6, 5)], new Date(NOW.getTime() - 2 * DAY), NOW);
    expect(s.reduce((n, b) => n + b.total, 0)).toBe(2);
    expect(s.reduce((n, b) => n + b.lowRated, 0)).toBe(1);
  });
});

describe('extortion pattern scan', () => {
  const positives = [
    'Pay me $500 and I will remove this review',
    'send 300 dollars if you want me to delete the review',
    'Give me a refund or I will keep posting 1 star reviews until you pay',
    'I will destroy your business reputation unless you pay up',
    'wire the money to take down the review and we are done',
    'Remove the review for cash? no. YOU pay ME to remove the review.',
    'more fake 1 star reviews coming if you do not pay',
    'Unless you send me $200 this rating stays',
  ];
  const negatives = [
    'The technician was late and the work was poor. I want a refund.',
    'Please remove my name from your mailing list.',
    'Great service, would pay again and recommend to friends.',
    'They fixed the leak and charged a fair fee for the repair.',
    'I left a review on Google about the plumber who fixed my sink.',
    'The price was too high but the work was fine.',
    'Called three times, nobody picked up. Will not hire again.',
    'You should change your voicemail greeting, it is confusing.',
  ];
  it('flags demands for payment / threats', () => {
    for (const t of positives) expect(scanForExtortionPatterns(t, 'dm').length, t).toBeGreaterThan(0);
  });
  it('does not flag ordinary complaints', () => {
    for (const t of negatives) expect(scanForExtortionPatterns(t, 'review').length, t).toBe(0);
  });
  it('is not fooled by zero-width characters', () => {
    expect(scanForExtortionPatterns('pay\u200B me $500 and I will re\u200Bmove this review', 'dm').length).toBeGreaterThan(0);
  });
  it('reports precision/recall over the labelled fixtures', () => {
    const tp = positives.filter((t) => scanForExtortionPatterns(t, 'dm').length > 0).length;
    const fp = negatives.filter((t) => scanForExtortionPatterns(t, 'dm').length > 0).length;
    const precision = tp / Math.max(1, tp + fp);
    const recall = tp / positives.length;
    console.log(`extortion fixtures: precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} (n=${positives.length + negatives.length}, synthetic)`);
    expect(precision).toBe(1);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});

describe('name matching with messy data', () => {
  it('parses titles, suffixes and diacritics', () => {
    expect(parseName('Dr. José Núñez Jr.').tokens).toEqual(['jose', 'nunez']);
    expect(parseName('Dr. José Núñez Jr.').suffix).toBe('jr');
  });
  it('exact, nickname, initial and typo variants', () => {
    expect(scoreName('Robert Miller', 'Robert Miller').kind).toBe('exact');
    expect(scoreName('Bob Miller', 'Robert Miller').kind).toBe('nickname');
    expect(scoreName('Bob Miller', 'Robert Miller').score).toBeGreaterThanOrEqual(0.85);
    expect(scoreName('Maria G.', 'Maria Gonzalez').score).toBeGreaterThanOrEqual(0.6);
    expect(scoreName('Maria G.', 'Maria Gonzalez').score).toBeLessThan(0.85);
    expect(scoreName('Jon Smyth', 'John Smith').score).toBeLessThan(0.85); // never auto-"match" on typos alone
    expect(scoreName('Katherine Johnson', 'Katharine Johnson').score).toBeGreaterThanOrEqual(0.7);
  });
  it('a first name alone can only ever be "possible"', () => {
    expect(scoreName('Mike', 'Michael Brown').score).toBe(0.5);
  });
  it('same surname, different first name is not a match (but is not ignored)', () => {
    const s = scoreName('Linda Brown', 'Michael Brown');
    expect(s.score).toBeLessThan(0.45);
  });
  it('Jr/Sr mismatch caps the score', () => {
    expect(scoreName('John Smith Jr', 'John Smith Sr').score).toBeLessThanOrEqual(0.5);
  });
  it('unrelated names score zero', () => {
    expect(scoreName('Hannah Lee', 'Omar Haddad').score).toBe(0);
  });
});

describe('ledger evaluation', () => {
  const review = { id: 'rv1', reviewerName: 'Bob Miller', body: 'The furnace repair was a disaster and the tech was rude', reviewedAt: iso(2) };
  const job: LedgerRecord = { source: 'job', id: 'job-1', names: ['Robert Miller', 'Karen Miller'], at: iso(40), service: 'Furnace repair', address: '12 Oak Lane' };
  const all = (extra: Partial<Record<LedgerSource, { records: LedgerRecord[] } | { error: string }>> = {}) => {
    const base: Partial<Record<LedgerSource, { records: LedgerRecord[] }>> = {};
    for (const s of ['call', 'sms', 'booking', 'job', 'invoice', 'customer'] as LedgerSource[]) base[s] = { records: [] };
    return { ...base, ...extra };
  };

  it('finds a genuine customer through nickname + service overlap and names the source', () => {
    const r = evaluateLedger({ review, sources: all({ job: { records: [job] } }) });
    expect(r.overall).toBe('match');
    expect(r.sources.find((s) => s.source === 'job')!.hits[0].reasons).toContain('name_nickname');
  });

  it('finds a spouse/household alias as a hit (different name on the record)', () => {
    const wife = { ...review, reviewerName: 'Karen M.' };
    const r = evaluateLedger({ review: wife, sources: all({ job: { records: [job] } }) });
    expect(['match', 'possible_match']).toContain(r.overall);
  });

  it('reports no_match only when every source was searched', () => {
    const r = evaluateLedger({ review, sources: all() });
    expect(r.overall).toBe('no_match');
    expect(r.sources.every((s) => s.searched)).toBe(true);
  });

  it('a failed or missing source makes the result incomplete, never no_match', () => {
    const failed = evaluateLedger({ review, sources: all({ sms: { error: 'timeout' } }) });
    expect(failed.overall).toBe('incomplete');
    const missing = all();
    delete missing.invoice;
    expect(evaluateLedger({ review, sources: missing }).overall).toBe('incomplete');
  });

  it('records outside the date window are not scanned, undated customer rows still are', () => {
    const old: LedgerRecord = { ...job, id: 'old', at: iso(900) };
    const undated: LedgerRecord = { source: 'customer', id: 'c1', names: ['Robert Miller'], at: null };
    const r = evaluateLedger({ review, sources: all({ job: { records: [old] }, customer: { records: [undated] } }) });
    expect(r.sources.find((s) => s.source === 'job')!.recordsScanned).toBe(0);
    expect(r.overall).toBe('match');
  });

  it('context alone never creates a match', () => {
    const stranger = { ...review, reviewerName: 'Zed Quill' };
    expect(evaluateLedger({ review: stranger, sources: all({ job: { records: [job] } }) }).overall).toBe('no_match');
  });
});

describe('appeal eligibility: genuine customers never flow into an appeal pack', () => {
  const noMatch = { reviewId: 'r', overall: 'no_match' as const, sources: [] };
  const signal = [{ code: 'burst_volume' as const, strength: 'strong' as const, params: {}, reviewIds: ['r'] }];
  const ok = { ledger: noMatch, signals: signal, extortionHits: [], ownerMarkedGenuine: false, ownerConfirmed: true, basis: 'fake_engagement' as const };

  it('passes only when every condition holds', () => {
    expect(appealEligibility(ok)).toEqual({ eligible: true, blockers: [] });
  });
  it('blocks a ledger match', () => {
    expect(appealEligibility({ ...ok, ledger: { ...noMatch, overall: 'match' } }).blockers).toContain('ledger_match');
  });
  it('blocks a possible match', () => {
    expect(appealEligibility({ ...ok, ledger: { ...noMatch, overall: 'possible_match' } }).eligible).toBe(false);
  });
  it('blocks an incomplete or missing ledger search', () => {
    expect(appealEligibility({ ...ok, ledger: { ...noMatch, overall: 'incomplete' } }).blockers).toContain('ledger_incomplete');
    expect(appealEligibility({ ...ok, ledger: null }).eligible).toBe(false);
  });
  it('blocks when the owner says the reviewer is a genuine customer, even with strong signals', () => {
    expect(appealEligibility({ ...ok, ownerMarkedGenuine: true }).blockers).toContain('owner_marked_genuine');
  });
  it('blocks without any suspicion signal, policy basis or owner confirmation', () => {
    expect(appealEligibility({ ...ok, signals: [] }).blockers).toContain('no_suspicion_signal');
    expect(appealEligibility({ ...ok, basis: null }).blockers).toContain('no_policy_basis');
    expect(appealEligibility({ ...ok, ownerConfirmed: false }).blockers).toContain('owner_not_confirmed');
  });
});

describe('redaction', () => {
  it('removes emails, phones, addresses, long numbers and links', () => {
    const r = redactText('Call Karen at (555) 123-4567 or karen@example.com, 12 Oak Lane, acct 123456789012, see https://x.example/a?b=1');
    expect(r.text).not.toMatch(/555|karen@|Oak Lane|123456789012|x\.example/);
    expect(r.counts.email).toBe(1);
    expect(r.counts.phone).toBeGreaterThanOrEqual(1);
    expect(r.counts.address).toBe(1);
  });
  it('removes known customer values case-insensitively, longest first', () => {
    const r = redactText('karen miller said Karen was home', { knownValues: ['Karen Miller', 'Karen'] });
    expect(r.text).toBe('[redacted] said [redacted] was home');
  });
  it('keeps contact details only when explicitly asked (owner-only export)', () => {
    expect(redactText('a@b.co 555-123-4567', { keepContactDetails: true }).text).toContain('a@b.co');
  });
  it('known values containing regex metacharacters are matched literally', () => {
    expect(redactText('Pay (a+b) now', { knownValues: ['(a+b)'] }).text).toBe('Pay [redacted] now');
  });
});

describe('evidence manifest', () => {
  const sections = { review: { id: 'r1', rating: 1 }, ledger: { overall: 'no_match', counts: [1, 2, 3] } };
  it('canonicalJson is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });
  it('verifies an untouched pack and detects any edit', async () => {
    const m = await buildManifest({ generatedAt: '2027-03-10T12:00:00Z', accountRef: 'acct_x', sections });
    expect(await verifyManifest(m, m.snapshotHash)).toEqual({ ok: true });

    const tampered = structuredClone(m);
    (tampered.sections.review as { rating: number }).rating = 5;
    expect(await verifyManifest(tampered, m.snapshotHash)).toEqual({ ok: false, reason: 'section_changed', sections: ['review'] });

    const swapped = structuredClone(m);
    swapped.generatedAt = '2027-03-11T12:00:00Z';
    expect((await verifyManifest(swapped, m.snapshotHash)).ok).toBe(false);
  });
  it('same input gives the same hash', async () => {
    const a = await buildManifest({ generatedAt: 't', accountRef: 'a', sections });
    const b = await buildManifest({ generatedAt: 't', accountRef: 'a', sections: { ledger: sections.ledger, review: sections.review } });
    expect(a.snapshotHash).toBe(b.snapshotHash);
  });
  it('CSV neutralises spreadsheet formulas and quotes correctly', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1 555')).toBe("'+1 555");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(toCsv(['x'], [['@cmd']])).toBe("x\r\n'@cmd\r\n");
  });
});

describe('public reply linter', () => {
  it('accepts a calm reply that invites contact', () => {
    expect(lintReply('Thank you for your feedback. We could not find a record of this visit and would welcome the chance to look into it. Please contact our office.').ok).toBe(true);
  });
  it('blocks legal threats, accusations, pressure and customer data', () => {
    expect(lintReply('We will sue you for defamation.').issues).toContain('legal_threat');
    expect(lintReply('This is a fake review by a liar.').issues).toContain('accusation');
    expect(lintReply('We will refund you if you remove the review.').issues).toContain('pressure');
    expect(lintReply('Call us back at 555-123-4567').issues).toContain('customer_data');
    expect(lintReply('Karen Miller had a great visit', ['Karen Miller']).issues).toContain('customer_data');
  });
  it('blocks empty and oversized replies', () => {
    expect(lintReply('   ').issues).toEqual(['empty']);
    expect(lintReply('a'.repeat(1600)).issues).toContain('too_long');
  });
});

describe('evidence pack builder', () => {
  const noMatch = { reviewId: 'a', overall: 'no_match' as const, sources: (['call','sms','booking','job','invoice','customer'] as const).map((source) => ({ source, searched: true, error: null, windowStart: 'w0', windowEnd: 'w1', recordsScanned: 3, hits: [] })) };
  const sig = [{ code: 'burst_volume' as const, strength: 'strong' as const, params: { observed: 5 }, reviewIds: ['a'] }];
  const mk = (id: string, over: Partial<PackReviewInput> = {}): PackReviewInput => ({
    review: { id, platform: 'google', reviewerName: 'Zed Quill', rating: 1, body: 'Call me 555-123-4567 about Karen Miller', reviewedAt: iso(1) },
    ownerStatus: 'confirmed_suspicious', policyBasis: 'fake_engagement', ledger: { ...noMatch, reviewId: id }, signals: sig, extortionHits: [], ...over,
  });
  const burst = assessBurst([], [], NOW);
  const base = { generatedAt: '2027-03-10T12:00:00Z', accountRef: 'acct', burst, velocity: [], messages: [], knownCustomerValues: ['Karen Miller'] };

  it('appeal pack contains only eligible reviews and lists the rest as excluded with blockers', async () => {
    const genuine = mk('g', { ledger: { ...noMatch, reviewId: 'g', overall: 'match' } });
    const owner = mk('o', { ownerStatus: 'genuine_customer' });
    const p = await buildPack({ ...base, kind: 'appeal', reviews: [mk('ok'), genuine, owner] });
    expect((p.manifest.sections.reviews as { id: string }[]).map((r) => r.id)).toEqual(['ok']);
    expect(p.excluded.map((e) => e.reviewId).sort()).toEqual(['g', 'o']);
    expect(JSON.stringify(p.manifest)).not.toMatch(/"g"|genuine_customer/);
  });
  it('refuses to build an appeal pack when nothing is eligible', async () => {
    let code = '';
    try { await buildPack({ ...base, kind: 'appeal', reviews: [mk('x', { ledger: { ...noMatch, overall: 'incomplete' } })] }); } catch (e) { code = (e as PackError).code; }
    expect(code).toBe('no_eligible_reviews');
  });
  it('redacts PII in text and CSV, and states "no matching record" as a code', async () => {
    const p = await buildPack({ ...base, kind: 'appeal', reviews: [mk('ok')], messages: [{ channel: 'dm', id: 'm1', at: iso(0), text: 'email me a@b.co', codes: ['payment_for_removal'] }] });
    const all = JSON.stringify(p.manifest) + p.csv.reviews;
    expect(all).not.toMatch(/555-123|Karen|a@b\.co/);
    expect((p.manifest.sections.ledger as { statement: string }[])[0].statement).toBe('no_matching_record_found');
    expect(p.redactionTotal).toBeGreaterThan(0);
  });
  it('preservation snapshot keeps genuine matches but never marks them appeal-eligible', async () => {
    const p = await buildPack({ ...base, kind: 'preservation', reviews: [mk('g', { ledger: { ...noMatch, reviewId: 'g', overall: 'match' } })] });
    const r = (p.manifest.sections.reviews as { appealEligible: boolean; ledgerOverall: string }[])[0];
    expect(r.appealEligible).toBe(false);
    expect(r.ledgerOverall).toBe('match');
  });
  it('ledger CSV lists every source searched', async () => {
    const p = await buildPack({ ...base, kind: 'appeal', reviews: [mk('ok')] });
    expect(p.csv.ledger.trim().split('\r\n')).toHaveLength(7);
  });
});

describe('attack mode decisions', () => {
  const attack = [0.2, 0.5, 1, 1.4, 2, 2.3, 2.6].map((d, i) => review(d, 1, `Awful experience number ${i} would never recommend`, `S${i}`));
  const a = assessBurst([...healthyHistory(), ...attack], completedJobs(1), NOW);
  it('opens an incident on elevated/high, does nothing when quiet or disabled', () => {
    expect(decideAttack(a, null, true).action).toBe('open');
    expect(decideAttack(a, null, false).action).toBe('none');
    expect(decideAttack(assessBurst(healthyHistory(), completedJobs(1), NOW), null, true).action).toBe('none');
  });
  it('extends a live incident instead of opening a second one, and only notifies on open/escalation', () => {
    const live = { id: 'i1', level: 'elevated' as const, windowEnd: iso(1), reviewIds: [] };
    const d = decideAttack(a, live, true);
    expect(d.action).toBe('extend');
    const again = decideAttack(a, { ...live, level: a.level as 'elevated' | 'high', reviewIds: attack.map((r) => r.id) }, true);
    expect(shouldNotify(again)).toBe(false);
    expect(shouldNotify({ action: 'open', level: 'high' })).toBe(true);
  });
  it('recommends, never forces; never recommends pausing or filtering review requests', () => {
    const acts = recommendedActions(a, true);
    expect(acts).toContain('keep_asking_all_customers');
    expect(acts).toContain('do_not_pay');
    expect(acts.join(' ')).not.toMatch(/pause|filter|gate/);
    expect(alertKey('high').messageKey).toBe('alert.highMessage');
  });
});
