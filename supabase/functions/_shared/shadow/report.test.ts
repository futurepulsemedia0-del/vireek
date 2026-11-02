import { describe, it, expect } from 'vitest';
import { buildReportPayload, buildReportPdf, esc, renderReportHtml, topMistakes, type ReportCounts, type ReviewRow } from './report';

const counts: ReportCounts = { callsSeen: 40, analyzed: 36, unanswered: 12, slowAnswers: 3, afterHours: 9, emergencies: 2, capturable: 10, reviewed: 20, approved: 17, blockedConsent: 2, noTranscript: 2 };
const rv = (o: Partial<ReviewRow> = {}): ReviewRow => ({ verdict: 'bad', severity: 'minor', category: 'pricing', proposalTarget: 'none', proposalStatus: 'none', mistakeResolved: false, correctedText: null, ...o });
const base = (over = {}) => buildReportPayload({
  nowIso: '2028-04-08T09:00:00.000Z',
  trial: { startedAt: '2028-04-01T09:00:00.000Z', endsAt: '2028-04-08T09:00:00.000Z', timezone: 'America/Chicago', setup: { forwarding: true, hours: true, emergency_rules: false, test_call: false } },
  counts, avgTicketCents: 45_000, closeRate: 0.25,
  capturableCards: Array.from({ length: 10 }, () => ({ wouldBook: true, capturable: true })),
  emergencyCardsReviewed: 2, emergencyCardsApproved: 2, reviews: [], openCritical: 0, ...over,
});

describe('topMistakes', () => {
  it('ranks critical first, then count, and caps at 3', () => {
    const rows = [rv({ category: 'tone' }), rv({ category: 'tone' }), rv({ category: 'pricing', severity: 'critical' }), rv({ category: 'greeting' }), rv({ category: 'booking' }), rv({ category: 'booking' }), rv({ category: 'booking' })];
    const m = topMistakes(rows);
    expect(m.length).toBe(3);
    expect(m[0].category).toBe('pricing');
    expect(m[1].category).toBe('booking');
  });
  it('marks a mistake fixed when its proposal was accepted/applied and says how', () => {
    const m = topMistakes([rv({ category: 'pricing', proposalTarget: 'faq', proposalStatus: 'applied', mistakeResolved: true, correctedText: 'We charge a $89 diagnostic fee.' })]);
    expect(m[0].status).toBe('fixed');
    expect(m[0].fix).toBe('Added to business FAQs');
  });
  it('is open when any instance is unresolved, and redacts PII in examples', () => {
    const m = topMistakes([rv({ proposalStatus: 'accepted', proposalTarget: 'script', correctedText: 'call 512-555-0123' }), rv()]);
    expect(m[0].status).toBe('open');
    expect(m[0].example).not.toMatch(/512-555-0123/);
  });
  it('ignores good reviews', () => { expect(topMistakes([rv({ verdict: 'good' })]).length).toBe(0); });
});

describe('report payload & HTML', () => {
  it('labels money as an estimate with a formula and a range', () => {
    const p = base();
    expect(p.estimate.isEstimate).toBe(true);
    const html = renderReportHtml(p, { companyName: 'Acme HVAC' });
    expect(html).toContain('Estimate — not realized revenue');
    expect(html).toContain('How this estimate is calculated');
    expect(html).toContain('–'); // low–high range
    expect(html.toLowerCase()).not.toMatch(/recovered revenue|you earned|realized: /);
  });
  it('escapes untrusted text (XSS) in company name and mistakes', () => {
    const p = base({ reviews: [rv({ category: '<img src=x onerror=alert(1)>', correctedText: '<script>alert(1)</script>' })] });
    const html = renderReportHtml(p, { companyName: '<b>Evil</b>' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>Evil</b>');
    expect(esc('"&\'')).toBe('&quot;&amp;&#39;');
  });
  it('shows "not enough data" instead of a score when too few calls were reviewed', () => {
    const p = base({ counts: { ...counts, reviewed: 3, approved: 3 } });
    expect(p.readiness.state).toBe('insufficient_data');
    expect(renderReportHtml(p)).toContain('Not enough reviewed calls');
  });
  it('asks for an average ticket instead of showing $0 when it is missing', () => {
    const html = renderReportHtml(base({ avgTicketCents: null }));
    expect(html).toContain('Add your average ticket');
  });
  it('renders Spanish and falls back to English for unknown locales', () => {
    expect(renderReportHtml(base(), { locale: 'es' })).toContain('Prueba de valor');
    expect(renderReportHtml(base(), { locale: 'fr' })).toContain('Proof of Value');
    expect(renderReportHtml(base(), { locale: 'es' })).toContain('lang="es"');
  });
  it('mentions consent-blocked and no-transcript calls honestly', () => {
    const html = renderReportHtml(base());
    expect(html).toContain('not analysed because consent');
    expect(html).toContain('had no transcript');
  });
  it('has accessible structure (lang, table caption/scope, note role)', () => {
    const html = renderReportHtml(base({ reviews: [rv()] }));
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('scope="col"');
    expect(html).toContain('role="note"');
  });
});

describe('report PDF', () => {
  it('writes estimate label and checklist through the injected jsPDF without throwing', () => {
    const texts: string[] = [];
    class FakePdf {
      setFont() {} setFontSize() {} addPage() {}
      splitTextToSize(s: string) { return [s]; }
      text(s: string) { texts.push(s); }
      output() { return new ArrayBuffer(4); }
    }
    const bytes = buildReportPdf(FakePdf as never, base());
    expect(bytes.length).toBe(4);
    expect(texts.join('\n')).toContain('Estimate — not realized revenue'.replace('—', '-'));
    expect(texts.join('\n')).toContain('[x] Call forwarding set up');
  });
});
