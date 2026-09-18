import { jsPDF } from 'jspdf';
import type { CaseStudy } from '@/components/sections/CaseStudies';
import type { InsuranceClaim } from '@/lib/supabase';
import type { CommercialContract, ContractSlaBreach } from '@/lib/supabase';

// ============================================================
// SHARED LAYOUT HELPERS
// ============================================================
//
// Everything here is manual text/shape layout with jsPDF — no
// html2canvas / DOM screenshotting. That keeps output crisp
// (real vector text, not a rasterized screenshot), keeps the
// bundle small, and sidesteps CORS/font-rendering issues that
// come with capturing live app DOM. Brand colors are pulled
// from the same values as --accent-primary / --accent-secondary
// in src/index.css (light theme) so exported PDFs look related
// to the product, not generic.

const ACCENT: [number, number, number] = [32, 58, 216]; // --accent-primary (light)
const CTA: [number, number, number] = [214, 88, 42]; // --accent-secondary (light)
const INK: [number, number, number] = [23, 23, 23];
const MUTED: [number, number, number] = [110, 110, 120];
const SUCCESS: [number, number, number] = [22, 130, 87];
const DANGER: [number, number, number] = [200, 55, 55];
const LINE: [number, number, number] = [225, 225, 232];

const PAGE_WIDTH = 595.28; // A4 pt
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

function formatToday(): string {
  return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function drawHeader(doc: jsPDF, eyebrow: string, title: string): number {
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, PAGE_WIDTH, 6, 'F');

  let y = 44;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(...ACCENT);
  doc.text('Vireek', MARGIN, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('AI Voice Receptionist for Home Service Businesses', MARGIN, y + 13);

  y += 40;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...CTA);
  doc.text(eyebrow.toUpperCase(), MARGIN, y);

  y += 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(...INK);
  doc.text(title, MARGIN, y);

  y += 14;
  doc.setDrawColor(...LINE);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);

  return y + 26;
}

function drawSectionLabel(doc: jsPDF, label: string, y: number): number {
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...CTA);
  doc.text(label.toUpperCase(), MARGIN, y);
  return y + 16;
}

function drawParagraph(doc: jsPDF, text: string, y: number, opts?: { size?: number; color?: [number, number, number] }): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(opts?.size ?? 10.5);
  doc.setTextColor(...(opts?.color ?? INK));
  const lines = doc.splitTextToSize(text, CONTENT_WIDTH);
  doc.text(lines, MARGIN, y);
  return y + lines.length * (opts?.size ?? 10.5) * 1.45;
}

function drawFooter(doc: jsPDF, note: string): void {
  const y = 800;
  doc.setDrawColor(...LINE);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  const lines = doc.splitTextToSize(note, CONTENT_WIDTH);
  doc.text(lines, MARGIN, y + 14);
  doc.text(`Generated ${formatToday()} · vireek.com`, MARGIN, y + 14 + lines.length * 11 + 6);
}

function currency(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

// ============================================================
// CASE STUDY PDF
// ============================================================

export function downloadCaseStudyPdf(study: CaseStudy): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = drawHeader(doc, 'Case Study', study.business);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...MUTED);
  doc.text(`${study.name} · ${study.industry}`, MARGIN, y);
  y += 26;

  y = drawSectionLabel(doc, 'The Situation', y);
  y = drawParagraph(
    doc,
    `Before Vireek, ${study.business} was missing ${study.before.callsMissed} calls, with a typical response time of ${study.before.responseTime} — costing an estimated ${study.before.revenueLost} in lost work.`,
    y
  );
  y += 20;

  y = drawSectionLabel(doc, 'The Result', y);
  y = drawParagraph(
    doc,
    `With Sarah answering every call, ${study.business} now answers ${study.after.callsAnswered} of inbound calls with a${
      study.after.responseTime.toLowerCase().startsWith('i') ? 'n' : ''
    } ${study.after.responseTime.toLowerCase()} response, recovering roughly ${study.after.revenueRecovered} that would otherwise have gone to voicemail — or a competitor.`,
    y
  );
  y += 24;

  // Before / after table
  y = drawSectionLabel(doc, 'Before vs. After', y);
  const colWidth = CONTENT_WIDTH / 2 - 8;
  const tableTop = y;
  const rowHeight = 22;
  const rows: [string, string, string][] = [
    ['Calls', study.before.callsMissed, study.after.callsAnswered],
    ['Response time', study.before.responseTime, study.after.responseTime],
    ['Revenue', study.before.revenueLost, study.after.revenueRecovered],
  ];

  doc.setFillColor(250, 235, 235);
  doc.roundedRect(MARGIN, tableTop, colWidth, 20 + rowHeight * rows.length, 6, 6, 'F');
  doc.setFillColor(232, 246, 240);
  doc.roundedRect(MARGIN + colWidth + 16, tableTop, colWidth, 20 + rowHeight * rows.length, 6, 6, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(...DANGER);
  doc.text('BEFORE VIREEK', MARGIN + 14, tableTop + 16);
  doc.setTextColor(...SUCCESS);
  doc.text('AFTER VIREEK', MARGIN + colWidth + 16 + 14, tableTop + 16);

  rows.forEach(([label, before, after], i) => {
    const rowY = tableTop + 30 + i * rowHeight;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(label, MARGIN + 14, rowY);
    doc.text(label, MARGIN + colWidth + 16 + 14, rowY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    doc.text(before, MARGIN + 14, rowY + 12);
    doc.text(after, MARGIN + colWidth + 16 + 14, rowY + 12);
  });

  y = tableTop + 20 + rowHeight * rows.length + 28;

  // Quote
  doc.setFillColor(245, 246, 250);
  const quoteLines = doc.splitTextToSize(`"${study.quote}"`, CONTENT_WIDTH - 28);
  const quoteHeight = quoteLines.length * 14.5 + 40;
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, quoteHeight, 8, 8, 'F');
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);
  doc.text(quoteLines, MARGIN + 14, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(`— ${study.name}, ${study.business}`, MARGIN + 14, y + quoteHeight - 12);
  y += quoteHeight + 22;

  // Result callout
  doc.setFillColor(232, 246, 240);
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, 34, 8, 8, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...SUCCESS);
  doc.text(study.result, MARGIN + 14, y + 22);

  drawFooter(
    doc,
    'This is an early-access partner story from Vireek\u2019s founding contractor program, not a composite or hypothetical example. Individual results vary by call volume, trade, and prior call-handling.'
  );

  doc.save(`vireek-case-study-${study.slug}.pdf`);
}

// ============================================================
// ROI CALCULATOR PDF
// ============================================================

export interface RoiCalculatorInputs {
  callsPerWeek: number;
  missedPerWeek: number;
  jobValue: number;
  closeRate: number;
}

export interface RoiCalculatorResults {
  monthlyLoss: number;
  annualLoss: number;
  recoveredJobs: number;
  monthlyOpportunity: number;
}

export function downloadRoiCalculatorPdf(inputs: RoiCalculatorInputs, results: RoiCalculatorResults): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = drawHeader(doc, 'ROI Report', 'Missed Call Revenue Calculator');

  y = drawParagraph(
    doc,
    'Based on the numbers you entered, here is what missed calls are estimated to cost your business — and what Vireek could recover.',
    y,
    { color: MUTED }
  );
  y += 18;

  // Inputs
  y = drawSectionLabel(doc, 'Your inputs', y);
  const inputRows: [string, string][] = [
    ['Total calls per week', `${inputs.callsPerWeek} calls`],
    ['Missed calls per week', `${inputs.missedPerWeek} calls`],
    ['Average job value', currency(inputs.jobValue)],
    ["Estimated close rate on recovered calls", `${inputs.closeRate}%`],
  ];
  inputRows.forEach(([label, value], i) => {
    const rowY = y + i * 20;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...MUTED);
    doc.text(label, MARGIN, rowY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(value, PAGE_WIDTH - MARGIN, rowY, { align: 'right' });
  });
  y += inputRows.length * 20 + 20;

  doc.setDrawColor(...LINE);
  doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
  y += 26;

  // Hero result
  y = drawSectionLabel(doc, 'Estimated revenue lost per year', y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(30);
  doc.setTextColor(...DANGER);
  doc.text(currency(results.annualLoss), MARGIN, y + 16);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(`That's roughly ${currency(results.monthlyLoss)} every month.`, MARGIN, y + 36);
  y += 60;

  // Two result cards
  const cardWidth = CONTENT_WIDTH / 2 - 8;
  const cardHeight = 66;
  doc.setFillColor(232, 246, 240);
  doc.roundedRect(MARGIN, y, cardWidth, cardHeight, 8, 8, 'F');
  doc.setFillColor(234, 238, 253);
  doc.roundedRect(MARGIN + cardWidth + 16, y, cardWidth, cardHeight, 8, 8, 'F');

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  doc.text('JOBS RECOVERED / MO', MARGIN + 14, y + 20);
  doc.text('MONTHLY OPPORTUNITY', MARGIN + cardWidth + 16 + 14, y + 20);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(...SUCCESS);
  doc.text(String(results.recoveredJobs), MARGIN + 14, y + 46);
  doc.setTextColor(...ACCENT);
  doc.text(currency(results.monthlyOpportunity), MARGIN + cardWidth + 16 + 14, y + 46);

  y += cardHeight + 26;

  doc.setFillColor(234, 238, 253);
  const noteLines = doc.splitTextToSize(
    'Vireek answers 100% of calls, 24/7. Even recovering a fraction of this number pays for a plan many times over — most customers see it pay for itself inside the first week.',
    CONTENT_WIDTH - 28
  );
  doc.roundedRect(MARGIN, y, CONTENT_WIDTH, noteLines.length * 13 + 24, 8, 8, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...ACCENT);
  doc.text(noteLines, MARGIN + 14, y + 18);

  drawFooter(
    doc,
    'Estimate only, based on the figures you entered and industry benchmarks for missed-call rates. Actual results depend on your call volume, trade, and current call-handling process.'
  );

  doc.save('vireek-roi-report.pdf');
}

// ============================================================
// INSURANCE CLAIM SUMMARY PDF
// ============================================================
//
// A clean, one-page handoff document for the file — customer, loss, and
// carrier/adjuster details in one place. Meant for internal use (or to
// attach when emailing an adjuster), not a customer-facing accept/decline
// flow like the quote PDF equivalent would be.

export function downloadInsuranceClaimPdf(claim: InsuranceClaim): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = drawHeader(doc, 'Insurance Claim Summary', claim.customer_name);

  y = drawSectionLabel(doc, 'Loss details', y);
  y = drawParagraph(
    doc,
    `Property: ${claim.property_address || 'Not on file'}\n` +
      `Date of loss: ${claim.date_of_loss || 'Not recorded'}\n` +
      `Loss type: ${claim.loss_type.replace(/_/g, ' ')}`,
    y
  );

  y += 10;
  y = drawSectionLabel(doc, 'Insurance details', y);
  y = drawParagraph(
    doc,
    `Carrier: ${claim.insurance_carrier || 'Not on file'}\n` +
      `Policy #: ${claim.policy_number || 'Not on file'}\n` +
      `Claim #: ${claim.claim_number || 'Not on file'}\n` +
      `Deductible: ${claim.deductible_cents != null ? currency(claim.deductible_cents / 100) : 'Not on file'}\n` +
      `Estimated damage: ${
        claim.estimated_damage_cents != null ? currency(claim.estimated_damage_cents / 100) : 'Not on file'
      }`,
    y
  );

  y += 10;
  y = drawSectionLabel(doc, 'Adjuster', y);
  y = drawParagraph(
    doc,
    `${claim.adjuster_name || 'Not yet assigned'}\n` +
      `${claim.adjuster_phone || ''}${claim.adjuster_phone && claim.adjuster_email ? ' · ' : ''}${
        claim.adjuster_email || ''
      }`,
    y
  );

  if (claim.notes) {
    y += 10;
    y = drawSectionLabel(doc, 'Notes', y);
    // NOTE: drawParagraph's return value (the y position after the notes
    // text) used to be reassigned to `y` here, but `y` is never read again
    // afterward — drawFooter positions itself with its own fixed y = 800,
    // not this local variable. That made it a dead store that ESLint
    // flags as an unused assignment. The call itself must stay (it's what
    // actually renders the notes text onto the PDF); only the pointless
    // reassignment is removed.
    drawParagraph(doc, claim.notes, y, { color: MUTED });
  }

  drawFooter(doc, `Claim status: ${claim.status.replace(/_/g, ' ')}. Generated for internal and adjuster reference.`);
  doc.save(`insurance-claim-${claim.customer_name.trim().replace(/\s+/g, '-').toLowerCase() || 'summary'}.pdf`);
}
export function downloadContractPdf(contract: CommercialContract, breaches: ContractSlaBreach[] = []): void {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = drawHeader(doc, 'Commercial Contract Summary', contract.contract_name);

  y = drawSectionLabel(doc, 'Contract details', y);
  y = drawParagraph(
    doc,
    `Contract #: ${contract.contract_number || 'Not on file'}\n` +
      `Type: ${contract.contract_type.replace(/_/g, ' ')}\n` +
      `Status: ${contract.status.replace(/_/g, ' ')}\n` +
      `Term: ${contract.start_date || 'Not set'} to ${contract.end_date || 'Open-ended'}\n` +
      `Auto-renew: ${contract.auto_renew ? `Yes (${contract.renewal_notice_days}-day notice)` : 'No'}\n` +
      `Billing: ${contract.billing_frequency.replace(/_/g, ' ')} · ${
        contract.contract_value_cents != null ? currency(contract.contract_value_cents / 100) : 'Not on file'
      }`,
    y
  );

  y += 10;
  y = drawSectionLabel(doc, 'SLA commitments', y);
  y = drawParagraph(
    doc,
    `Response time (standard): ${
      contract.sla_response_minutes_standard != null ? `${contract.sla_response_minutes_standard} min` : 'Not set'
    }\n` +
      `Response time (critical): ${
        contract.sla_response_minutes_critical != null ? `${contract.sla_response_minutes_critical} min` : 'Not set'
      }\n` +
      `Resolution time: ${contract.sla_resolution_hours != null ? `${contract.sla_resolution_hours} hr` : 'Not set'}\n` +
      `Penalty: ${contract.penalty_percentage ?? 0}% of contract value per breach, capped at ${
        contract.penalty_cap_percentage ?? 100
      }%`,
    y
  );

  y += 10;
  y = drawSectionLabel(doc, 'Signature', y);
  y = drawParagraph(
    doc,
    `${contract.signed_by || 'Not yet signed'}${contract.signed_at ? ` · ${contract.signed_at}` : ''}\n` +
      `${contract.document_url || 'No document on file'}`,
    y
  );

  if (breaches.length > 0) {
    y += 10;
    const totalPenaltyCents = breaches.reduce((sum, b) => sum + (b.penalty_amount_cents ?? 0), 0);
    y = drawSectionLabel(doc, 'SLA breach log', y);
    y = drawParagraph(
      doc,
      `${breaches.length} breach${breaches.length === 1 ? '' : 'es'} logged · ${currency(totalPenaltyCents / 100)} total credit owed`,
      y,
      { color: DANGER }
    );
  }

  if (contract.notes) {
    y += 10;
    y = drawSectionLabel(doc, 'Notes', y);
    drawParagraph(doc, contract.notes, y, { color: MUTED });
  }

  drawFooter(doc, `Contract status: ${contract.status.replace(/_/g, ' ')}. Generated for internal reference.`);
  doc.save(`contract-${contract.contract_name.trim().replace(/\s+/g, '-').toLowerCase() || 'summary'}.pdf`);
}
