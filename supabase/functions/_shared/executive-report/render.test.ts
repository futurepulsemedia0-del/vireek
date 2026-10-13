import { describe, it, expect } from 'vitest';
import { esc, renderReportEmail } from './render';
import { deterministicCommentary } from './commentaryCore';
import { computeExecutiveMetrics } from './metrics';
import { periodForMonth } from './period';

const settings = { user_id: 'u', enabled: true, send_day: 1, send_hour: 8, timezone: 'UTC', include_owner: true, include_co_owners: true, extra_recipients: [], ai_commentary_enabled: true, revenue_goal: 1000, jobs_goal: null, close_rate_goal_pct: null, margin_goal_pct: null };
const metrics = computeExecutiveMetrics(periodForMonth('2026-09', 'UTC')!, { jobs: [], costs: [], quotes: [], calls: [], recoveries: [], technicians: [] }, settings);

describe('render', () => {
  it('escapes HTML', () => {
    expect(esc('<script>"x"&\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;');
  });
  it('escapes company names and builds subject, html and text', () => {
    const out = renderReportEmail({ companyName: '<b>Acme</b> HVAC', metrics, commentary: deterministicCommentary(metrics), pdfUrl: 'https://x.test/a.pdf' });
    expect(out.subject).toBe('<b>Acme</b> HVAC — Executive report for September 2026');
    expect(out.html).not.toContain('<b>Acme</b>');
    expect(out.html).toContain('&lt;b&gt;Acme&lt;/b&gt;');
    expect(out.html).toContain('Download the full PDF');
    expect(out.text).toContain('Full PDF: https://x.test/a.pdf');
  });
  it('says the PDF is attached when there is no link', () => {
    const out = renderReportEmail({ companyName: 'Acme', metrics, commentary: deterministicCommentary(metrics) });
    expect(out.html).toContain('attached');
  });
});
