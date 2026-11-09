// @vitest-environment node
// Regression guard: the endorsement is platform-owned. Only the files listed below may reference it,
// so tenant documents (quotes, invoices, receipts, work orders, portals, postcards, tenant emails)
// can never pick it up by accident. Adding a new surface means adding it here on purpose.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = new Set([
  'src/lib/brand/endorsement.ts',
  'src/lib/brand/platformEndorsement.ts',
  'src/components/brand/PlatformEndorsement.tsx',
  'src/components/Footer.tsx',
  'src/pages/LoginPage.tsx',
  'src/pages/CompanyPage.tsx',
  'src/pages/SitemapPage.tsx',
  'supabase/functions/_shared/email-kit/endorsement.ts',
  'supabase/functions/_shared/email-kit/layout.ts',
]);
const PATTERN = /brand\/endorsement|brand\/platformEndorsement|PlatformEndorsement|EndorsementStructuredData|platformEndorsementLine|endorsementLine|getEndorsement/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}

describe('endorsement scope', () => {
  const files = [...walk('src'), ...walk('supabase/functions')];
  const referencing = files.filter((f) => PATTERN.test(readFileSync(f, 'utf8')));

  it('is referenced only by the allowlisted platform surfaces', () => {
    expect(referencing.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });

  it('is never referenced by tenant documents, portals or tenant email branding', () => {
    const tenantish = /(portal|invoice|quote|receipt|workorder|work-order|postcard|direct-mail|proposal|branding\/brand|whitelabel|win-cards|customerPortal)/i;
    expect(referencing.filter((f) => tenantish.test(f))).toEqual([]);
  });
});
