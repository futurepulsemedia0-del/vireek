import { supabase } from '@/lib/supabase';
import { isGoogleAuthUrl, parseGbpConnection, type GbpConnection } from '@/lib/gbpConnectCore';

export * from '@/lib/gbpConnectCore';

async function errorCode(error: unknown): Promise<string> {
  try {
    const body = await (error as { context?: Response }).context?.json();
    if (body?.code) return String(body.code);
  } catch { /* fall through */ }
  return 'unknown';
}

export async function loadGbpConnection(): Promise<GbpConnection> {
  const { data, error } = await supabase.rpc('gbp_connection_state');
  const parsed = error ? null : parseGbpConnection(data);
  if (!parsed) throw new Error(error?.message ?? 'gbp_state_unavailable');
  return parsed;
}

export async function startGbpConnect(): Promise<{ ok: true; url: string } | { ok: false; code: string }> {
  const { data, error } = await supabase.functions.invoke('gbp-oauth-start', { body: {} });
  if (error) return { ok: false, code: await errorCode(error) };
  const d = data as { ok?: boolean; url?: unknown; code?: string };
  return d?.ok && isGoogleAuthUrl(d.url) ? { ok: true, url: d.url } : { ok: false, code: d?.code ?? 'unknown' };
}

export async function selectGbpLocation(location: string): Promise<{ ok: true } | { ok: false; code: string }> {
  const { error } = await supabase.rpc('gbp_select_location', { p_location: location });
  if (!error) return { ok: true };
  return { ok: false, code: error.message.includes('forbidden') ? 'forbidden' : error.message.includes('not_found') ? 'not_found' : 'unknown' };
}
