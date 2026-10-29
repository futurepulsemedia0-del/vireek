// supabase/functions/_shared/accounting/registry.ts
// Maps a provider id to its adapter + auth. Edge functions only; the React client imports core.ts.
import type { AcctProvider, Provider } from './core.ts';
import { xeroProvider } from './xero.ts';
import { zohoProvider } from './zoho.ts';
import { netsuiteProvider } from './netsuite.ts';

export const PROVIDERS: Record<AcctProvider, Provider> = { xero: xeroProvider, zoho_books: zohoProvider, netsuite: netsuiteProvider };
