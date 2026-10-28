import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const body = (s: string) =>
  stripComments(s)
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n');

const PORTAL_PAGES = [
  'src/pages/CustomerPortalPage.tsx',
  'src/pages/CustomerPortalHistoryPage.tsx',
  'src/pages/CustomerPortalInventoryPage.tsx',
];

const portalComponents = readdirSync(join(root, 'src/components/portal'))
  .filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx') && f !== 'PortalBrandShell.tsx')
  .map((f) => `src/components/portal/${f}`);

describe('customer portal never ships Vireek chrome', () => {
  it.each(PORTAL_PAGES)('%s uses the branded shell, not the marketing Header/Footer', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/from '@\/components\/(Header|Footer)'/);
    expect(src).toContain('PortalBrandShell');
    expect(body(src)).not.toMatch(/vireek/i);
  });

  it.each(portalComponents)('%s has no hard-coded vendor string', (file) => {
    expect(body(read(file))).not.toMatch(/vireek/i);
  });
});

describe('tenant-facing PDFs take their name from the brand, never a literal', () => {
  const PDFS = [
    'invoicePdf',
    'jobEvidenceChainPdf',
    'leakReportPdf',
    'passportLabelPdf',
    'installCloseoutPdf',
    'repairReplaceProposalPdf',
  ];
  it.each(PDFS)('src/lib/%s.ts', (name) => {
    expect(body(read(`src/lib/${name}.ts`))).not.toMatch(/vireek/i);
  });
});
