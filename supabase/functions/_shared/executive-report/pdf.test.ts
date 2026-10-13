import { describe, it, expect } from 'vitest';
import { jsPDF } from 'jspdf';
import { buildExecutiveReportPdf, pdfSafe } from './pdf';
import { deterministicCommentary } from './commentaryCore';
import { computeExecutiveMetrics } from './metrics';
import { periodForMonth } from './period';

const settings = { user_id: 'u', enabled: true, send_day: 1, send_hour: 8, timezone: 'UTC', include_owner: true, include_co_owners: true, extra_recipients: [], ai_commentary_enabled: true, revenue_goal: 1000, jobs_goal: 2, close_rate_goal_pct: 60, margin_goal_pct: 40 };

describe('executive report pdf', () => {
  it('strips glyphs Helvetica cannot render', () => {
    expect(pdfSafe('Café — “Ünï” ✓')).toBe('Cafe - "Uni" ?');
  });
  it('builds a valid multi-section PDF even with no data', () => {
    const metrics = computeExecutiveMetrics(periodForMonth('2026-09', 'UTC')!, { jobs: [], costs: [], quotes: [], calls: [], recoveries: [], technicians: [] }, settings);
    const bytes = buildExecutiveReportPdf(jsPDF as never, { companyName: 'Acme HVAC', metrics, commentary: deterministicCommentary(metrics), generatedAt: new Date('2026-10-01T08:00:00Z') });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(String.fromCharCode(...bytes.slice(0, 5))).toBe('%PDF-');
  });
});
