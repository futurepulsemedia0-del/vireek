/**
 * Supplier PunchOut — network layer. Pure logic lives in punchout.ts.
 * Reads rely on RLS (managers of the account); every write goes through the `punchout-session` edge
 * function or a SECURITY DEFINER RPC (see 20280101000000_supplier_punchout.sql).
 */
import { supabase } from '@/lib/supabase';
import type { ConnectionForm, PunchoutConnection, PunchoutLine, PunchoutSession } from '@/lib/punchout';

function fail(error: { message?: string } | null, fallback: string): never {
  const msg = error?.message && error.message.length < 200 ? error.message : fallback;
  throw new Error(msg);
}

async function invoke<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke('punchout-session', { body });
  if (error) {
    // supabase-js hides the JSON body of non-2xx replies in error.context.
    let message = fallback;
    try {
      const ctx = (error as { context?: Response }).context;
      const parsed = ctx ? ((await ctx.json()) as { error?: string }) : null;
      if (parsed?.error && parsed.error.length < 300) message = parsed.error;
    } catch {
      /* keep fallback */
    }
    throw new Error(message);
  }
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    throw new Error((data as { error: string }).error);
  }
  return data as T;
}

const CONNECTION_COLS =
  'id, vendor_id, environment, setup_url, buyer_domain, buyer_identity, sender_domain, sender_identity, supplier_domain, supplier_identity, currency, enabled, secret_set, last_tested_at, last_test_ok, last_test_message';

export async function listConnections(): Promise<PunchoutConnection[]> {
  const { data, error } = await supabase.from('supplier_punchout_connections').select(CONNECTION_COLS).order('created_at');
  if (error) fail(error, 'Could not load PunchOut connections.');
  return (data ?? []) as PunchoutConnection[];
}

export async function saveConnection(form: ConnectionForm): Promise<PunchoutConnection> {
  const res = await invoke<{ connection: PunchoutConnection }>(
    { action: 'save_connection', ...form, shared_secret: form.shared_secret.trim() || undefined },
    'Could not save the connection.',
  );
  return res.connection;
}

export async function testConnection(connectionId: string): Promise<{ ok: boolean; message: string }> {
  return invoke({ action: 'test_connection', connection_id: connectionId }, 'The connection test failed.');
}

export async function startSession(args: { connectionId: string; jobId?: string | null; destinationLocationId?: string | null }): Promise<{ session_id: string; start_url: string }> {
  return invoke(
    { action: 'start', connection_id: args.connectionId, job_id: args.jobId ?? null, destination_location_id: args.destinationLocationId ?? null },
    'Could not open the supplier store.',
  );
}

const SESSION_COLS =
  'id, connection_id, vendor_id, job_id, destination_location_id, status, currency, supplier_total_cents, line_count, purchase_order_id, error_message, expires_at, returned_at, created_at';

export async function listSessions(limit = 25): Promise<PunchoutSession[]> {
  const { data, error } = await supabase.from('supplier_punchout_sessions').select(SESSION_COLS).order('created_at', { ascending: false }).limit(limit);
  if (error) fail(error, 'Could not load PunchOut carts.');
  return (data ?? []) as PunchoutSession[];
}

export async function getSession(id: string): Promise<PunchoutSession | null> {
  const { data, error } = await supabase.from('supplier_punchout_sessions').select(SESSION_COLS).eq('id', id).maybeSingle();
  if (error) fail(error, 'Could not load this cart.');
  return (data as PunchoutSession | null) ?? null;
}

export async function listSessionLines(sessionId: string): Promise<PunchoutLine[]> {
  const { data, error } = await supabase
    .from('supplier_punchout_line_review')
    .select('id, session_id, line_no, sku, name, mpn, manufacturer, uom, quantity, unit_price_cents, lead_time_days, catalog_item_id, catalog_cost_cents')
    .eq('session_id', sessionId)
    .order('line_no');
  if (error) fail(error, 'Could not load the cart lines.');
  return (data ?? []) as PunchoutLine[];
}

export interface CreatedOrder {
  po_id: string;
  po_number: string;
  status: 'draft' | 'pending_approval';
  total_cents: number;
  line_count: number;
  expected_at: string;
  job: { hold: string; reason?: string | null };
}

export async function createOrder(args: { sessionId: string; holdJob: boolean; notes?: string }): Promise<CreatedOrder> {
  const { data, error } = await supabase.rpc('punchout_create_order', {
    p_session: args.sessionId,
    p_hold_job: args.holdJob,
    p_notes: args.notes?.trim() || null,
  });
  if (error) fail(error, 'Could not create the order.');
  return data as CreatedOrder;
}

export async function cancelSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('punchout_cancel_session', { p_session: sessionId });
  if (error) fail(error, 'Could not cancel this cart.');
}
