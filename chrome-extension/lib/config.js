// Fill these three values once (same values as VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in your
// .env and your VITE_APP_URL / SITE_URL). The anon key is public by design; never put a
// service-role key here.
export const CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-SUPABASE-ANON-KEY',
  APP_URL: 'https://YOUR-APP-DOMAIN',
};

export const isConfigured = (c = CONFIG) =>
  /^https:\/\/[a-z0-9.-]+$/i.test(c.SUPABASE_URL) &&
  !c.SUPABASE_URL.includes('YOUR-') &&
  c.SUPABASE_ANON_KEY.length > 40 &&
  !c.SUPABASE_ANON_KEY.includes('YOUR-');
