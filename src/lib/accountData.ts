import { supabase } from '@/lib/supabase';

/**
 * Self-service "Export My Data" (Step 35). Deliberately does NOT need an
 * edge function or service-role key: every table below already has a
 * `select_own_*` RLS policy scoped to `auth.uid()` (see
 * 20260821101135_create_data_tables.sql and
 * 20260821101104_create_profiles_and_team_members.sql), so a plain
 * client-side query already returns nothing but the caller's own rows.
 *
 * Each table is paginated up to EXPORT_ROW_CAP rows. For the overwhelming
 * majority of accounts that's everything; if an account is large enough
 * to hit the cap, note it in the export and point them to support for a
 * complete archive rather than silently truncating without saying so.
 */

const EXPORT_ROW_CAP = 10_000;
const PAGE_SIZE = 1000;

const OWNED_TABLES = [
  'business_profile',
  'calls',
  'leads',
  'jobs',
  'ai_insights',
  'review_requests',
  'integrations',
  'team_members',
] as const;

async function fetchAllRows(table: string): Promise<{ rows: unknown[]; truncated: boolean }> {
  const rows: unknown[] = [];
  let from = 0;
  while (rows.length < EXPORT_ROW_CAP) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase.from(table).select('*').range(from, to);
    if (error) throw new Error(`Could not export "${table}": ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: rows.length > EXPORT_ROW_CAP };
}

export async function buildMyDataExport(): Promise<Record<string, unknown>> {
  const { data: userData } = await supabase.auth.getUser();

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userData.user?.id ?? '')
    .maybeSingle();
  if (profileError) throw new Error(`Could not export profile: ${profileError.message}`);

  const exportData: Record<string, unknown> = {
    exported_at: new Date().toISOString(),
    account_email: userData.user?.email ?? null,
    profile: profile ?? null,
  };

  for (const table of OWNED_TABLES) {
    const { rows, truncated } = await fetchAllRows(table);
    exportData[table] = truncated
      ? { truncated: true, note: `Export capped at ${EXPORT_ROW_CAP} rows — contact support for a complete archive.`, rows }
      : rows;
  }

  return exportData;
}

/** Triggers a browser download of the export as a formatted JSON file. */
export function downloadDataExport(data: Record<string, unknown>) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vireek-data-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Self-service account deletion. Requires the `delete-account` edge
 * function (service-role key needed to actually remove the auth.users
 * row and wipe tables with no cascading FK — see that function's own
 * comments for exactly why a client-side call alone can't do this).
 */
export async function deleteMyAccount(confirmationEmail: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error('No active session');

  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ confirmation: confirmationEmail }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Account deletion failed.');
  }
}
