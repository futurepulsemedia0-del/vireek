/**
 * Repo-relative files proving each marquee brand is really integrated.
 * Test-only: kept out of the client bundle on purpose (it would expose
 * internal function names). Verified by IntegrationsMarquee.test.tsx.
 */
export const INTEGRATION_EVIDENCE: Readonly<Record<string, readonly string[]>> = {
  servicetitan: [
    'supabase/functions/price-book-connect-servicetitan/index.ts',
    'supabase/functions/_shared/price-book/servicetitan-jobs.ts',
  ],
  jobber: [
    'supabase/functions/jobber-oauth-start/index.ts',
    'supabase/functions/_shared/price-book/jobber-jobs.ts',
  ],
  'housecall-pro': [
    'supabase/functions/price-book-connect-housecallpro/index.ts',
    'supabase/functions/_shared/price-book/housecallpro.ts',
  ],
  hubspot: [
    'supabase/functions/hubspot-oauth-start/index.ts',
    'supabase/functions/hubspot-oauth-callback/index.ts',
  ],
  salesforce: [
    'supabase/functions/crm-oauth-start/index.ts',
    'supabase/functions/_shared/crm/engine.ts',
  ],
  quickbooks: [
    'supabase/functions/qbo-oauth-start/index.ts',
    'supabase/functions/qbo-sync-run/index.ts',
  ],
  'google-calendar': [
    'supabase/functions/google-calendar-oauth-start/index.ts',
    'supabase/functions/google-calendar-oauth-callback/index.ts',
  ],
  'microsoft-365': [
    'supabase/functions/microsoft-calendar-oauth-start/index.ts',
    'supabase/functions/microsoft-calendar-sync/index.ts',
  ],
  slack: [
    'supabase/functions/chat-slack-oauth-start/index.ts',
    'supabase/functions/chat-slack-webhook/index.ts',
  ],
  'microsoft-teams': [
    'supabase/functions/chat-teams-oauth-start/index.ts',
    'supabase/functions/chat-teams-bot/index.ts',
  ],
  stripe: [
    'supabase/functions/stripe-connect-onboarding/index.ts',
    'supabase/functions/stripe-webhook/index.ts',
  ],
};
