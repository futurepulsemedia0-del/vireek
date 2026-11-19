// Guards the decision to retire the HubSpot stub: no consumer, no claims, no leftover OAuth surface.
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('HubSpot is retired', () => {
  it('OAuth edge functions are deleted', () => {
    expect(existsSync(join(root, 'supabase/functions/hubspot-oauth-start'))).toBe(false);
    expect(existsSync(join(root, 'supabase/functions/hubspot-oauth-callback'))).toBe(false);
  });
  it('no listing / UI text promises a HubSpot sync', () => {
    for (const f of [
      'src/lib/integrations.ts', 'src/pages/IntegrationsPage.tsx', 'src/components/sections/Integrations.tsx',
      'src/components/sections/AutomationEngines.tsx', 'src/components/sections/FAQCallout.tsx',
      'src/components/sections/LiveActivityStream.tsx', 'src/components/sections/IntegrationsMarquee.tsx',
      'src/components/home/TrustBar.tsx', 'src/lib/homeContent.ts', 'public/sitemap.xml',
    ]) {
      expect(read(f), f).not.toMatch(/hubspot/i);
    }
  });
  it('no code path starts the OAuth flow or references its secrets', () => {
    expect(read('src/pages/IntegrationsPage.tsx')).not.toContain('hubspot-oauth-start');
    expect(read('supabase/config.toml')).not.toMatch(/hubspot/i);
  });
});
