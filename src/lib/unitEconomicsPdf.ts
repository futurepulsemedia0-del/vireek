import { jsPDF } from 'jspdf';
import { buildReportBlocks, renderReportPdf } from '@/lib/unitEconomicsPdfLayout';
import type { ReportModel } from '@/lib/unitEconomicsReportHtml';

export function buildUnitEconomicsPdf(model: ReportModel): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  return renderReportPdf(doc, buildReportBlocks(model), { footer: 'Vireek · Internal · Estimates are not invoices' });
}
