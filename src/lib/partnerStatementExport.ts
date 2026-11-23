// Browser-only downloads for a partner statement (CSV + PDF). The pure builders live in partnerStatement.ts /
// partnerStatementPdf.ts; this file only touches the DOM. Both refuse to export a statement that does not add up.
import { downloadBlob, UTF8_BOM } from '@/lib/documents/exportFile';
import { getPdfBrand } from '@/lib/pdfBrand';
import {
  buildStatementCsv,
  statementFilename,
  verifyStatement,
  type PartnerStatement,
  type StatementAudience,
} from '@/lib/partnerStatement';
import { renderPartnerStatement } from '@/lib/partnerStatementPdf';

export class StatementIntegrityError extends Error {
  constructor(readonly problems: string[]) {
    super(`Statement does not add up: ${problems.join('; ')}`);
  }
}

function assertConsistent(s: PartnerStatement): void {
  const check = verifyStatement(s);
  if (!check.ok) throw new StatementIntegrityError(check.problems);
}

export function downloadStatementCsv(s: PartnerStatement, audience: StatementAudience = 'finance'): void {
  assertConsistent(s);
  const csv = buildStatementCsv(s, audience);
  // buildCsv already prefixes the BOM; Blob keeps it as-is
  downloadBlob(new Blob([csv.startsWith(UTF8_BOM) ? csv : UTF8_BOM + csv], { type: 'text/csv;charset=utf-8' }), statementFilename(s, 'csv', audience));
}

export async function downloadStatementPdf(s: PartnerStatement, audience: StatementAudience = 'partner'): Promise<void> {
  assertConsistent(s);
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  renderPartnerStatement(doc as unknown as Parameters<typeof renderPartnerStatement>[0], s, getPdfBrand(), { audience });
  doc.save(statementFilename(s, 'pdf', audience));
}
