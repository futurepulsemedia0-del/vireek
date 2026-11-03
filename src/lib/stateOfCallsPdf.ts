import type { EditionDocument } from '@/lib/stateOfCalls';
import { formatValue } from '@/lib/stateOfCalls';

/** PDF edition, built in the browser from the published document (same approach as commercialPacketPdf.ts). */
export async function buildReportPdf(doc: EditionDocument): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'letter' });
  const W = 612, M = 54, maxW = W - M * 2;
  let y = M;
  const ensure = (h: number) => { if (y + h > 740) { pdf.addPage(); y = M; footer(); } };
  const footer = () => {
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(90);
    pdf.text(`${doc.title} · v${doc.method_version} · data as of ${doc.as_of.slice(0, 10)} · integrity ${doc.cells_hash.slice(0, 12)} · vireek.com/state-of-home-service-calls`, M, 770);
    pdf.setTextColor(0);
  };
  const para = (text: string, size = 10.5, bold = false) => {
    pdf.setFont('helvetica', bold ? 'bold' : 'normal'); pdf.setFontSize(size);
    for (const line of pdf.splitTextToSize(text, maxW) as string[]) { ensure(size + 4); pdf.text(line, M, y); y += size + 4; }
    y += 4;
  };
  footer();
  para(doc.title, 20, true);
  if (doc.synthetic && doc.notice) { pdf.setTextColor(200, 30, 30); para(doc.notice, 10, true); pdf.setTextColor(0); }
  para(`Period ${doc.period_start} to ${doc.period_end}. Every figure meets: at least ${doc.thresholds.k_min} contributing businesses, no business above ${Math.round(doc.thresholds.dominance_max_share * 100)}% of a figure's events, at least ${doc.thresholds.min_events} events.`, 9.5);
  for (const s of doc.narrative.sections) { para(s.title, 14, true); for (const st of s.statements) para(st.text); }
  if (doc.mode === 'report') {
    para('Headline figures', 14, true);
    for (const c of doc.cells.filter((x) => x.dim === 'national' && !x.suppressed)) {
      const m = doc.metrics.find((k) => k.key === c.metric_key);
      para(`${m?.label ?? c.metric_key}: ${formatValue(c)} (about ${c.n_orgs} businesses, ${c.n_events} ${m?.event_label ?? 'events'})`, 10);
    }
  }
  para('Methodology', 14, true);
  for (const m of doc.metrics) para(`${m.label}: ${m.definition}`, 9.5);
  para('Exclusions', 14, true); for (const x of doc.exclusions) para(`• ${x}`, 9.5);
  para('Limitations', 14, true); for (const x of doc.limitations) para(`• ${x}`, 9.5);
  return pdf.output('blob');
}
