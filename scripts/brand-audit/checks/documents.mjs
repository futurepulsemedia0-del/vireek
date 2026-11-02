// checks/documents.mjs — email + PDF branding. Heuristic: do generators go through the shared brand layer?
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, walk, finding, pct, round1 } from '../lib/util.mjs';

export const isPdfModule = (src) => /from ['"]jspdf['"]|import\(['"]jspdf['"]\)/.test(src);
export const usesPdfBrand = (src) => /from ['"](?:@\/lib\/pdf|@\/lib\/pdfBrand|\.\/pdf|\.\/pdfBrand|\.\.\/pdf)['"]/.test(src);

export async function run() {
  const findings = [];
  const pdfs = []; const unbranded = [];
  for (const f of walk('src', { exts: ['.ts', '.tsx'], skipTests: true })) {
    if (f.startsWith('src/pages/dev/')) continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    if (!isPdfModule(src)) continue;
    pdfs.push(f);
    if (!usesPdfBrand(src) && f !== 'src/lib/pdfBrand.ts') unbranded.push(f);
  }
  // Emails: functions that send mail directly (bypassing the email-send hub that applies tenant brand/footer)
  const fnDir = join(ROOT, 'supabase/functions');
  const senders = []; const direct = [];
  if (existsSync(fnDir)) for (const d of readdirSync(fnDir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_') || d.name === 'email-send') continue;
    const p = join(fnDir, d.name, 'index.ts');
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    const viaHub = /email-send|_shared\/email|sendEmail\(/.test(src);
    const viaProvider = /api\.resend\.com|api\.sendgrid\.com|api\.postmarkapp\.com/.test(src);
    if (viaHub || viaProvider) { senders.push(d.name); if (viaProvider && !viaHub) direct.push(d.name); }
  }
  const pdfBranded = pdfs.length - unbranded.length;
  const components = [
    { name: 'PDF generators using the shared PDF brand layer', weight: 55, score: round1(pct(pdfBranded, pdfs.length)), detail: `${pdfBranded}/${pdfs.length} (heuristic: imports @/lib/pdf or @/lib/pdfBrand)` },
    { name: 'Email-sending functions routed through the email-send hub', weight: 45, score: round1(pct(senders.length - direct.length, senders.length)), detail: `${senders.length - direct.length}/${senders.length} (direct provider calls bypass tenant brand/footer)` },
  ];
  if (unbranded.length) findings.push(finding({ id: 'documents/pdf-unbranded', category: 'documents', severity: 'medium', title: `${unbranded.length} PDF generator(s) do not use the shared brand layer (heuristic)`, detail: 'Use getPdfBrand()/VIREEK_PDF_BRAND from @/lib/pdfBrand so logo, colors and white-label settings apply. Confirm each before changing — some may brand through another path.', refs: unbranded.map((file) => ({ file })), count: unbranded.length }));
  if (direct.length) findings.push(finding({ id: 'documents/email-direct', category: 'documents', severity: 'medium', title: `${direct.length} function(s) call the email provider directly`, detail: 'Route through supabase/functions/email-send so brand, footer and white-label rules apply (some are intentionally operational — confirm).', refs: direct.map((n) => ({ file: `supabase/functions/${n}/index.ts` })), count: direct.length }));
  return { category: 'documents', components, metrics: { pdfModules: pdfs.length, pdfBranded, emailSenders: senders.length, emailDirect: direct.length }, findings };
}
